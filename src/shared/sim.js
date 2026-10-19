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
  commanderAtCity,
  commanderEffects,
  grantCommanderXp,
} from './commanders.js';
import { isBlocked, isFriendly, setRelation } from './diplomacy.js';
import {
  ensureCityUnits,
  mergeUnits,
  removeUnits,
  splitUnits,
  syncCityGarrison,
  totalUnits,
  unitTravelSeconds,
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
    let specialScore = 0;
    for (const city of state.cities) {
      if (city.owner !== player.id) continue;
      specialScore += balance.specialSites?.[city.special]?.score ?? 0;
    }
    player.score = Math.round(
      cityCount * balance.scorePerCity +
        Object.keys(player.tech ?? {}).length * 50 +
        player.kills * balance.scorePerKill +
        specialScore,
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
 * @param {number} playerId
 */
function ownedSpecialSites(state, balance, playerId) {
  let count = 0;
  for (const city of state.cities) {
    if (city.owner === playerId && city.special) count += 1;
  }
  return count;
}

function triggerWorldEvent(state, balance) {
  const config = balance.worldEvents;
  if (!config) return;
  const events = config.events ?? [];
  if (events.length === 0) return;
  const index = Math.floor(nextStateRandom(state) * events.length);
  const event = events[index];
  const leader = [...state.players].sort((a, b) => b.cityCount - a.cityCount || b.score - a.score)[0];
  const trailing = [...state.players].sort((a, b) => a.cityCount - b.cityCount)[0];
  if (event.id === 'harvest') {
    for (const player of state.players) player.food += 60;
  } else if (event.id === 'levy') {
    for (const player of state.players) {
      const city = state.cities.filter((entry) => entry.owner === player.id).sort((a, b) => b.garrison - a.garrison)[0];
      if (city) {
        ensureCityUnits(city);
        city.units.infantry += 10;
        syncCityGarrison(city);
      }
    }
  } else if (event.id === 'plague' && leader) {
    const city = state.cities.filter((entry) => entry.owner === leader.id).sort((a, b) => b.garrison - a.garrison)[0];
    if (city) {
      ensureCityUnits(city);
      const loss = Math.max(1, Math.round(totalUnits(city.units) * 0.15));
      city.units = removeUnits(city.units, loss).remaining;
      syncCityGarrison(city);
    }
  } else if (event.id === 'windfall' && trailing) {
    trailing.gold += 120;
  }
  state.events.push({ type: 'worldEvent', eventId: event.id, name: event.name, description: event.description });
  state.nextEventTick = state.tick + Math.round(((config.intervalSeconds ?? 90) * 1000) / balance.tickMs);
}

function updateCoalition(state, balance) {
  if (state.multiplayer || state.coalition) return;
  const human = state.players[0];
  const ais = state.players.filter((player) => player.isAI);
  if (!human || ais.length === 0) return;
  const maxAI = Math.max(...ais.map((player) => player.cityCount));
  const config = balance.antiSnowball ?? {};
  const humanLeads =
    human.cityCount >= maxAI + (config.coalitionLead ?? 4) ||
    human.score >= (Math.max(...state.players.filter((p) => p.id !== 0).map((p) => p.score), 0) || 1) * (config.coalitionScoreRatio ?? 1.5);
  if (!humanLeads) return;
  state.coalition = true;
  for (let a = 0; a < ais.length; a += 1) {
    for (let b = a + 1; b < ais.length; b += 1) {
      setRelation(state, ais[a].id, ais[b].id, 'ally');
    }
  }
  state.events.push({ type: 'coalition', name: '反制联盟', description: 'AI 结成联盟共同对抗领先者' });
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

  const specialTotal = state.cities.filter(
    (/** @type {any} */ city) => city.special,
  ).length;
  const specialRequired = Math.ceil(
    specialTotal * (state.objectiveFraction ?? balance.objectives?.requiredFraction ?? 0.67),
  );

  if (state.multiplayer) {
    if (state.mode === 'endless') {
      const alive = state.players.filter(
        (/** @type {any} */ player) => player.cityCount > 0,
      );
      // A solo test room should keep running; only end when all cities are lost.
      const solo = state.players.length <= 1;
      if (alive.length === 0) {
        state.phase = 'ended';
        state.result = {
          outcome: 'ended',
          winner: null,
          wave: state.wave ?? 0,
          ranking: ranking(state),
        };
      } else if (!solo && alive.length === 1) {
        state.phase = 'ended';
        state.result = {
          outcome: 'victory',
          winner: alive[0].id,
          wave: state.wave ?? 0,
          ranking: ranking(state),
        };
      }
      return;
    }
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
    const objectiveWinner =
      specialRequired > 0
        ? state.players.find(
            (/** @type {any} */ player) =>
              ownedSpecialSites(state, balance, player.id) >= specialRequired,
          )
        : null;
    if (objectiveWinner) {
      state.phase = 'ended';
      state.result = {
        outcome: 'objectives',
        winner: objectiveWinner.id,
        score: objectiveWinner.score,
        cities: objectiveWinner.cityCount,
        kills: objectiveWinner.kills,
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

  if (state.mode === 'endless') {
    if (human.cityCount === 0) {
      state.phase = 'lost';
      state.result = {
        outcome: 'lost',
        mode: 'endless',
        wave: state.wave ?? 0,
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
        mode: 'endless',
        wave: state.wave ?? 0,
        score: human.score,
        cities: human.cityCount,
        kills: human.kills,
        ranking: ranking(state),
      };
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

  if (
    state.mode !== 'endless' &&
    specialRequired > 0 &&
    ownedSpecialSites(state, balance, 0) >= specialRequired
  ) {
    state.phase = 'won';
    state.result = {
      outcome: 'objectives',
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
 * @param {any} state
 * @param {any} balance
 * @param {number} playerId
 * @param {number | null} commanderId
 * @param {number} xp
 */
function awardCommanderXp(state, balance, playerId, commanderId, xp) {
  if (commanderId === null || commanderId === undefined) return;
  const player = state.players[playerId];
  const commander = (player?.commanders ?? []).find(
    (entry) => entry.id === commanderId,
  );
  if (commander) grantCommanderXp(commander, balance, xp);
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
  const mistakeChance = state.aiProfile?.aiMistakeChance ?? 0;
  if (mistakeChance > 0 && random() < mistakeChance) return;
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

  // Choose a city specialisation.
  const unspecialized = owned.filter((/** @type {any} */ city) => !city.focus);
  if (unspecialized.length > 0 && random() < 0.25) {
    const city = unspecialized[Math.floor(random() * unspecialized.length)];
    const frontline = city.neighbors.some(
      (/** @type {number} */ targetId) => {
        const owner = state.cities[targetId].owner;
        return owner !== null && owner !== player.id;
      },
    );
    const focusId = frontline
      ? 'military'
      : random() < 0.5
        ? 'commercial'
        : 'agricultural';
    const result = applyCommand(state, balance, {
      type: 'specialize',
      cityId: city.id,
      focus: focusId,
      owner: player.id,
    });
    if (result.ok) return;
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
  /** @type {{ from: number, to: number, odds: number, soldiers: number, stance: string } | null} */
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
      const fortressEstimate = balance.specialSites?.[target.special]?.defense ?? 0;
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
          defenderDefense:
            defenderTech.defense + defenderBuildings.defense + fortressEstimate,
          siegeBonus: effects.siege,
        },
      );
      const targetWeight = target.special
        ? balance.specialSites?.[target.special]?.score ?? 80
        : 0;
      const order =
        target.special === 'fortress'
          ? 'siege'
          : estimate.odds > attackOdds + 0.2
            ? 'focus'
            : 'none';
      const stance =
        estimate.odds > attackOdds + 0.12
          ? 'assault'
          : estimate.odds < attackOdds
            ? 'raid'
            : 'none';
      if (estimate.odds < attackOdds) continue;
      if (!bestAttack || estimate.odds + targetWeight / 1000 > bestAttack.odds + (bestAttack.weight ?? 0) / 1000) {
        bestAttack = {
          from: city.id,
          to: targetId,
          odds: estimate.odds,
          weight: targetWeight,
          soldiers: Math.max(
            10,
            Math.floor(
              city.garrison * (1 - (state.aiProfile?.aiReserveRatio ?? 0)),
            ),
          ),
          stance,
          order,
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
      stance: bestAttack.stance,
      order: bestAttack.order,
      owner: player.id,
    });
    if (state.aiProfile?.aiMultiFront && random() < 0.65) {
      for (const city of owned) {
        if (city.id === bestAttack.from) continue;
        ensureCityUnits(city);
        if (city.garrison < 20) continue;
        for (const targetId of [...city.neighbors, ...(city.seaNeighbors ?? [])]) {
          const target = state.cities[targetId];
          if (!target || target.owner === player.id) continue;
          const secondEstimate = estimateBattle(city.units, target, balance, {
            attackerAttack: effects.attack,
            defenderDefense: 0,
            siegeBonus: effects.siege,
          });
          if (secondEstimate.odds < attackOdds) continue;
          applyCommand(state, balance, {
            type: 'deploy',
            fromCity: city.id,
            toCity: targetId,
            soldiers: Math.max(
              10,
              Math.floor(
                city.garrison * (1 - (state.aiProfile?.aiReserveRatio ?? 0)),
              ),
            ),
            stance: 'assault',
            owner: player.id,
          });
          return;
        }
      }
    }
  }
}

/**
 * Spawn an escalating wave of rebel armies that attacks any owned city.
 * @param {any} state
 * @param {any} balance
 */
function spawnWave(state, balance) {
  const config = balance.endless;
  if (!config) return;
  state.wave = (state.wave ?? 0) + 1;
  const interval = Math.max(
    config.minWaveIntervalSeconds,
    config.waveIntervalSeconds - (state.wave - 1) * config.intervalDecaySeconds,
  );
  state.nextWaveTick = state.tick + Math.round((interval * 1000) / balance.tickMs);

  const owned = state.cities.filter((/** @type {any} */ city) => city.owner !== null);
  if (owned.length === 0) return;
  const neutral = state.cities.filter((/** @type {any} */ city) => city.owner === null);
  if (neutral.length === 0) return;

  const armyCount = Math.min(
    config.maxArmiesPerWave ?? 6,
    (config.armiesBase ?? 1) + Math.floor(state.wave / (config.armiesPerWaveStep ?? 2)),
  );
  const totalSoldiers = config.baseSoldiers + state.wave * config.soldiersPerWave;

  for (let index = 0; index < armyCount; index += 1) {
    const target = owned[Math.floor(nextStateRandom(state) * owned.length)];
    const source =
      neutral[Math.floor(nextStateRandom(state) * neutral.length)] ??
      state.cities[Math.floor(nextStateRandom(state) * state.cities.length)];
    if (!target || !source || target.id === source.id) continue;

    const siegeCount =
      state.wave >= (config.siegeFromWave ?? 99)
        ? Math.max(1, Math.round(totalSoldiers * 0.05))
        : 0;
    const cavalryCount =
      state.wave >= (config.cavalryFromWave ?? 99)
        ? Math.round(totalSoldiers * 0.2)
        : 0;
    const infantryCount = Math.max(1, totalSoldiers - cavalryCount - siegeCount);
    const units = { infantry: infantryCount, cavalry: cavalryCount, siege: siegeCount };
    const travelTicks = Math.round(
      (unitTravelSeconds(units, balance) * 1000) / balance.tickMs,
    );
    state.armies.push({
      id: state.nextArmyId,
      owner: -1,
      fromCity: source.id,
      toCity: target.id,
      soldiers: totalUnits(units),
      units,
      departTick: state.tick,
      arriveTick: state.tick + travelTicks,
      sea: false,
      rebel: true,
    });
    state.nextArmyId += 1;
  }
  state.events.push({ type: 'wave', wave: state.wave, armies: armyCount });
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
  const profile = state.aiProfile ?? {};
  const thinkTicks = profile.aiThinkTicks ?? balance.ai?.thinkTicks ?? 12;
  const actionsPerThink = profile.aiActionsPerThink ?? 1;
  const startDelayTicks = Math.round((profile.aiStartDelaySeconds ?? 0) * 10);
  for (const player of state.players) {
    if (!player.isAI || player.cityCount === 0) continue;
    if (state.tick < startDelayTicks) continue;
    if ((state.tick + player.id * 3) % thinkTicks !== 0) continue;
    for (let action = 0; action < actionsPerThink; action += 1) {
      if (player.cityCount === 0) break;
      aiAct(state, balance, player);
    }
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
  if (
    state.mode === 'endless' &&
    state.tick >= (state.nextWaveTick ?? Infinity)
  ) {
    spawnWave(state, balance);
  }

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
    if (!target) continue;

    ensureCityUnits(target);
    if (army.owner === -1) {
      if (target.owner === null) continue;
      const rebelDefense = buildingEffects(balance, target).defense;
      const battle = resolveBattle(
        army.units,
        target,
        balance,
        () => nextStateRandom(state),
        { defenderDefense: rebelDefense },
      );
      if (battle.captured) {
        target.owner = null;
        target.units = battle.attackerRemaining;
        syncCityGarrison(target);
        target.level = Math.max(1, target.level - balance.captureLevelLoss);
        target.upgrading = null;
        state.events.push({
          type: 'rebelCapture',
          cityId: target.id,
          wave: state.wave,
        });
      } else {
        target.units = battle.defenderRemaining;
        syncCityGarrison(target);
        state.events.push({
          type: 'rebelAttack',
          cityId: target.id,
          wave: state.wave,
        });
      }
      continue;
    }
    const attacker = state.players[army.owner];
    if (!attacker) continue;
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
    const fortressDefense =
      balance.specialSites?.[target.special]?.defense ?? 0;
    const previousOwner = target.owner;
    const defenderPlayer =
      previousOwner === null ? null : state.players[previousOwner];
    const defenderCommander = defenderPlayer
      ? commanderAtCity(defenderPlayer, target.id)
      : null;
    const defenderCommanderBonus = commanderEffects(
      defenderCommander,
      balance,
    );
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
        attackerAttack:
          Math.max(0, attackerTech.attack - betrayalPenalty) +
          (army.commanderAttack ?? 0),
        defenderDefense:
          (defenderTech.defense ?? 0) +
          defenderBuildings.defense +
          defenderCommanderBonus.defense +
          fortressDefense,
        siegeBonus: attackerTech.siege,
        stance: balance.stances?.[army.stance ?? 'none'],
        order: balance.battleOrders?.[army.order ?? 'none'],
      },
    );
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
      if (defenderCommander) defenderCommander.cityId = null;
      awardCommanderXp(
        state,
        balance,
        army.owner,
        army.commanderId,
        (balance.commanders?.xpPerBattle ?? 8) +
          (balance.commanders?.xpPerCapture ?? 20),
      );
      if (previousOwner !== null) {
        awardCommanderXp(
          state,
          balance,
          previousOwner,
          defenderCommander?.id ?? null,
          balance.commanders?.xpPerBattle ?? 8,
        );
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
      if (battle.retreated && battle.attackerRemaining) {
        const survivors = battle.attackerRemaining;
        const survivingTotal = totalUnits(survivors);
        const keep = Math.max(1, Math.floor(survivingTotal * 0.5));
        const retreating = splitUnits(survivors, keep).remaining;
        const retreatTicks = Math.max(
          1,
          Math.round(
            (unitTravelSeconds(retreating, balance) * 1000) / balance.tickMs,
          ),
        );
        remaining.push({
          id: state.nextArmyId,
          owner: army.owner,
          fromCity: target.id,
          toCity: army.fromCity,
          soldiers: totalUnits(retreating),
          units: retreating,
          stance: army.stance,
          order: army.order,
          commanderId: army.commanderId,
          commanderAttack: army.commanderAttack,
          departTick: state.tick,
          arriveTick: state.tick + retreatTicks,
          sea: army.sea,
          retreating: true,
        });
        state.nextArmyId += 1;
      }
      attacker.kills += battle.defenderLoss;
      if (target.owner !== null) {
        state.players[target.owner].kills += battle.attackerLoss;
      }
      awardCommanderXp(
        state,
        balance,
        army.owner,
        army.commanderId,
        balance.commanders?.xpPerBattle ?? 8,
      );
      if (previousOwner !== null) {
        awardCommanderXp(
          state,
          balance,
          previousOwner,
          defenderCommander?.id ?? null,
          balance.commanders?.xpPerBattle ?? 8,
        );
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

  if (state.mode !== 'tutorial' && state.tick >= (state.nextEventTick ?? Infinity)) {
    triggerWorldEvent(state, balance);
  }
  updateCoalition(state, balance);
  runDiplomacy(state, balance);
  runAI(state, balance);
  tickEconomy(state, balance);
  updateStats(state, balance);
  checkEnd(state, balance);
  return state;
}
