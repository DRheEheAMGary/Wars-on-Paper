// @ts-check
/**
 * Resource simulation: production, population, upkeep, starvation, upgrades.
 */

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
  const goldBonusEffect = balance.researchEffects?.economy ?? 0;

  for (const city of state.cities) {
    if (city.owner === null) continue;
    if (city.upgrading && state.tick >= city.upgrading.endsTick) {
      city.level = Math.min(balance.cityLevels.length, city.level + 1);
      city.upgrading = null;
      if (city.owner === 0) {
        state.events.push({ type: 'upgraded', cityId: city.id, level: city.level });
      }
    }
  }

  for (const player of state.players) {
    let goldGain = 0;
    let foodGain = 0;
    let soldiers = 0;

    for (const city of state.cities) {
      if (city.owner !== player.id) continue;
      const config = levelConfig(balance, city.level);
      goldGain += config.goldPerSecond;
      foodGain += config.foodPerSecond;
      city.population = Math.min(
        config.populationCap,
        city.population + balance.populationGrowthPerSecond * dt,
      );
      soldiers += city.garrison;
    }
    for (const army of state.armies) {
      if (army.owner === player.id) soldiers += army.soldiers;
    }

    const goldMultiplier = 1 + (player.tech?.economy ? goldBonusEffect : 0);
    player.gold += goldGain * dt * goldMultiplier;
    player.food += (foodGain - soldiers * balance.soldierFoodUpkeepPerSecond) * dt;

    if (player.food < 0) {
      player.food = 0;
      const loss = balance.starvationLossPerSecond * dt;
      for (const city of state.cities) {
        if (city.owner !== player.id) continue;
        city.garrison = Math.max(0, Math.round(city.garrison * (1 - loss)));
      }
      for (const army of state.armies) {
        if (army.owner !== player.id) continue;
        army.soldiers = Math.max(0, Math.round(army.soldiers * (1 - loss)));
      }
      if (player.id === 0) state.events.push({ type: 'starvation' });
    }
  }
}
