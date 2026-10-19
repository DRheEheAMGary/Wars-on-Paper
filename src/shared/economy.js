// @ts-check
/**
 * Resource simulation: production, population, upkeep, starvation, upgrades
 * and timed technology research.
 */

import { techEffects } from './tech.js';
import { buildingEffects } from './buildings.js';
import { commanderAtCity, commanderEffects } from './commanders.js';
import { removeUnits, syncCityGarrison, totalUnits } from './units.js';

/**
 * @param {any} balance
 * @param {number} level
 * @returns {any}
 */
export function levelConfig(balance, level) {
  return balance.cityLevels[Math.min(level, balance.cityLevels.length) - 1];
}

/**
 * Advance all players' economy by one tick.
 * @param {any} state
 * @param {any} balance
 */
export function tickEconomy(state, balance) {
  const dt = balance.tickMs / 1000;

  // Finish timed research.
  for (const player of state.players) {
    if (!player.research) continue;
    if (state.tick < player.research.endsTick) continue;
    const tech = (balance.research ?? []).find(
      (/** @type {any} */ entry) => entry.id === player.research.id,
    );
    player.tech = player.tech ?? {};
    player.tech[player.research.id] = true;
    player.research = null;
    if (player.id === 0 || state.multiplayer) {
      state.events.push({
        type: 'researched',
        playerId: player.id,
        techId: tech?.id,
        name: tech?.name ?? '科技',
      });
    }
  }

  // Finish city upgrades.
  for (const city of state.cities) {
    if (city.owner === null) continue;
    if (city.upgrading && state.tick >= city.upgrading.endsTick) {
      city.level = Math.min(balance.cityLevels.length, city.level + 1);
      city.upgrading = null;
      if (city.owner === 0 || state.multiplayer) {
        state.events.push({ type: 'upgraded', cityId: city.id, level: city.level });
      }
    }
  }

  for (const player of state.players) {
    const effects = techEffects(player, balance);
    let goldGain = 0;
    let foodGain = 0;
    let soldiers = 0;

    for (const city of state.cities) {
      if (city.owner !== player.id) continue;
      const config = levelConfig(balance, city.level);
      const difficultyMultiplier =
        player.isAI && state.aiProfile?.aiGoldMultiplier
          ? state.aiProfile.aiGoldMultiplier
          : 1;
      const buildings = buildingEffects(balance, city);
      const governor = commanderAtCity(player, city.id);
      const governorBonus = commanderEffects(governor, balance);
      goldGain +=
        config.goldPerSecond *
        (1 + effects.gold) *
        (1 + buildings.gold) *
        (1 + governorBonus.gold) *
        difficultyMultiplier;
      foodGain +=
        config.foodPerSecond *
        (1 + effects.food) *
        (1 + buildings.food) *
        (1 + governorBonus.food);
      const special = balance.specialSites?.[city.special] ?? null;
      if (special) {
        goldGain += special.gold ?? 0;
        foodGain += special.food ?? 0;
      }

      const populationCap = Math.round(
        config.populationCap * (1 + effects.populationCap),
      );
      const growth =
        balance.populationGrowthPerSecond * (1 + 0.25 * (city.level - 1));
      city.population = Math.min(populationCap, city.population + growth * dt);

      syncCityGarrison(city);
      soldiers += city.garrison;
    }
    for (const army of state.armies) {
      if (army.owner === player.id) soldiers += army.soldiers;
    }

    player.gold += goldGain * dt;
    player.food += (foodGain - soldiers * balance.soldierFoodUpkeepPerSecond) * dt;

    if (player.food < 0) {
      player.food = 0;
      const lossRate = balance.starvationLossPerSecond * dt;
      for (const city of state.cities) {
        if (city.owner !== player.id) continue;
        const total = totalUnits(city.units);
        const loss = Math.max(1, Math.round(total * lossRate));
        city.units = removeUnits(city.units, loss).remaining;
        syncCityGarrison(city);
      }
      for (const army of state.armies) {
        if (army.owner !== player.id) continue;
        const total = totalUnits(army.units);
        const loss = Math.max(1, Math.round(total * lossRate));
        army.units = removeUnits(army.units, loss).remaining;
        army.soldiers = totalUnits(army.units);
        if (army.soldiers <= 0) {
          army.soldiers = 0;
        }
      }
      if (player.id === 0 || state.multiplayer) {
        state.events.push({ type: 'starvation', playerId: player.id });
      }
    }
  }
}
