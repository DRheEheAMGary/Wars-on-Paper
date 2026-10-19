// @ts-check
/**
 * City building slots and their aggregated effects.
 */

/** @param {any} balance @param {string} id */
export function buildingById(balance, id) {
  return (balance.buildings ?? []).find((/** @type {any} */ building) => building.id === id) ?? null;
}

/**
 * @param {any} balance
 * @param {any} city
 * @returns {{ gold: number, food: number, garrisonCap: number, defense: number }}
 */
export function buildingEffects(balance, city) {
  const totals = { gold: 0, food: 0, garrisonCap: 0, defense: 0 };
  for (const id of city.buildings ?? []) {
    const building = buildingById(balance, id);
    if (!building) continue;
    for (const [key, value] of Object.entries(building.effects ?? {})) {
      if (key in totals) totals[key] += Number(value);
    }
  }
  return totals;
}

/** @param {any} balance @param {any} city */
export function buildingSlotsLeft(balance, city) {
  return Math.max(0, (balance.buildingSlots ?? 2) - (city.buildings ?? []).length);
}
