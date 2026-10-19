// @ts-check
/**
 * Diplomacy relations: alliances, truces, betrayal penalty and requests.
 */

/** @param {number} a @param {number} b */
export function relationKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** @param {any} state @param {number} a @param {number} b */
export function getRelation(state, a, b) {
  return state.diplomacy?.[relationKey(a, b)] ?? null;
}

/** @param {any} state @param {number} a @param {number} b */
export function isFriendly(state, a, b) {
  if (a === b) return true;
  const relation = getRelation(state, a, b);
  if (!relation) return false;
  if (relation.status === 'ally') return true;
  if (relation.status === 'truce') return state.tick < (relation.untilTick ?? 0);
  return false;
}

/** @param {any} state @param {number} a @param {number} b @param {string} status @param {number} [untilTick] */
export function setRelation(state, a, b, status, untilTick = Infinity) {
  state.diplomacy = state.diplomacy ?? {};
  state.diplomacy[relationKey(a, b)] = { status, untilTick, sinceTick: state.tick };
}

/** @param {any} state @param {number} a @param {number} b */
export function removeRelation(state, a, b) {
  if (state.diplomacy) delete state.diplomacy[relationKey(a, b)];
}

/** @param {any} state @param {number} playerId */
export function countAllies(state, playerId) {
  let count = 0;
  for (const [key, relation] of Object.entries(state.diplomacy ?? {})) {
    if (relation.status !== 'ally') continue;
    const [a, b] = key.split(':').map(Number);
    if (a === playerId || b === playerId) count += 1;
  }
  return count;
}

/** @param {any} state @param {number} playerId @param {number} otherId */
export function relationLabel(state, playerId, otherId) {
  const relation = getRelation(state, playerId, otherId);
  if (!relation) return '中立';
  if (relation.status === 'ally') return '盟友';
  if (relation.status === 'truce') {
    return state.tick < (relation.untilTick ?? 0) ? '停战中' : '中立';
  }
  return '中立';
}

/** @param {any} state @param {number} playerId @param {number} targetId */
export function isBlocked(state, playerId, targetId) {
  const key = relationKey(playerId, targetId);
  const blockedUntil = state.diplomacyBlock?.[key] ?? 0;
  return state.tick < blockedUntil;
}
