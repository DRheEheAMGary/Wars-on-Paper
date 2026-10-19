// @ts-check
/**
 * Decisive battle resolution with three unit types and counter bonuses.
 * A failed attack never retreats — the attacker is destroyed.
 */

import { levelConfig } from './economy.js';
import { normalizeUnits, totalUnits } from './units.js';

/**
 * @typedef {Object} BattleResult
 * @property {number} attackerLoss
 * @property {number} defenderLoss
 * @property {any} attackerRemaining
 * @property {any} defenderRemaining
 * @property {boolean} captured
 */

/**
 * @param {any} units
 * @param {any} defenderUnits
 * @param {any} balance
 * @param {number} wall
 * @param {any} siegeBonus
 * @returns {number}
 */
function attackPower(units, defenderUnits, balance, wall, siegeBonus) {
  const total = totalUnits(units);
  if (total === 0) return 0;
  const defenderTotal = Math.max(1, totalUnits(defenderUnits));
  let power = 0;
  for (const type of /** @type {string[]} */ (balance.unitOrder ?? [])) {
    const count = units[type] ?? 0;
    if (count <= 0) continue;
    const config = balance.units[type];
    let multiplier = 1;
    if (type === 'infantry') {
      multiplier +=
        (config.counters?.siege ?? 0) * ((defenderUnits?.siege ?? 0) / defenderTotal);
    } else if (type === 'cavalry') {
      multiplier +=
        (config.counters?.infantry ?? 0) *
        ((defenderUnits?.infantry ?? 0) / defenderTotal);
    } else if (type === 'siege') {
      multiplier += (config.counters?.wall ?? 0) * Math.max(0, wall - 1) + siegeBonus;
    }
    power += count * config.attack * multiplier;
  }
  return power;
}

/**
 * @param {any} units
 * @param {any} balance
 * @param {number} wall
 * @returns {number}
 */
function defensePower(units, balance, wall) {
  let power = 0;
  for (const type of balance.unitOrder ?? []) {
    const count = units?.[type] ?? 0;
    if (count <= 0) continue;
    power += count * (balance.units[type]?.defense ?? 0);
  }
  return power * wall;
}

/**
 * Decrement units proportionally by a total casualty amount.
 * @param {any} units
 * @param {number} amount
 * @returns {any}
 */
function applyLosses(units, amount) {
  const total = totalUnits(units);
  const loss = Math.max(0, Math.min(total, Math.round(amount)));
  if (loss === 0) return units;
  /** @type {any} */
  const next = {};
  let allocated = 0;
  const order = [];
  for (const type of ['infantry', 'cavalry', 'siege']) {
    const raw = (units[type] ?? 0) * (loss / Math.max(1, total));
    const base = Math.min(units[type] ?? 0, Math.floor(raw));
    next[type] = (units[type] ?? 0) - base;
    allocated += base;
    order.push({ type, frac: raw - base });
  }
  let extra = loss - allocated;
  order.sort((a, b) => b.frac - a.frac);
  for (const entry of order) {
    if (extra <= 0) break;
    if (next[entry.type] > 0) {
      next[entry.type] -= 1;
      extra -= 1;
    }
  }
  return normalizeUnits(next);
}

/**
 * @param {any} attackerUnits
 * @param {any} city
 * @param {any} balance
 * @param {() => number} random
 * @param {{ attackerAttack?: number, defenderDefense?: number, siegeBonus?: number, stance?: { attack?: number, casualty?: number } }} [options]
 * @returns {BattleResult}
 */
export function resolveBattle(attackerUnits, city, balance, random, options = {}) {
  const terrain = balance.terrain[city.terrain] ?? balance.terrain.plains;
  const wall = 1 + levelConfig(balance, city.level).wall;
  const stance = options.stance ?? null;
  const attackMultiplier = 1 + (options.attackerAttack ?? 0) + (stance?.attack ?? 0);
  const defenseMultiplier = 1 + (options.defenderDefense ?? 0);
  const attackerCasualtyMultiplier = 1 + (stance?.casualty ?? 0);
  const siegeBonus = (options.siegeBonus ?? 0) * Math.max(0, wall - 1);

  let attacker = normalizeUnits(attackerUnits);
  let defender = normalizeUnits(city.units ?? { infantry: city.garrison ?? 0 });
  const startAttack = totalUnits(attacker);
  const startDefense = totalUnits(defender);
  if (startDefense <= 0) {
    return {
      attackerLoss: 0,
      defenderLoss: 0,
      attackerRemaining: attacker,
      defenderRemaining: normalizeUnits({}),
      captured: true,
    };
  }
  if (startAttack <= 0) {
    return {
      attackerLoss: 0,
      defenderLoss: 0,
      attackerRemaining: normalizeUnits({}),
      defenderRemaining: defender,
      captured: false,
    };
  }

  let rounds = 0;
  const factor = balance.combat.casualtyFactor;
  while (
    totalUnits(attacker) > 0 &&
    totalUnits(defender) > 0 &&
    rounds < balance.combat.maxRounds
  ) {
    rounds += 1;
    const noiseA = 1 + (random() * 2 - 1) * balance.combat.randomness;
    const noiseD = 1 + (random() * 2 - 1) * balance.combat.randomness;
    const attack = attackPower(attacker, defender, balance, wall, siegeBonus);
    const defense = defensePower(defender, balance, wall);
    const share =
      (attack * terrain.attack * attackMultiplier * noiseA) /
      Math.max(
        1,
        attack * terrain.attack * attackMultiplier * noiseA +
          defense * terrain.defense * defenseMultiplier * noiseD,
      );
    const attackerTotal = totalUnits(attacker);
    const defenderTotal = totalUnits(defender);
    attacker = applyLosses(
      attacker,
      Math.min(
        attackerTotal,
        Math.round(
          attackerTotal *
            (1 - share) *
            factor *
            Math.max(0.1, attackerCasualtyMultiplier),
        ),
      ),
    );
    defender = applyLosses(
      defender,
      Math.min(defenderTotal, Math.round(defenderTotal * share * factor)),
    );
  }

  // If the round cap is reached without elimination, the side with more
  // effective power wins instead of discarding surviving units.
  if (totalUnits(attacker) > 0 && totalUnits(defender) > 0) {
    const attack = attackPower(attacker, defender, balance, wall, siegeBonus);
    const defense = defensePower(defender, balance, wall);
    if (
      attack * terrain.attack * attackMultiplier >=
      defense * terrain.defense * defenseMultiplier
    ) {
      defender = normalizeUnits({});
    } else {
      attacker = normalizeUnits({});
    }
  }

  const captured = totalUnits(defender) <= 0;
  return {
    attackerLoss: startAttack - totalUnits(attacker),
    defenderLoss: startDefense - totalUnits(defender),
    attackerRemaining: captured ? attacker : normalizeUnits({}),
    defenderRemaining: captured ? normalizeUnits({}) : defender,
    captured,
  };
}

/**
 * Deterministic strength estimate for the UI (no randomness).
 * @param {any} attackerUnits
 * @param {any} city
 * @param {any} balance
 * @param {{ attackerAttack?: number, defenderDefense?: number, siegeBonus?: number, stance?: { attack?: number, casualty?: number } }} [options]
 * @returns {{ attack: number, defense: number, odds: number }}
 */
export function estimateBattle(attackerUnits, city, balance, options = {}) {
  const terrain = balance.terrain[city.terrain] ?? balance.terrain.plains;
  const wall = 1 + levelConfig(balance, city.level).wall;
  const specialDefense = balance.specialSites?.[city.special]?.defense ?? 0;
  const attack =
    attackPower(
      normalizeUnits(attackerUnits),
      normalizeUnits(city.units ?? { infantry: city.garrison ?? 0 }),
      balance,
      wall,
      (options.siegeBonus ?? 0) * Math.max(0, wall - 1),
    ) *
    terrain.attack *
    (1 + (options.attackerAttack ?? 0) + (options.stance?.attack ?? 0));
  const defense =
    defensePower(
      normalizeUnits(city.units ?? { infantry: city.garrison ?? 0 }),
      balance,
      wall,
    ) *
    terrain.defense *
    (1 + (options.defenderDefense ?? 0) + specialDefense);
  return { attack, defense, odds: attack / Math.max(1, attack + defense) };
}
