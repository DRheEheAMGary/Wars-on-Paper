// @ts-check
/**
 * The real-time match simulation: player/AI commands, marches, decisive
 * battles, economy, scoring and end conditions.
 */

import { nextStateRandom } from './rng.js';
import { estimateBattle, resolveBattle } from './combat.js';
import { applyCommand } from './commands.js';
import { levelConfig, tickEconomy } from './economy.js';

/**
 * @param {any} state
 * @param {any} balance
 */
function updateStats(state, balance) {
  for (const player of state.players) {
    let cityCount = 0;
    for (const city of state.cities) if (city.owner === player.id) cityCount += 1;
    player.cityCount = cityCount;
    player.alive = cityCount > 0;
    player.score = Math.round(
      cityCount * balance.scorePerCity + player.kills * balance.scorePerKill,
    );
  }
}

/**
 * @param {any} state
 * @param {any} balance
 * @returns {any[]}
 */
function ranking(state) {
  return [...state.players]
    .sort((a, b) => b.score - a.score || b.cityCount - a.cityCount || a.id - b.id)
    .map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      cityCount: player.cityCount,
      score: player.score,
      kills: player.kills,
      isAI: player.isAI,
    }));
}

/**
 * @param {any} state
 * @param {any} balance
 */
function checkEnd(state, balance) {
  if (state.phase !== 'playing') return;
  const human = state.players[0];
  const totalCities = state.cities.length;
  const matchTicks = Math.round((balance.matchSeconds * 1000) / balance.tickMs);

  if (human.cityCount === 0) {
    state.phase = 'lost';
    state.result = {
      outcome: 'lost',
      score: human.score,
      cities: 0,
      kills: human.kills,
      ranking: ranking(state),
    };
    return;
  }

  if (human.cityCount >= totalCities) {
    state.phase = 'won';
    state.result = {
      outcome: 'won',
      score: human.score,
      cities: human.cityCount,
      kills: human.kills,
      ranking: ranking(state),
    };
    return;
  }

  if (state.tick >= matchTicks) {
    const finalRanking = ranking(state);
    state.phase = 'ended';
    state.result = {
      outcome: 'ended',
      score: human.score,
      cities: human.cityCount,
      kills: human.kills,
      rank: finalRanking.findIndex((entry) => entry.id === 0) + 1,
      ranking: finalRanking,
    };
  }
}

/**
 * One AI decision per think tick, using the same command interface as the human.
 * @param {any} state
 * @param {any} balance
 * @param {any} player
 */
function aiAct(state, balance, player) {
  /** @returns {number} */
  const random = () => nextStateRandom(state);
  const owned = state.cities.filter((/** @type {any} */ city) => city.owner === player.id);
  if (owned.length === 0) return;

  const reserve = balance.ai?.reserveGold ?? 0;
  const attackOdds = balance.ai?.attackOdds ?? 0.58;
  const effects = balance.researchEffects ?? {};

  // Research occasionally.
  for (const tech of balance.research ?? []) {
    if (player.tech?.[tech.id]) continue;
    if (player.gold > tech.costGold + reserve * 2 && random() < 0.3) {
      applyCommand(state, balance, { type: 'research', techId: tech.id, owner: player.id });
      return;
    }
  }

  // Upgrade a city occasionally.
  const upgradable = owned.filter(
    (/** @type {any} */ city) =>
      !city.upgrading && city.level < balance.cityLevels.length,
  );
  if (upgradable.length > 0 && random() < 0.2) {
    const city = upgradable[Math.floor(random() * upgradable.length)];
    const config = levelConfig(balance, city.level);
    if (player.gold > config.upgradeGold + reserve) {
      applyCommand(state, balance, { type: 'upgrade', cityId: city.id, owner: player.id });
      return;
    }
  }

  // Recruit into the most populated city.
  const recruitCost = balance.soldierCostGold * balance.recruitBatch;
  const recruitPopulation = balance.soldierCostPopulation * balance.recruitBatch;
  if (player.gold > recruitCost + reserve) {
    let recruitCity = null;
    for (const city of owned) {
      const config = levelConfig(balance, city.level);
      if (
        city.population >= recruitPopulation &&
        city.garrison + balance.recruitBatch <= config.garrisonCap &&
        (!recruitCity || city.population > recruitCity.population)
      ) {
        recruitCity = city;
      }
    }
    if (recruitCity) {
      applyCommand(state, balance, {
        type: 'recruit',
        cityId: recruitCity.id,
        owner: player.id,
      });
      return;
    }
  }

  // Attack the weakest reachable city when the odds look good.
  const attackerMultiplier = 1 + (player.tech?.military ? effects.military : 0);
  /** @type {{ from: number, to: number, odds: number, soldiers: number } | null} */
  let bestAttack = null;
  for (const city of owned) {
    if (city.garrison < 10) continue;
    for (const targetId of [...city.neighbors, ...(city.seaNeighbors ?? [])]) {
      const target = state.cities[targetId];
      if (!target || target.owner === player.id) continue;
      const estimate = estimateBattle(
        city.garrison,
        target,
        balance,
        attackerMultiplier,
      );
      if (estimate.odds < attackOdds) continue;
      if (!bestAttack || estimate.odds > bestAttack.odds) {
        bestAttack = {
          from: city.id,
          to: targetId,
          odds: estimate.odds,
          soldiers: city.garrison,
        };
      }
    }
  }
  if (bestAttack) {
    applyCommand(state, balance, {
      type: 'deploy',
      fromCity: bestAttack.from,
      toCity: bestAttack.to,
      soldiers: bestAttack.soldiers,
      owner: player.id,
    });
  }
}

/**
 * @param {any} state
 * @param {any} balance
 */
function runAI(state, balance) {
  const thinkTicks = balance.ai?.thinkTicks ?? 12;
  for (const player of state.players) {
    if (!player.isAI || player.cityCount === 0) continue;
    if ((state.tick + player.id * 3) % thinkTicks !== 0) continue;
    aiAct(state, balance, player);
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

  /** @type {any[]} */
  const remaining = [];
  for (const army of state.armies) {
    if (state.tick < army.arriveTick) {
      remaining.push(army);
      continue;
    }

    const target = state.cities[army.toCity];
    const attacker = state.players[army.owner];
    if (!target || !attacker) continue;

    if (target.owner === army.owner) {
      target.garrison += army.soldiers;
      if (army.owner === 0) {
        state.events.push({ type: 'reinforce', cityId: target.id, soldiers: army.soldiers });
      }
      continue;
    }

    const effects = balance.researchEffects ?? {};
    const attackerMultiplier = 1 + (attacker.tech?.military ? effects.military : 0);
    const battle = resolveBattle(
      army.soldiers,
      target,
      balance,
      () => nextStateRandom(state),
      attackerMultiplier,
    );
    const previousOwner = target.owner;
    const humanInvolved = army.owner === 0 || previousOwner === 0;

    if (battle.captured) {
      target.owner = army.owner;
      target.garrison = battle.attackerRemaining;
      target.level = Math.max(1, target.level - balance.captureLevelLoss);
      target.upgrading = null;
      attacker.kills += battle.defenderLoss;
      if (previousOwner !== null) {
        state.players[previousOwner].kills += battle.attackerLoss;
      }
      if (humanInvolved) {
        state.events.push({
          type: 'captured',
          cityId: target.id,
          owner: army.owner,
          attackerLoss: battle.attackerLoss,
          defenderLoss: battle.defenderLoss,
        });
      }
    } else {
      target.garrison = battle.defenderRemaining;
      attacker.kills += battle.defenderLoss;
      if (target.owner !== null) {
        state.players[target.owner].kills += battle.attackerLoss;
      }
      if (humanInvolved) {
        state.events.push({
          type: 'battle',
          cityId: target.id,
          attackerLoss: battle.attackerLoss,
          defenderLoss: battle.defenderLoss,
          attackerWiped: true,
        });
      }
    }
  }
  state.armies = remaining;

  runAI(state, balance);
  tickEconomy(state, balance);
  updateStats(state, balance);
  checkEnd(state, balance);
  return state;
}
