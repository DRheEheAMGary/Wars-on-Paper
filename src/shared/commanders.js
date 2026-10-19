// @ts-check
/**
 * Commander (general) roster helpers: traits, effects and XP/levels.
 */

/** @param {any} balance @param {string} id */
export function commanderTrait(balance, id) {
  return (balance.commanders?.traits ?? []).find((trait) => trait.id === id) ?? null;
}

/** @param {any} balance @param {string} id */
export function commanderTraitName(balance, id) {
  return commanderTrait(balance, id)?.name ?? id;
}

/** @param {any} player @param {number | null} cityId */
export function commanderAtCity(player, cityId) {
  if (cityId === null || cityId === undefined) return null;
  return (player.commanders ?? []).find((commander) => commander.cityId === cityId) ?? null;
}

/** @param {any} player */
export function unassignedCommanders(player) {
  return (player.commanders ?? []).filter((commander) => commander.cityId === null);
}

/**
 * Aggregate a commander's bonuses at their current assignment.
 * @param {any} commander
 * @param {any} balance
 */
export function commanderEffects(commander, balance) {
  if (!commander) return { attack: 0, defense: 0, gold: 0, food: 0, travel: 0 };
  const trait = commanderTrait(balance, commander.trait);
  const perLevel = trait?.effects ?? {};
  const level = Math.max(1, commander.level ?? 1);
  return {
    attack: (perLevel.attack ?? 0) * level,
    defense: (perLevel.defense ?? 0) * level,
    gold: (perLevel.gold ?? 0) * level,
    food: (perLevel.food ?? 0) * level,
    travel: Math.min(0.5, (perLevel.travel ?? 0) * level),
  };
}

/** @param {any} balance @param {number} level */
export function commanderXpToNext(balance, level) {
  const levels = balance.commanders?.xpLevels ?? [0, 40, 100, 180, 300];
  return levels[level] ?? levels[levels.length - 1] ?? 300;
}

/**
 * Add XP and level the commander up when thresholds are crossed.
 * @param {any} commander
 * @param {any} balance
 * @param {number} xp
 * @returns {boolean} true when the commander levelled up
 */
export function grantCommanderXp(commander, balance, xp) {
  if (!commander) return false;
  const maxLevel = balance.commanders?.maxLevel ?? 5;
  commander.xp = (commander.xp ?? 0) + xp;
  let levelled = false;
  while (
    commander.level < maxLevel &&
    commander.xp >= commanderXpToNext(balance, commander.level)
  ) {
    commander.xp -= commanderXpToNext(balance, commander.level);
    commander.level += 1;
    levelled = true;
  }
  return levelled;
}
