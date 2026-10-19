// @ts-check
/**
 * Multiplayer match construction and room configuration shared by the server
 * and its tests.
 */

import { hashSeed } from './rng.js';
import { pickSpawnOnContinent, snapshot } from './match.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_ROOM_CONFIG = {
  cityCount: 240,
  matchSeconds: 600,
  maxPlayers: 32,
};
export const CITY_COUNT_OPTIONS = [60, 100, 160, 240, 360];
export const MATCH_LENGTH_OPTIONS = [300, 600, 900, 1200];
export const MAX_PLAYERS_OPTIONS = [2, 4, 8, 16, 32];

/** @param {number} count */
export function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

/**
 * @param {any} input
 * @returns {{ cityCount: number, matchSeconds: number, maxPlayers: number }}
 */
export function normalizeRoomConfig(input = {}) {
  const cityCount = CITY_COUNT_OPTIONS.includes(Number(input.cityCount))
    ? Number(input.cityCount)
    : DEFAULT_ROOM_CONFIG.cityCount;
  const matchSeconds = MATCH_LENGTH_OPTIONS.includes(Number(input.matchSeconds))
    ? Number(input.matchSeconds)
    : DEFAULT_ROOM_CONFIG.matchSeconds;
  const maxPlayers = MAX_PLAYERS_OPTIONS.includes(Number(input.maxPlayers))
    ? Number(input.maxPlayers)
    : DEFAULT_ROOM_CONFIG.maxPlayers;
  return { cityCount, matchSeconds, maxPlayers };
}

/**
 * Distinct player colours, generated when the fixed palette runs out.
 * @param {number} count
 * @param {string[]} palette
 * @returns {string[]}
 */
function playerColors(count, palette) {
  /** @type {string[]} */
  const colors = [];
  for (let index = 0; index < count; index += 1) {
    if (index < palette.length) {
      colors.push(palette[index]);
    } else {
      colors.push(`hsl(${Math.round((index * 137.508) % 360)} 60% 48%)`);
    }
  }
  return colors;
}

/**
 * Create a server-authoritative multiplayer match with one spawned cluster per
 * player. No AI opponents are added.
 * @param {import('./mapgen.js').GameMap} map
 * @param {any} balance
 * @param {{ id: number, name: string, token?: string }[]} playerInfos
 * @param {{ seed?: number | string, matchSeconds?: number }} [options]
 * @returns {any}
 */
export function createMultiplayerMatch(map, balance, playerInfos, options = {}) {
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
  for (let index = 0; index < playerInfos.length; index += 1) {
    let spawn = null;
    for (let attempt = 0; attempt < continents.length; attempt += 1) {
      const continent = continents[(index + attempt) % continents.length];
      const candidate = pickSpawnOnContinent(
        map,
        continent,
        balance.spawnCities,
        used,
      );
      if (candidate && candidate.cities.length > 1) {
        spawn = candidate;
        break;
      }
    }
    spawns.push(spawn);
  }

  const palette = balance.playerColors ?? ['#d24a35', '#2f6f9f', '#c98a2e', '#4f8a5b'];
  const colors = playerColors(playerInfos.length, palette);

  /** @type {any[]} */
  const players = playerInfos.map((info, index) => ({
    id: index,
    name: info.name || `玩家${index + 1}`,
    color: colors[index],
    token: info.token ?? '',
    gold: balance.startGold,
    food: balance.startFood,
    score: 0,
    kills: 0,
    cityCount: spawns[index]?.cities.length ?? 0,
    startContinent: spawns[index]?.continent ?? 0,
    isAI: false,
    alive: true,
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
    multiplayer: true,
    matchSeconds: options.matchSeconds ?? balance.matchSeconds,
    spawnContinent: players[0]?.startContinent ?? 0,
    capital: spawns[0]?.capital ?? 0,
    rngState: hashSeed(`${seed}:multiplayer`),
    players,
    cities,
    armies: [],
    nextArmyId: 1,
    events: [],
    result: null,
  };
}

/**
 * Add a late-joining player: claim an unowned cluster far from existing players
 * and grant the 1.5x resource bonus described by the design.
 * @param {any} state
 * @param {any} balance
 * @param {import('./mapgen.js').GameMap} map
 * @param {{ name: string, token?: string, color?: string }} info
 * @returns {{ playerId: number, capital: number } | null}
 */
export function addLatePlayer(state, balance, map, info) {
  /** @type {number[]} */
  const ownedCenters = [];
  for (const city of state.cities) {
    if (city.owner !== null) ownedCenters.push(city.id);
  }

  /** @type {{ id: number, distance: number } | null} */
  let best = null;
  for (const city of map.cities) {
    if (state.cities[city.id].owner !== null) continue;
    let nearest = Infinity;
    for (const ownedId of ownedCenters) {
      const owned = map.cities[ownedId];
      const distance = Math.hypot(
        owned.center[0] - city.center[0],
        owned.center[1] - city.center[1],
      );
      if (distance < nearest) nearest = distance;
    }
    if (!best || nearest > best.distance) best = { id: city.id, distance: nearest };
  }
  if (!best) return null;

  const used = new Set();
  for (const city of state.cities) if (city.owner !== null) used.add(city.id);
  const continent = map.cities[best.id].continent;
  const spawn = pickSpawnOnContinent(map, continent, balance.spawnCities, used);
  if (!spawn) return null;

  const playerId = state.players.length;
  const palette = balance.playerColors ?? ['#d24a35', '#2f6f9f', '#c98a2e', '#4f8a5b'];
  state.players.push({
    id: playerId,
    name: info.name || `玩家${playerId + 1}`,
    color: info.color ?? playerColors(playerId + 1, palette)[playerId],
    token: info.token ?? '',
    gold: balance.startGold * 1.5,
    food: balance.startFood * 1.5,
    score: 0,
    kills: 0,
    cityCount: spawn.cities.length,
    startContinent: spawn.continent,
    isAI: false,
    alive: true,
    tech: {},
  });

  for (const id of spawn.cities) {
    state.cities[id].owner = playerId;
    state.cities[id].garrison = balance.startSoldiers;
    state.cities[id].population = Math.max(
      state.cities[id].population,
      balance.startPopulation,
    );
  }

  return { playerId, capital: spawn.capital };
}

/** @param {any} state */
export function multiplayerSnapshot(state) {
  return snapshot(state);
}
