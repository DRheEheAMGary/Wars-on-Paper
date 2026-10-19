// @ts-check
/**
 * Match state helpers: spawns, players (human + simple AI) and snapshots.
 */

import { hashSeed } from './rng.js';

/**
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} continent
 * @param {number} count
 * @param {Set<number>} used
 * @returns {{ capital: number, cities: number[], continent: number } | null}
 */
function pickSpawnOnContinent(map, continent, count, used) {
  const candidates = map.cities.filter(
    (city) => city.continent === continent && !used.has(city.id),
  );
  if (candidates.length === 0) return null;

  let capital = candidates[0].id;
  let bestDegree = -1;
  for (const city of candidates) {
    if (city.neighbors.length > bestDegree) {
      bestDegree = city.neighbors.length;
      capital = city.id;
    }
  }

  const chosen = [capital];
  used.add(capital);
  const queue = [...map.cities[capital].neighbors];
  while (chosen.length < count && queue.length > 0) {
    const id = /** @type {number} */ (queue.shift());
    if (used.has(id) || map.cities[id].continent !== continent) continue;
    chosen.push(id);
    used.add(id);
    for (const neighbour of map.cities[id].neighbors) {
      if (!used.has(neighbour) && map.cities[neighbour].continent === continent) {
        queue.push(neighbour);
      }
    }
  }

  return { capital, cities: chosen, continent };
}

/**
 * Create a deterministic match state with a human player and AI opponents.
 * @param {import('./mapgen.js').GameMap} map
 * @param {any} balance
 * @param {{ seed?: number | string, playerName?: string, aiCount?: number, matchSeconds?: number, aiProfile?: any }} [options]
 * @returns {any}
 */
export function createMatch(map, balance, options = {}) {
  const seed = options.seed ?? map.seed;

  /** @type {Map<number, number[]>} */
  const groups = new Map();
  for (const city of map.cities) {
    const list = groups.get(city.continent) ?? [];
    list.push(city.id);
    groups.set(city.continent, list);
  }
  const continents = [...groups.keys()].sort(
    (a, b) => (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) || a - b,
  );

  const used = new Set();
  const spawns = [];
  const humanSpawn = pickSpawnOnContinent(
    map,
    continents[0] ?? 0,
    balance.spawnCities,
    used,
  );
  spawns.push(humanSpawn);

  const requestedAI = options.aiCount ?? balance.ai.count ?? 1;
  const maxAI = Math.min(3, Math.max(0, continents.length + (continents.length === 1 ? 1 : 0)));
  const aiCount = Math.min(requestedAI, maxAI);
  for (let index = 0; index < aiCount; index += 1) {
    const continent = continents[(index + 1) % Math.max(1, continents.length)];
    const spawn = pickSpawnOnContinent(map, continent, balance.spawnCities, used);
    if (spawn) spawns.push(spawn);
  }

  const colors = balance.playerColors ?? ['#d24a35', '#2f6f9f', '#c98a2e', '#4f8a5b'];
  const names = ['指挥官', '蓝方', '黄方', '绿方'];

  /** @type {any[]} */
  const players = spawns
    .filter((spawn) => spawn !== null && spawn.cities.length > 0)
    .map((spawn, index) => ({
      id: index,
      name: index === 0 ? options.playerName ?? '指挥官' : names[index] ?? `敌方${index}`,
      color: colors[index % colors.length],
      gold: balance.startGold,
      food: balance.startFood,
      score: 0,
      kills: 0,
      cityCount: spawn.cities.length,
      startContinent: spawn.continent,
      isAI: index > 0,
      tech: {},
    }));

  /** @type {any[]} */
  const cities = map.cities.map((city) => ({
    id: city.id,
    owner: null,
    level: 1,
    population: balance.startPopulation,
    garrison: balance.neutralGarrison,
    upgrading: null,
    terrain: city.terrain,
    continent: city.continent,
    neighbors: city.neighbors,
    seaNeighbors: city.seaNeighbors ?? [],
  }));

  spawns.forEach((spawn, playerId) => {
    if (!spawn) return;
    for (const id of spawn.cities) {
      cities[id].owner = playerId;
      cities[id].garrison = balance.startSoldiers;
      cities[id].population = Math.max(cities[id].population, balance.startPopulation);
    }
  });

  return {
    seed,
    tick: 0,
    phase: 'playing',
    matchSeconds: options.matchSeconds ?? balance.matchSeconds,
    aiProfile: options.aiProfile ?? null,
    spawnContinent: players[0]?.startContinent ?? 0,
    capital: humanSpawn?.capital ?? 0,
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
    players: state.players.map((/** @type {any} */ player) => ({
      ...player,
      tech: { ...player.tech },
    })),
    cities: state.cities.map((/** @type {any} */ city) => ({
      id: city.id,
      owner: city.owner,
      level: city.level,
      population: Math.floor(city.population),
      garrison: Math.floor(city.garrison),
      upgrading: city.upgrading ? { endsTick: city.upgrading.endsTick } : null,
    })),
    armies: state.armies.map((/** @type {any} */ army) => ({ ...army })),
    events: state.events,
    result: state.result,
  };
}
