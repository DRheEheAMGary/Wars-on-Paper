// @ts-check
/**
 * Technology tree helpers: prerequisites, aggregate effects and availability.
 */

/** @param {any} balance @param {string} id */
export function researchById(balance, id) {
  return (balance.research ?? []).find((/** @type {any} */ tech) => tech.id === id) ?? null;
}

/**
 * Aggregate all researched bonuses for a player.
 * @param {any} player
 * @param {any} balance
 * @returns {{ attack: number, defense: number, gold: number, food: number, populationCap: number, travel: number, siege: number, captureGarrison: number }}
 */
export function techEffects(player, balance) {
  /** @type {any} */
  const totals = {
    attack: 0,
    defense: 0,
    gold: 0,
    food: 0,
    populationCap: 0,
    travel: 0,
    siege: 0,
    captureGarrison: 0,
  };
  for (const tech of balance.research ?? []) {
    if (!player.tech?.[tech.id]) continue;
    for (const [key, value] of Object.entries(tech.effects ?? {})) {
      totals[key] = (totals[key] ?? 0) + Number(value);
    }
  }
  totals.travel = Math.min(0.6, totals.travel);
  return totals;
}

/**
 * @param {any} player
 * @param {any} balance
 * @param {string} techId
 * @returns {{ ok: true, tech: any } | { ok: false, error: string }}
 */
export function checkResearch(player, balance, techId) {
  const tech = researchById(balance, techId);
  if (!tech) return { ok: false, error: '未知科技' };
  if (player.tech?.[tech.id]) return { ok: false, error: '已研发' };
  if (player.research) return { ok: false, error: '正在研发其它科技' };
  for (const required of tech.requires ?? []) {
    if (!player.tech?.[required]) {
      const requiredTech = researchById(balance, required);
      return { ok: false, error: `需要先研发「${requiredTech?.name ?? required}」` };
    }
  }
  if ((player.gold ?? 0) < tech.costGold) return { ok: false, error: '金币不足' };
  return { ok: true, tech };
}

/** @param {any} player @param {any} balance */
export function availableTechs(player, balance) {
  return (balance.research ?? []).filter(
    (/** @type {any} */ tech) =>
      !player.tech?.[tech.id] &&
      (tech.requires ?? []).every((/** @type {string} */ id) => player.tech?.[id]) &&
      (!player.research || player.research.id !== tech.id),
  );
}

export const BRANCH_LABELS = {
  military: '军事',
  economy: '经济',
  expansion: '扩张',
};
