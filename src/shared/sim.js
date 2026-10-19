// @ts-check
/**
 * The real-time match simulation: player/AI commands, marches, decisive
 * battles with unit counters, economy, scoring and end conditions.
 */

import { nextStateRandom } from './rng.js';
import { estimateBattle, resolveBattle } from './combat.js';
import { applyCommand } from './commands.js';
import { levelConfig, tickEconomy } from './economy.js';
import { techEffects, availableTechs } from './tech.js';
import { buildingEffects } from './buildings.js';
import {
  isBlocked,
  isFriendly,
} from './diplomacy.js';
import {
  ensureCityUnits,
  mergeUnits,
  syncCityGarrison,
  totalUnits,
} from './units.js';

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
      cityCount * balance.scorePerCity +
        Object.keys(player.tech ?? {}).length * 50 +
        player.kills * balance.scorePerKill,
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
  const matchTicks = Math.round(((state.matchSeconds ?? balance.matchSeconds) * 1000) / balance.tickMs);

  if (state.multiplayer) {
    const winner = state.players.find(
      (/** @type {any} */ player) => player.cityCount >= totalCities,
    );
    if (winner) {
      state.phase = 'ended';
      state.result = {
        outcome: 'victory',
        winner: winner.id,
        score: winner.score,
        cities: winner.cityCount,
        kills: winner.kills,
        ranking: ranking(state),
      };
      return;
    }
    if (state.tick >= matchTicks) {
      state.phase = 'ended';
      state.result = { outcome: 'ended', winner: null, ranking: ranking(state) };
    }
    return;
  }

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
      rank: finalRanking.findIndex((/** @type {any} */ entry) => entry.id === 0) + 1,
      ranking: finalRanking,
    };
  }
}

/** @param {any} balance @param {string} unitType */
function unitRecruitCost(balance, unitType) {
  const config = balance.units[unitType];
  return {
    gold: config.costGold * config.batch,
    population: config.costPopulation * config.batch,
    batch: config.batch,
  };
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
  const attackOdds = state.aiProfile?.aiAttackOdds ?? balance.ai?.attackOdds ?? 0.58;
  const effects = techEffects(player, balance);

  // Occasionally propose a truce/alliance to a neighbouring player.
  if (random() < 0.06) {
    /** @type {Set<number>} */
    const neighbours = new Set();
    for (const city of owned) {
      for (const targetId of city.neighbors) {
        const owner = state.cities[targetId].owner;
        if (owner !== null && owner !== player.id) neighbours.add(owner);
      }
    }
    const candidates = [...neighbours].filter(
      (id) => !isFriendly(state, player.id, id) && !isBlocked(state, player.id, id),
    );
    if (candidates.length > 0) {
      const targetId = candidates[Math.floor(random() * candidates.length)];
      const kind =
        state.players[targetId].cityCount > player.cityCount ? 'truce' : 'ally';
      const result = applyCommand(state, balance, {
        type: 'diplomacy',
        action: kind,
        targetId,
        owner: player.id,
      });
      if (result.ok) return;
    }
  }

  // Research an available technology.
  if (!player.research && player.gold > reserve * 2) {
    const candidates = availableTechs(player, balance).filter(
      (/** @type {any} */ tech) => player.gold >= tech.costGold + reserve,
    );
    if (candidates.length > 0 && random() < 0.35) {
      const tech = candidates[Math.floor(random() * candidates.length)];
      applyCommand(state, balance, {
        type: 'research',
        techId: tech.id,
        owner: player.id,
      });
      return;
    }
  }

  // Build a city improvement when there is a free slot.
  if (random() < 0.14) {
    const buildable = owned.filter(
      (/** @type {any} */ city) => (city.buildings ?? []).length < (balance.buildingSlots ?? 2),
    );
    if (buildable.length > 0) {
      const city = buildable[Math.floor(random() * buildable.length)];
      const options = (balance.buildings ?? []).filter(
        (/** @type {any} */ building) =>
          !(city.buildings ?? []).includes(building.id) &&
          player.gold >= building.costGold + reserve,
      );
      if (options.length > 0) {
        const building = options[Math.floor(random() * options.length)];
        const result = applyCommand(state, balance, {
          type: 'build',
          cityId: city.id,
          buildingId: building.id,
          owner: player.id,
        });
        if (result.ok) return;
      }
    }
  }

  // Upgrade a city occasionally.
  const upgradable = owned.filter(
    (/** @type {any} */ city) => !city.upgrading && city.level < balance.cityLevels.length,
  );
  if (upgradable.length > 0 && random() < 0.18) {
    const city = upgradable[Math.floor(random() * upgradable.length)];
    const config = levelConfig(balance, city.level);
    if (player.gold > config.upgradeGold + reserve) {
      applyCommand(state, balance, { type: 'upgrade', cityId: city.id, owner: player.id });
      return;
    }
  }

  // Recruit a mix of unit types.
  const unitTypes = (balance.unitOrder ?? ['infantry']).filter((/** @type {string} */ type) => {
    const cost = unitRecruitCost(balance, type);
    return player.gold >= cost.gold + reserve;
  });
  if (unitTypes.length > 0 && random() < 0.7) {
    const unitType = unitTypes[Math.floor(random() * unitTypes.length)];
    const cost = unitRecruitCost(balance, unitType);
    let recruitCity = null;
    for (const city of owned) {
      const config = levelConfig(balance, city.level);
      ensureCityUnits(city);
      if (
        city.population >= cost.population &&
        totalUnits(city.units) + cost.batch <= config.garrisonCap &&
        (!recruitCity || city.population > recruitCity.population)
      ) {
        recruitCity = city;
      }
    }
    if (recruitCity) {
      applyCommand(state, balance, {
        type: 'recruit',
        cityId: recruitCity.id,
        unitType,
        owner: player.id,
      });
      return;
    }
  }

  // Attack the weakest reachable city when the odds look good.
  /** @type {{ from: number, to: number, odds: number, soldiers: number } | null} */
  let bestAttack = null;
  for (const city of owned) {
    ensureCityUnits(city);
    if (city.garrison < 10) continue;
    for (const targetId of [...city.neighbors, ...(city.seaNeighbors ?? [])]) {
      const target = state.cities[targetId];
      if (!target || target.owner === player.id) continue;
      const defenderTech =
        target.owner === null ? {} : techEffects(state.players[target.owner], balance);
      const defenderBuildings = buildingEffects(balance, target);
      const penalty =
        player.betrayalUntil > state.tick
          ? balance.diplomacy?.betrayPenalty ?? 0.1
          : 0;
      const estimate = estimateBattle(
        city.units,
        target,
        balance,
        {
          attackerAttack: Math.max(0, effects.attack - penalty),
          defenderDefense: defenderTech.defense + defenderBuildings.defense,
          siegeBonus: effects.siege,
        },
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
 * Expire old diplomacy offers and let AI players answer requests.
 * @param {any} state
 * @param {any} balance
 */
function runDiplomacy(state, balance) {
  const config = balance.diplomacy ?? {};
  const requestTicks = Math.round((config.requestSeconds ?? 30) * 1000 / balance.tickMs);
  state.diplomacyRequests = (state.diplomacyRequests ?? []).filter(
    (/** @type {any} */ request) => state.tick - request.createdTick <= requestTicks,
  );
  for (const request of [...state.diplomacyRequests]) {
    const target = state.players[request.to];
    if (!target || !target.isAI) continue;
    const chance = config.aiAcceptChance ?? 0.6;
    const accept = nextStateRandom(state) < chance;
    applyCommand(state, balance, {
      type: 'diplomacy',
      action: accept ? 'accept' : 'decline',
      requestId: request.id,
      owner: request.to,
    });
  }
}

/**
 * @param {any} state
 * @param {any} balance
 */
function runAI(state, balance) {
  const thinkTicks = state.aiProfile?.aiThinkTicks ?? balance.ai?.thinkTicks ?? 12;
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

    ensureCityUnits(target);
    if (target.owner === army.owner) {
      target.units = mergeUnits(target.units, army.units);
      syncCityGarrison(target);
      if (state.multiplayer || army.owner === 0) {
        state.events.push({
          type: 'reinforce',
          cityId: target.id,
          soldiers: army.soldiers,
        });
      }
      continue;
    }

    const attackerTech = techEffects(attacker, balance);
    const defender =
      target.owner === null ? null : state.players[target.owner];
    const defenderTech = defender ? techEffects(defender, balance) : {};
    const defenderBuildings = buildingEffects(balance, target);
    const betrayalPenalty =
      attacker.betrayalUntil > state.tick
        ? balance.diplomacy?.betrayPenalty ?? 0.1
        : 0;
    const battle = resolveBattle(
      army.units,
      target,
      balance,
      () => nextStateRandom(state),
      {
        attackerAttack: Math.max(0, attackerTech.attack - betrayalPenalty),
        defenderDefense: (defenderTech.defense ?? 0) + defenderBuildings.defense,
        siegeBonus: attackerTech.siege,
      },
    );
    const previousOwner = target.owner;
    const humanInvolved =
      state.multiplayer || army.owner === 0 || previousOwner === 0;

    if (battle.captured) {
      target.owner = army.owner;
      target.units = battle.attackerRemaining;
      if (attackerTech.captureGarrison > 0) {
        target.units.infantry += Math.floor(
          battle.defenderLoss * attackerTech.captureGarrison,
        );
      }
      syncCityGarrison(target);
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
      target.units = battle.defenderRemaining;
      syncCityGarrison(target);
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

  runDiplomacy(state, balance);
  runAI(state, balance);
  tickEconomy(state, balance);
  updateStats(state, balance);
  checkEnd(state, balance);
  return state;
}
