// @ts-check
/**
 * Battle resolution for the single-player core loop.
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
 * One-off battle: attacker arrives at a city and fights the garrison.
 * @param {number} attackerSoldiers
 * @param {any} city
 * @param {any} balance
 * @param {() => number} random
 * @returns {BattleResult}
 */
export function resolveBattle(attackerSoldiers, city, balance, random) {
  const terrain = balance.terrain[city.terrain] ?? balance.terrain.plains;
  const config = levelConfig(balance, city.level);
  const wall = 1 + config.wall;
  const noiseA = 1 + (random() * 2 - 1) * balance.combat.randomness;
  const noiseD = 1 + (random() * 2 - 1) * balance.combat.randomness;

  const attackPower = attackerSoldiers * balance.soldierAttack * terrain.attack * noiseA;
  const defendPower =
    city.garrison * balance.soldierDefense * terrain.defense * wall * noiseD;

  if (city.garrison <= 0) {
    return {
      attackerLoss: 0,
      defenderLoss: 0,
      attackerRemaining: attackerSoldiers,
      defenderRemaining: 0,
      captured: true,
    };
  }

  const share = attackPower / (attackPower + defendPower);
  const factor = balance.combat.casualtyFactor;
  const attackerLoss = Math.min(
    attackerSoldiers,
    Math.round(attackerSoldiers * (1 - share) * factor),
  );
  const defenderLoss = Math.min(
    city.garrison,
    Math.round(city.garrison * share * factor),
  );

  return {
    attackerLoss,
    defenderLoss,
    attackerRemaining: attackerSoldiers - attackerLoss,
    defenderRemaining: city.garrison - defenderLoss,
    captured: city.garrison - defenderLoss <= 0,
  };
}
