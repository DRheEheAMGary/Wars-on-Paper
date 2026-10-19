// @ts-check
/**
 * Resource simulation for the single-player core loop.
 */

/**
 * @param {any} state
 * @param {any} balance
 * @param {number} level
 * @returns {any}
 */
export function levelConfig(balance, level) {
  return balance.cityLevels[Math.min(level, balance.cityLevels.length) - 1];
}

/**
 * Advance economy, population, upgrades and food upkeep by one tick.
 * @param {any} state
 * @param {any} balance
 */
export function tickEconomy(state, balance) {
  const dt = balance.tickMs / 1000;
  const player = state.players[0];
  if (!player) return;

  let goldGain = 0;
  let foodGain = 0;
  let soldiers = 0;

  for (const city of state.cities) {
    const config = levelConfig(balance, city.level);
    if (city.owner === null) continue;

    if (city.upgrading && state.tick >= city.upgrading.endsTick) {
      city.level = Math.min(balance.cityLevels.length, city.level + 1);
      city.upgrading = null;
      state.events.push({ type: 'upgraded', cityId: city.id, level: city.level });
    }

    if (city.owner === 0) {
      goldGain += config.goldPerSecond * dt;
      foodGain += config.foodPerSecond * dt;
      city.population = Math.min(
        config.populationCap,
        city.population + balance.populationGrowthPerSecond * dt,
      );
      soldiers += city.garrison;
    }
  }

  for (const army of state.armies) {
    if (army.owner === 0) soldiers += army.soldiers;
  }

  player.gold += goldGain;
  const upkeep = soldiers * balance.soldierFoodUpkeepPerSecond * dt;
  player.food += foodGain - upkeep;

  if (player.food < 0) {
    player.food = 0;
    const loss = balance.starvationLossPerSecond * dt;
    for (const city of state.cities) {
      if (city.owner !== 0) continue;
      city.garrison = Math.max(0, Math.round(city.garrison * (1 - loss)));
    }
    for (const army of state.armies) {
      if (army.owner !== 0) continue;
      army.soldiers = Math.max(0, Math.round(army.soldiers * (1 - loss)));
    }
    state.events.push({ type: 'starvation' });
  }
}
