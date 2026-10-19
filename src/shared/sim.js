// @ts-check
/**
 * The single-player simulation: one fixed tick of economy, movement, battles,
 * scoring and end conditions. Called by the client worker.
 */

import { nextStateRandom } from './rng.js';
import { resolveBattle } from './combat.js';
import { applyCommand } from './commands.js';
import { tickEconomy } from './economy.js';

/**
 * @param {any} state
 * @param {any} balance
 */
function updateStats(state, balance) {
  for (const player of state.players) {
    let cityCount = 0;
    for (const city of state.cities) if (city.owner === player.id) cityCount += 1;
    player.cityCount = cityCount;
    player.score = Math.round(
      cityCount * balance.scorePerCity + player.kills * balance.scorePerKill,
    );
  }
}

/**
 * @param {any} state
 * @param {any} balance
 */
function checkEnd(state, balance) {
  if (state.phase !== 'playing') return;
  const player = state.players[0];
  const matchTicks = Math.round((balance.matchSeconds * 1000) / balance.tickMs);

  if (player.cityCount === 0) {
    state.phase = 'lost';
    state.result = { outcome: 'lost', score: player.score, cities: 0, kills: player.kills };
    return;
  }

  const homeland = state.cities.filter(
    (/** @type {any} */ city) => city.continent === state.spawnContinent,
  );
  const owned = homeland.filter((/** @type {any} */ city) => city.owner === player.id);
  if (homeland.length > 0 && owned.length === homeland.length) {
    state.phase = 'won';
    state.result = {
      outcome: 'won',
      score: player.score,
      cities: player.cityCount,
      kills: player.kills,
    };
    return;
  }

  if (state.tick >= matchTicks) {
    state.phase = 'ended';
    state.result = {
      outcome: 'ended',
      score: player.score,
      cities: player.cityCount,
      kills: player.kills,
    };
  }
}

/**
 * Advance the match by one tick.
 * @param {any} state
 * @param {any} balance
 * @param {any[]} commands
 * @returns {any}
 */
export function step(state, balance, commands) {
  if (state.phase !== 'playing') return state;
  state.tick += 1;
  state.events = [];

  for (const command of commands) {
    const result = applyCommand(state, balance, command);
    if (!result.ok) state.events.push({ type: 'error', message: result.error });
  }

  const travelTicks = Math.round(
    (balance.soldierTravelSeconds * 1000) / balance.tickMs,
  );

  /** @type {any[]} */
  const remaining = [];
  for (const army of state.armies) {
    if (state.tick < army.arriveTick) {
      remaining.push(army);
      continue;
    }

    const target = state.cities[army.toCity];
    if (!target) continue;

    if (target.owner === army.owner) {
      target.garrison += army.soldiers;
      state.events.push({ type: 'reinforce', cityId: target.id, soldiers: army.soldiers });
      continue;
    }

    const battle = resolveBattle(army.soldiers, target, balance, () =>
      nextStateRandom(state),
    );
    const previousOwner = target.owner;
    const attacker = state.players[army.owner];

    if (battle.captured) {
      target.owner = army.owner;
      target.garrison = battle.attackerRemaining;
      target.level = Math.max(1, target.level - balance.captureLevelLoss);
      target.upgrading = null;
      attacker.kills += battle.defenderLoss;
      if (previousOwner !== null) {
        state.players[previousOwner].kills += battle.attackerLoss;
      }
      state.events.push({
        type: 'captured',
        cityId: target.id,
        owner: army.owner,
        attackerLoss: battle.attackerLoss,
        defenderLoss: battle.defenderLoss,
      });
      continue;
    }

    target.garrison = Math.max(0, battle.defenderRemaining);
    attacker.kills += battle.defenderLoss;
    if (target.owner !== null) {
      state.players[target.owner].kills += battle.attackerLoss;
    }
    state.events.push({
      type: 'battle',
      cityId: target.id,
      attackerLoss: battle.attackerLoss,
      defenderLoss: battle.defenderLoss,
    });

    if (battle.attackerRemaining > 0) {
      remaining.push({
        id: state.nextArmyId,
        owner: army.owner,
        fromCity: army.toCity,
        toCity: army.fromCity,
        soldiers: battle.attackerRemaining,
        departTick: state.tick,
        arriveTick: state.tick + travelTicks,
      });
      state.nextArmyId += 1;
    }
  }
  state.armies = remaining;

  tickEconomy(state, balance);
  updateStats(state, balance);
  checkEnd(state, balance);
  return state;
}
