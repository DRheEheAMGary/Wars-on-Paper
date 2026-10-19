// @ts-check
/**
 * Match state helpers for the single-player core loop (M2).
 * The state is plain serialisable data; rendering data stays in `state.map`.
 */

import { hashSeed } from './rng.js';

/**
 * @typedef {{ id: number, owner: number | null, level: number, population: number, garrison: number, upgrading: { endsTick: number } | null }} CityState
 * @typedef {{ id: number, owner: number, fromCity: number, toCity: number, soldiers: number, departTick: number, arriveTick: number }} ArmyState
 * @typedef {{ id: number, name: string, color: string, gold: number, food: number, score: number, kills: number, cityCount: number, startContinent: number }} PlayerState
 */

/**
 * Pick the spawn continent: the largest one; capital = its most connected city.
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} spawnCities
 * @returns {{ capital: number, cities: number[], continent: number }}
 */
function pickSpawn(map, spawnCities) {
  /** @type {Map<number, number[]>} */
  const byContinent = new Map();
  for (const city of map.cities) {
    const list = byContinent.get(city.continent) ?? [];
    list.push(city.id);
    byContinent.set(city.continent, list);
  }

  let bestContinent = 0;
  let bestSize = -1;
  for (const [continent, ids] of byContinent) {
    if (ids.length > bestSize) {
      bestSize = ids.length;
      bestContinent = continent;
    }
  }
  const continentIds = byContinent.get(bestContinent) ?? [];

  let capital = continentIds[0] ?? 0;
  let bestNeighbours = -1;
  for (const id of continentIds) {
    const degree = map.cities[id].neighbors.length;
    if (degree > bestNeighbours) {
      bestNeighbours = degree;
      capital = id;
    }
  }

  const chosen = [capital];
  const queue = [...map.cities[capital].neighbors];
  while (chosen.length < spawnCities && queue.length > 0) {
    const id = /** @type {number} */ (queue.shift());
    if (chosen.includes(id)) continue;
    chosen.push(id);
    for (const neighbour of map.cities[id].neighbors) {
      if (!chosen.includes(neighbour)) queue.push(neighbour);
    }
  }

  return { capital, cities: chosen, continent: bestContinent };
}

/**
 * Create a deterministic match state on a generated map.
 * @param {import('./mapgen.js').GameMap} map
 * @param {any} balance
 * @param {{ seed?: number | string, playerName?: string }} [options]
 * @returns {any}
 */
export function createMatch(map, balance, options = {}) {
  const seed = options.seed ?? map.seed;
  const spawn = pickSpawn(map, balance.spawnCities);

  /** @type {CityState[]} */
  const cities = map.cities.map((city) => ({
    id: city.id,
    owner: /** @type {number | null} */ (null),
    level: 1,
    population: balance.startPopulation,
    garrison: balance.neutralGarrison,
    upgrading: null,
    terrain: city.terrain,
    continent: city.continent,
    neighbors: city.neighbors,
  }));

  for (const id of spawn.cities) {
    cities[id].owner = 0;
    cities[id].garrison = balance.startSoldiers;
    cities[id].population = Math.max(cities[id].population, balance.startPopulation);
  }

  /** @type {PlayerState[]} */
  const players = [
    {
      id: 0,
      name: options.playerName ?? '指挥官',
      color: '#d24a35',
      gold: balance.startGold,
      food: balance.startFood,
      score: 0,
      kills: 0,
      cityCount: spawn.cities.length,
      startContinent: spawn.continent,
    },
  ];

  return {
    seed,
    tick: 0,
    phase: 'playing',
    matchSeconds: balance.matchSeconds,
    spawnContinent: spawn.continent,
    capital: spawn.capital,
    rngState: hashSeed(`${seed}:match`),
    players,
    cities,
    armies: [],
    nextArmyId: 1,
    events: [],
    result: null,
  };
}

/**
 * Minimal snapshot sent from the simulation worker to the renderer.
 * @param {any} state
 * @returns {any}
 */
export function snapshot(state) {
  return {
    tick: state.tick,
    phase: state.phase,
    matchSeconds: state.matchSeconds,
    players: state.players.map((/** @type {PlayerState} */ player) => ({ ...player })),
    cities: state.cities.map((/** @type {CityState} */ city) => ({
      id: city.id,
      owner: city.owner,
      level: city.level,
      population: Math.floor(city.population),
      garrison: Math.floor(city.garrison),
      upgrading: city.upgrading ? { endsTick: city.upgrading.endsTick } : null,
    })),
    armies: state.armies.map((/** @type {ArmyState} */ army) => ({ ...army })),
    events: state.events,
    result: state.result,
  };
}
