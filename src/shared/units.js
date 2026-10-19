// @ts-check
/**
 * Unit composition helpers. Cities and armies store three unit counts plus a
 * `garrison`/`soldiers` total for backwards compatibility with older systems.
 */

export const UNIT_ORDER = /** @type {const} */ (['infantry', 'cavalry', 'siege']);

/** @returns {{ infantry: number, cavalry: number, siege: number }} */
export function emptyUnits() {
  return { infantry: 0, cavalry: 0, siege: 0 };
}

/**
 * @param {any} source
 * @returns {{ infantry: number, cavalry: number, siege: number }}
 */
export function normalizeUnits(source) {
  return {
    infantry: Math.max(0, Math.floor(source?.infantry ?? 0)),
    cavalry: Math.max(0, Math.floor(source?.cavalry ?? 0)),
    siege: Math.max(0, Math.floor(source?.siege ?? 0)),
  };
}

/** @param {any} units */
export function totalUnits(units) {
  return (
    Math.max(0, Math.floor(units?.infantry ?? 0)) +
    Math.max(0, Math.floor(units?.cavalry ?? 0)) +
    Math.max(0, Math.floor(units?.siege ?? 0))
  );
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {{ infantry: number, cavalry: number, siege: number }}
 */
export function mergeUnits(a, b) {
  return {
    infantry: Math.max(0, Math.floor(a?.infantry ?? 0)) + Math.max(0, Math.floor(b?.infantry ?? 0)),
    cavalry: Math.max(0, Math.floor(a?.cavalry ?? 0)) + Math.max(0, Math.floor(b?.cavalry ?? 0)),
    siege: Math.max(0, Math.floor(a?.siege ?? 0)) + Math.max(0, Math.floor(b?.siege ?? 0)),
  };
}

/**
 * Take `amount` units out of a composition, proportional to its makeup.
 * Returns the removed units and what stays behind.
 * @param {any} units
 * @param {number} amount
 * @returns {{ taken: any, remaining: any }}
 */
export function splitUnits(units, amount) {
  const source = normalizeUnits(units);
  const total = totalUnits(source);
  const requested = Math.max(0, Math.min(Math.floor(amount), total));
  const empty = emptyUnits();
  if (requested === 0) return { taken: empty, remaining: source };
  if (requested >= total) return { taken: source, remaining: empty };

  /** @type {Record<string, { type: string, base: number, frac: number }>} */
  const shares = {};
  let allocated = 0;
  for (const type of UNIT_ORDER) {
    const raw = (source[type] * requested) / total;
    const base = Math.floor(raw);
    shares[type] = { type, base, frac: raw - base };
    allocated += base;
  }
  let extra = requested - allocated;
  const order = UNIT_ORDER.map((type) => shares[type]).sort(
    (a, b) => b.frac - a.frac || UNIT_ORDER.indexOf(a.type) - UNIT_ORDER.indexOf(b.type),
  );
  for (const entry of order) {
    if (extra <= 0) break;
    if (shares[entry.type].base < source[entry.type]) {
      shares[entry.type].base += 1;
      extra -= 1;
    }
  }

  /** @type {any} */
  const taken = emptyUnits();
  for (const type of UNIT_ORDER) taken[type] = shares[type].base;
  const remaining = {
    infantry: source.infantry - taken.infantry,
    cavalry: source.cavalry - taken.cavalry,
    siege: source.siege - taken.siege,
  };
  return { taken, remaining };
}

/**
 * Remove `amount` units proportionally (used for casualties and starvation).
 * @param {any} units
 * @param {number} amount
 * @returns {{ removed: any, remaining: any }}
 */
export function removeUnits(units, amount) {
  return splitUnits(units, Math.max(0, Math.min(Math.floor(amount), totalUnits(units))));
}

/**
 * Sync a city's `garrison` total from its `units` composition.
 * @param {any} city
 */
export function syncCityGarrison(city) {
  city.garrison = totalUnits(city.units);
}

/**
 * Fill in unit composition for legacy states/tests that only set `garrison`.
 * @param {any} city
 * @returns {any}
 */
export function ensureCityUnits(city) {
  if (!city.units) {
    city.units = { infantry: Math.max(0, Math.floor(city.garrison ?? 0)), cavalry: 0, siege: 0 };
  }
  city.units = normalizeUnits(city.units);
  city.garrison = totalUnits(city.units);
  return city.units;
}

/**
 * Slowest unit in the composition decides march time.
 * @param {any} units
 * @param {any} balance
 * @returns {number}
 */
export function unitTravelSeconds(units, balance) {
  let seconds = balance.soldierTravelSeconds ?? 4;
  for (const type of UNIT_ORDER) {
    if ((units?.[type] ?? 0) > 0) {
      seconds = Math.max(seconds, balance.units?.[type]?.travelSeconds ?? seconds);
    }
  }
  return seconds;
}

/**
 * @param {any} units
 * @param {any} balance
 * @returns {string}
 */
export function compositionText(units, balance) {
  const parts = [];
  for (const type of UNIT_ORDER) {
    const count = Math.floor(units?.[type] ?? 0);
    if (count > 0) parts.push(`${balance.units?.[type]?.name ?? type} ${count}`);
  }
  return parts.join(' · ');
}
