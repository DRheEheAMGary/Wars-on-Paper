// @ts-check
/**
 * Player commands and their validation (recruit, upgrade, research, deploy).
 */

import { levelConfig } from './economy.js';

/**
 * @typedef {{ ok: true, sea?: boolean } | { ok: false, error: string }} CommandResult
 */

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
    const config = levelConfig(balance, city.level);
    const batch = balance.recruitBatch;
    const gold = balance.soldierCostGold * batch;
    const population = balance.soldierCostPopulation * batch;
    if (player.gold < gold) return { ok: false, error: '金币不足' };
    if (city.population < population) return { ok: false, error: '人口不足' };
    if (city.garrison + batch > config.garrisonCap) {
      return { ok: false, error: '驻军已满' };
    }
    player.gold -= gold;
    city.population -= population;
    city.garrison += batch;
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
    const tech = (balance.research ?? []).find(
      (/** @type {any} */ item) => item.id === command.techId,
    );
    if (!tech) return { ok: false, error: '未知科技' };
    if (player.tech?.[tech.id]) return { ok: false, error: '已研发' };
    if (player.gold < tech.costGold) return { ok: false, error: '金币不足' };
    player.gold -= tech.costGold;
    player.tech = player.tech ?? {};
    player.tech[tech.id] = true;
    return { ok: true };
  }

  if (command.type === 'deploy') {
    const from = state.cities[command.fromCity];
    const to = state.cities[command.toCity];
    if (!from || from.owner !== player.id) return { ok: false, error: '出发城市不属于你' };
    if (!to) return { ok: false, error: '目标城市无效' };

    const landRoute = from.neighbors.includes(to.id);
    const seaRoute = (from.seaNeighbors ?? []).includes(to.id);
    if (!landRoute && !seaRoute) return { ok: false, error: '只能攻击相邻或可渡海的城市' };

    const soldiers = Math.min(
      Math.max(0, Math.floor(command.soldiers ?? from.garrison)),
      from.garrison,
    );
    if (soldiers <= 0) return { ok: false, error: '没有可派出的部队' };

    const research = balance.researchEffects ?? {};
    const logistics = player.tech?.logistics ? 1 - research.logistics : 1;
    const baseTicks = Math.round((balance.soldierTravelSeconds * 1000) / balance.tickMs);
    const travelTicks = Math.max(
      1,
      Math.round(baseTicks * (seaRoute ? balance.seaTravelMultiplier : 1) * logistics),
    );

    from.garrison -= soldiers;
    state.armies.push({
      id: state.nextArmyId,
      owner: player.id,
      fromCity: from.id,
      toCity: to.id,
      soldiers,
      departTick: state.tick,
      arriveTick: state.tick + travelTicks,
      sea: !landRoute,
    });
    state.nextArmyId += 1;
    return { ok: true, sea: !landRoute };
  }

  return { ok: false, error: '未知指令' };
}
