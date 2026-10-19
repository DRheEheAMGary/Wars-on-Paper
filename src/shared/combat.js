// @ts-check
/**
 * Decisive battle resolution: the arriving army fights until one side is
 * eliminated. A failed attack never retreats — the attacker is destroyed.
 */

import { levelConfig } from './economy.js';

/**
 * @typedef {Object} BattleResult
 * @property {number} attackerLoss
 * @property {number} defenderLoss
 * @property {number} attackerRemaining
 * @property {number} defenderRemaining
 * @property {boolean} captured
 */

/**
 * @param {number} attackerSoldiers
 * @param {any} city
 * @param {any} balance
 * @param {() => number} random
 * @param {number} [attackerMultiplier]
 * @returns {BattleResult}
 */
export function resolveBattle(attackerSoldiers, city, balance, random, attackerMultiplier = 1) {
  const terrain = balance.terrain[city.terrain] ?? balance.terrain.plains;
  const wall = 1 + levelConfig(balance, city.level).wall;
  const attackStrength = balance.soldierAttack * terrain.attack * attackerMultiplier;
  const defenseStrength = balance.soldierDefense * terrain.defense * wall;

  const startAttack = attackerSoldiers;
  const startDefense = city.garrison;
  if (startDefense <= 0) {
    return {
      attackerLoss: 0,
      defenderLoss: 0,
      attackerRemaining: startAttack,
      defenderRemaining: 0,
      captured: true,
    };
  }

  let attacker = startAttack;
  let defender = startDefense;
  let rounds = 0;
  const factor = balance.combat.casualtyFactor;

  while (
    attacker > 0 &&
    defender > 0 &&
    rounds < balance.combat.maxRounds
  ) {
    rounds += 1;
    const noiseA = 1 + (random() * 2 - 1) * balance.combat.randomness;
    const noiseD = 1 + (random() * 2 - 1) * balance.combat.randomness;
    const attackPower = attacker * attackStrength * noiseA;
    const defensePower = defender * defenseStrength * noiseD;
    const share = attackPower / (attackPower + defensePower);
    const lossA = Math.min(
      attacker,
      Math.max(1, Math.round(attacker * (1 - share) * factor)),
    );
    const lossD = Math.min(
      defender,
      Math.max(1, Math.round(defender * share * factor)),
    );
    attacker -= lossA;
    defender -= lossD;
  }

  if (attacker <= 0 && defender > 0) {
    attacker = 0;
  }
  const captured = defender <= 0;

  return {
    attackerLoss: startAttack - Math.max(0, attacker),
    defenderLoss: startDefense - Math.max(0, defender),
    attackerRemaining: captured ? Math.max(0, attacker) : 0,
    defenderRemaining: captured ? 0 : Math.max(0, defender),
    captured,
  };
}

/**
 * Deterministic strength estimate for the UI (no randomness).
 * @param {number} attackerSoldiers
 * @param {any} city
 * @param {any} balance
 * @param {number} [attackerMultiplier]
 * @returns {{ attack: number, defense: number, odds: number }}
 */
export function estimateBattle(attackerSoldiers, city, balance, attackerMultiplier = 1) {
  const terrain = balance.terrain[city.terrain] ?? balance.terrain.plains;
  const wall = 1 + levelConfig(balance, city.level).wall;
  const attack =
    attackerSoldiers * balance.soldierAttack * terrain.attack * attackerMultiplier;
  const defense = city.garrison * balance.soldierDefense * terrain.defense * wall;
  return { attack, defense, odds: attack / Math.max(1, attack + defense) };
}
