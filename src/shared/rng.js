// @ts-check
/**
 * Deterministic seeded PRNG (mulberry32) plus seed helpers.
 * Every random stream in the game must come from here so a match can be
 * reproduced from its seed.
 */

/**
 * Stable 32-bit hash for a seed (FNV-1a).
 * @param {string | number} seed
 * @returns {number}
 */
export function hashSeed(seed) {
  const text = String(seed);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Derive an independent seed for a labelled sub-stream.
 * @param {string | number} seed
 * @param {string} label
 * @returns {number}
 */
export function deriveSeed(seed, label) {
  return hashSeed(`${seed}:${label}`);
}

/**
 * @typedef {Object} Rng
 * @property {() => number} next Float in [0, 1).
 * @property {(min: number, max: number) => number} range Float in [min, max).
 * @property {(min: number, max: number) => number} int Integer in [min, max] (inclusive).
 * @property {(probability: number) => boolean} chance
 * @property {<T>(items: T[]) => T} pick
 * @property {<T>(items: T[]) => T[]} shuffle
 */

/**
 * Create a deterministic random stream.
 * @param {string | number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = hashSeed(seed) || 1;

  /** @returns {number} */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /**
     * @param {number} min
     * @param {number} max
     */
    range(min, max) {
      return min + next() * (max - min);
    },
    /**
     * @param {number} min
     * @param {number} max
     */
    int(min, max) {
      return Math.min(max, Math.floor(min + next() * (max - min + 1)));
    },
    /**
     * @param {number} probability
     */
    chance(probability) {
      return next() < probability;
    },
    /**
     * @template T
     * @param {T[]} items
     * @returns {T}
     */
    pick(items) {
      return items[Math.floor(next() * items.length)];
    },
    /**
     * @template T
     * @param {T[]} items
     * @returns {T[]}
     */
    shuffle(items) {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

/**
 * Advance an in-state PRNG and return a float in [0, 1).
 * The owning object must contain a `rngState` uint32 field.
 * @param {{ rngState: number }} owner
 * @returns {number}
 */
export function nextStateRandom(owner) {
  owner.rngState = (owner.rngState + 0x6d2b79f5) >>> 0;
  let t = owner.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
