// @ts-check
/**
 * Player commands and validation (recruit, upgrade, research, deploy).
 */

import { levelConfig } from './economy.js';
import { checkResearch, techEffects } from './tech.js';
import {
  ensureCityUnits,
  splitUnits,
  syncCityGarrison,
  totalUnits,
  unitTravelSeconds,
} from './units.js';

/**
 * @typedef {{ ok: true, sea?: boolean } | { ok: false, error: string }} CommandResult
 */

/**
 * Weighted shortest travel cost between two cities (land hop = 1, sea hop =
 * seaTravelMultiplier). Used to move reinforcements between your own cities.
 * @param {any} state
 * @param {number} fromId
 * @param {number} toId
 * @param {any} balance
 * @returns {number}
 */
function shortestTravelCost(state, fromId, toId, balance) {
  /** @type {Map<number, number>} */
  const costs = new Map([[fromId, 0]]);
  /** @type {number[]} */
  const queue = [fromId];
  const visited = new Set();

  while (queue.length > 0) {
    let bestIndex = 0;
    for (let index = 1; index < queue.length; index += 1) {
      if ((costs.get(queue[index]) ?? Infinity) < (costs.get(queue[bestIndex]) ?? Infinity)) {
        bestIndex = index;
      }
    }
    const current = /** @type {number} */ (queue.splice(bestIndex, 1)[0]);
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === toId) return costs.get(current) ?? 1;

    const city = state.cities[current];
    if (!city) continue;
    for (const neighbour of city.neighbors) {
      const next = (costs.get(current) ?? 0) + 1;
      if (next < (costs.get(neighbour) ?? Infinity)) {
        costs.set(neighbour, next);
        queue.push(neighbour);
      }
    }
    for (const neighbour of city.seaNeighbors ?? []) {
      const next = (costs.get(current) ?? 0) + balance.seaTravelMultiplier;
      if (next < (costs.get(neighbour) ?? Infinity)) {
        costs.set(neighbour, next);
        queue.push(neighbour);
      }
    }
  }
  return 2;
}

/**
 * @param {any} state
 * @param {any} balance
 * @param {any} command
 * @returns {CommandResult}
 */
export function applyCommand(state, balance, command) {
  const player = state.players[command.owner ?? 0];
  if (!player) return { ok: false, error: '未知玩家' };

  if (command.type === 'recruit') {
    const city = state.cities[command.cityId];
    if (!city || city.owner !== player.id) return { ok: false, error: '城市不属于你' };
    const unitType = balance.units?.[command.unitType] ? command.unitType : 'infantry';
    const unitConfig = balance.units[unitType];
    const config = levelConfig(balance, city.level);
    const batch = unitConfig.batch ?? balance.recruitBatch ?? 10;
    const gold = unitConfig.costGold * batch;
    const population = unitConfig.costPopulation * batch;
    ensureCityUnits(city);
    if (player.gold < gold) return { ok: false, error: '金币不足' };
    if (city.population < population) return { ok: false, error: '人口不足' };
    if (totalUnits(city.units) + batch > config.garrisonCap) {
      return { ok: false, error: '驻军已满' };
    }
    player.gold -= gold;
    city.population -= population;
    city.units[unitType] += batch;
    syncCityGarrison(city);
    return { ok: true };
  }

  if (command.type === 'upgrade') {
    const city = state.cities[command.cityId];
    if (!city || city.owner !== player.id) return { ok: false, error: '城市不属于你' };
    if (city.upgrading) return { ok: false, error: '正在升级' };
    if (city.level >= balance.cityLevels.length) return { ok: false, error: '已满级' };
    const config = levelConfig(balance, city.level);
    if (player.gold < config.upgradeGold) return { ok: false, error: '金币不足' };
    player.gold -= config.upgradeGold;
    city.upgrading = {
      endsTick: state.tick + Math.round((config.upgradeSeconds * 1000) / balance.tickMs),
    };
    return { ok: true };
  }

  if (command.type === 'research') {
    const check = checkResearch(player, balance, command.techId);
    if (!check.ok) return { ok: false, error: check.error };
    const tech = check.tech;
    player.gold -= tech.costGold;
    player.research = {
      id: tech.id,
      endsTick:
        state.tick + Math.round((tech.researchSeconds * 1000) / balance.tickMs),
    };
    return { ok: true };
  }

  if (command.type === 'deploy') {
    const from = state.cities[command.fromCity];
    const to = state.cities[command.toCity];
    if (!from || from.owner !== player.id) return { ok: false, error: '出发城市不属于你' };
    if (!to) return { ok: false, error: '目标城市无效' };
    if (to.id === from.id) return { ok: false, error: '不能派往同一座城市' };

    const targetOwned = to.owner === player.id;
    if (!targetOwned) {
      const landRoute = from.neighbors.includes(to.id);
      const seaRoute = (from.seaNeighbors ?? []).includes(to.id);
      if (!landRoute && !seaRoute) {
        return { ok: false, error: '只能攻击相邻或可渡海的城市' };
      }
    }

    ensureCityUnits(from);
    const requested = Math.min(
      Math.max(0, Math.floor(command.soldiers ?? from.garrison)),
      from.garrison,
    );
    const split = splitUnits(from.units, requested);
    const sent = split.taken;
    const sentTotal = totalUnits(sent);
    if (sentTotal <= 0) return { ok: false, error: '没有可派出的部队' };

    from.units = split.remaining;
    syncCityGarrison(from);

    const effects = techEffects(player, balance);
    const travelSeconds = unitTravelSeconds(sent, balance);
    const baseTicks = Math.round((travelSeconds * 1000) / balance.tickMs);
    const logistics = 1 - effects.travel;

    let travelTicks;
    let sea = false;
    if (targetOwned) {
      const cost = shortestTravelCost(state, from.id, to.id, balance);
      travelTicks = Math.max(1, Math.round(baseTicks * cost * logistics));
    } else {
      const landRoute = from.neighbors.includes(to.id);
      sea = !landRoute;
      travelTicks = Math.max(
        1,
        Math.round(baseTicks * (sea ? balance.seaTravelMultiplier : 1) * logistics),
      );
    }

    state.armies.push({
      id: state.nextArmyId,
      owner: player.id,
      fromCity: from.id,
      toCity: to.id,
      soldiers: sentTotal,
      units: sent,
      departTick: state.tick,
      arriveTick: state.tick + travelTicks,
      sea,
    });
    state.nextArmyId += 1;
    return { ok: true, sea };
  }

  return { ok: false, error: '未知指令' };
}
