// @ts-check
/**
 * Match state helpers: spawns, players (human + simple AI) and snapshots.
 */

import { createRng, hashSeed } from './rng.js';

/**
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} continent
 * @param {number} count
 * @param {Set<number>} used
 * @returns {{ capital: number, cities: number[], continent: number } | null}
 */
export function pickSpawnOnContinent(map, continent, count, used) {
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
 * One free starting commander, assigned to the player's capital.
 * @param {any} balance
 * @param {number|string} seed
 * @param {number} playerIndex
 * @param {number} cityId
 */
function createStartingCommander(balance, seed, playerIndex, cityId) {
  const config = balance.commanders;
  if (!config) return null;
  const rng = createRng(hashSeed(`${seed}:commander:${playerIndex}`));
  return {
    id: 0,
    name: config.names[rng.int(0, config.names.length - 1)],
    trait: config.traits[rng.int(0, config.traits.length - 1)].id,
    level: 1,
    xp: 0,
    cityId,
  };
}

/**
 * Create a deterministic match state with a human player and AI opponents.
 * @param {import('./mapgen.js').GameMap} map
 * @param {any} balance
 * @param {{ seed?: number | string, playerName?: string, aiCount?: number, matchSeconds?: number, aiProfile?: any, mode?: 'timed' | 'endless' }} [options]
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
      research: null,
      betrayalUntil: 0,
      commanders: [
        createStartingCommander(balance, seed, index, spawns[index]?.cities[0] ?? null),
      ].filter(Boolean),
    }));

  /** @type {any[]} */
  const cities = map.cities.map((city) => {
    const special = balance.specialSites?.[city.special] ?? null;
    const garrison = special?.garrison ?? balance.neutralGarrison;
    return {
      id: city.id,
      owner: /** @type {number | null} */ (null),
      level: special?.level ?? 1,
      population: balance.startPopulation,
      garrison,
      units: { infantry: garrison, cavalry: 0, siege: 0 },
      buildings: [],
      special: city.special ?? null,
      focus: city.focus ?? null,
      focus: null,
      upgrading: null,
      terrain: city.terrain,
      continent: city.continent,
      neighbors: city.neighbors,
      seaNeighbors: city.seaNeighbors ?? [],
    };
  });

  spawns.forEach((spawn, playerId) => {
    if (!spawn) return;
    for (const id of spawn.cities) {
      cities[id].owner = playerId;
      cities[id].garrison = balance.startSoldiers;
      cities[id].units = { infantry: balance.startSoldiers, cavalry: 0, siege: 0 };
      cities[id].population = Math.max(cities[id].population, balance.startPopulation);
    }
  });

  return {
    seed,
    tick: 0,
    phase: 'playing',
    mode: options.mode ?? 'timed',
    matchSeconds: options.matchSeconds ?? balance.matchSeconds,
    aiProfile: options.aiProfile ?? null,
    wave: 0,
    nextEventTick: Math.round(((balance.worldEvents?.firstDelaySeconds ?? 75) * 1000) / balance.tickMs),
    nextWaveTick: Math.round(((balance.endless?.firstWaveSeconds ?? 45) * 1000) / balance.tickMs),
    spawnContinent: players[0]?.startContinent ?? 0,
    capital: humanSpawn?.capital ?? 0,
    rngState: hashSeed(`${seed}:match`),
    players,
    cities,
    armies: [],
    nextArmyId: 1,
    diplomacy: {},
    diplomacyRequests: [],
    diplomacyBlock: {},
    nextRequestId: 1,
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
    multiplayer: Boolean(state.multiplayer),
    mode: state.mode ?? 'timed',
    wave: state.wave ?? 0,
    nextWaveTick: state.nextWaveTick ?? 0,
    matchSeconds: state.matchSeconds,
    players: state.players.map((/** @type {any} */ player) => ({
      ...player,
      tech: { ...player.tech },
      research: player.research ? { ...player.research } : null,
    })),
    cities: state.cities.map((/** @type {any} */ city) => ({
      id: city.id,
      owner: city.owner,
      level: city.level,
      population: Math.floor(city.population),
      garrison: Math.floor(city.garrison),
      units: {
        infantry: Math.floor(city.units?.infantry ?? city.garrison ?? 0),
        cavalry: Math.floor(city.units?.cavalry ?? 0),
        siege: Math.floor(city.units?.siege ?? 0),
      },
      buildings: [...(city.buildings ?? [])],
      special: city.special ?? null,
      commanderId:
        city.owner === null
          ? null
          : ((state.players[city.owner]?.commanders ?? []).find(
              (/** @type {any} */ commander) => commander.cityId === city.id,
            )?.id ?? null),
      upgrading: city.upgrading ? { endsTick: city.upgrading.endsTick } : null,
    })),
    armies: state.armies.map((/** @type {any} */ army) => ({ ...army })),
    specialSites: (state.cities ?? [])
      .filter((/** @type {any} */ city) => city.special)
      .map((/** @type {any} */ city) => ({ cityId: city.id, type: city.special })),
    specialRequired: Math.ceil(
      ((state.cities ?? []).filter((/** @type {any} */ city) => city.special).length) *
        0.67,
    ),
    diplomacy: { ...(state.diplomacy ?? {}) },
    diplomacyRequests: [...(state.diplomacyRequests ?? [])],
    diplomacyBlock: { ...(state.diplomacyBlock ?? {}) },
    events: state.events,
    result: state.result,
  };
}
