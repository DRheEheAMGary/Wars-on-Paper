#!/usr/bin/env node
/**
 * Multiplayer benchmark and drift checker.
 *
 * Starts an in-process authoritative server, connects N WebSocket clients,
 * plays a short match while issuing commands, then verifies that every client
 * saw identical snapshots for the same tick and reports latency statistics.
 *
 * Usage:
 *   node tools/bench.mjs                       # 16 players, 240 cities, 15s
 *   node tools/bench.mjs --players 32 --seconds 20
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { MultiplayerServer } from '../src/server/multiplayer.js';
import { generateMap } from '../src/shared/mapgen.js';
import { createMultiplayerMatch } from '../src/shared/multiplayer.js';
import { step } from '../src/shared/sim.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { players: 16, cities: 240, seconds: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--players' && next) {
      options.players = Math.min(32, Math.max(2, Number(next)));
      index += 1;
    } else if (arg === '--cities' && next) {
      options.cities = Number(next);
      index += 1;
    } else if (arg === '--seconds' && next) {
      options.seconds = Math.max(3, Number(next));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/bench.mjs [--players 16] [--cities 240] [--seconds 15]',
      );
      process.exit(0);
    }
  }
  return options;
}

/** @param {any} snapshot */
function hashSnapshot(snapshot) {
  let hash = 2166136261;
  const mix = (/** @type {number} */ value) => {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  for (const city of snapshot.cities) {
    mix(city.owner === null ? 0xffff : city.owner + 1);
    mix(Math.floor(city.garrison));
  }
  mix(snapshot.players.length);
  for (const player of snapshot.players) mix(player.cityCount);
  mix(snapshot.armies.length);
  return hash;
}

/** @param {number[]} values @param {number} ratio */
function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

/**
 * @param {string} url
 * @param {number} index
 */
function createClient(url, index) {
  const ws = new WebSocket(url);
  /** @type {any[]} */
  const queue = [];
  /** @type {any[]} */
  const waiters = [];
  /** @type {{ tick: number, hash: number, at: number }[]} */
  const snapshots = [];
  /** @type {number[]} */
  const latencies = [];
  /** @type {{ cityId: number, before: number, sentAt: number }[]} */
  const pending = [];
  /** @type {any} */
  let latest = null;

  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'snapshot') {
      const snapshot = message.snapshot;
      latest = snapshot;
      snapshots.push({
        tick: snapshot.tick,
        hash: hashSnapshot(snapshot),
        at: performance.now(),
      });
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i];
        const city = snapshot.cities[entry.cityId];
        if (city && city.garrison !== entry.before) {
          latencies.push(performance.now() - entry.sentAt);
          pending.splice(i, 1);
        }
      }
    }
    queue.push(message);
    for (let i = 0; i < waiters.length; i += 1) {
      const found = queue.findIndex(waiters[i].predicate);
      if (found >= 0) {
        const [value] = queue.splice(found, 1);
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(value);
        i -= 1;
      }
    }
  });

  return {
    index,
    ws,
    latest: () => latest,
    snapshots,
    latencies,
    pending,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(/** @type {any} */ message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    waitFor(/** @type {(message: any) => boolean} */ predicate, timeout = 8000) {
      const found = queue.findIndex(predicate);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`client ${index}: timed out waiting`)),
          timeout,
        );
        waiters.push({ predicate, timer, resolve });
      });
    },
    close() {
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    },
  };
}

const options = parseArgs(process.argv.slice(2));
const playerCount = Math.min(32, options.players);

const server = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});
const multiplayer = new MultiplayerServer({ log: () => {} }).attach(server, '/ws');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address !== 'object') throw new Error('no server address');
const url = `ws://127.0.0.1:${address.port}/ws`;

console.log(
  `bench: ${playerCount} players, ${options.cities} cities, ${options.seconds}s match window`,
);

/** @type {ReturnType<typeof createClient>[]} */
const clients = [];
let passed = false;

try {
  for (let index = 0; index < playerCount; index += 1) clients.push(createClient(url, index));
  await Promise.all(clients.map((client) => client.opened));
  await Promise.all(clients.map((client) => client.waitFor((message) => message.type === 'hello')));

  const tokens = [];
  for (const client of clients) {
    client.send({ type: 'hello', name: `bench-${client.index}` });
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    tokens.push(welcome.token);
  }

  const host = clients[0];
  host.send({
    type: 'create',
    config: {
      cityCount: options.cities,
      matchSeconds: 600,
      maxPlayers: Math.max(2, Math.min(32, playerCount)),
    },
  });
  const created = await host.waitFor((message) => message.type === 'room');
  const code = created.room.code;

  for (const client of clients.slice(1)) {
    client.send({ type: 'join', code });
  }
  await Promise.all(
    clients
      .slice(1)
      .map((client) => client.waitFor((message) => message.type === 'room')),
  );

  host.send({ type: 'start' });
  const starts = await Promise.all(
    clients.map((client) => client.waitFor((message) => message.type === 'started')),
  );
  const map = starts[0].map;
  const playerIds = starts.map((started) => started.playerId);
  if (new Set(playerIds).size !== clients.length) {
    throw new Error('player ids are not unique');
  }
  console.log(`started room ${code} with ${clients.length} players, ${map.cities.length} cities`);

  const commandTimer = setInterval(() => {
    for (const client of clients) {
      const snapshot = client.latest();
      if (!snapshot || snapshot.phase !== 'playing') continue;
      const playerId = playerIds[client.index];
      const player = snapshot.players[playerId];
      const owned = snapshot.cities.find((city) => city.owner === playerId);
      if (!player || !owned) continue;
      if (player.gold >= 120) {
        client.send({ type: 'command', command: { type: 'recruit', cityId: owned.id } });
        client.pending.push({
          cityId: owned.id,
          before: owned.garrison,
          sentAt: performance.now(),
        });
      }
      const mapCity = map.cities[owned.id];
      const target = mapCity.neighbors.find(
        (neighbour) => snapshot.cities[neighbour].owner !== playerId,
      );
      if (target !== undefined && owned.garrison > 30) {
        client.send({
          type: 'command',
          command: {
            type: 'deploy',
            fromCity: owned.id,
            toCity: target,
            soldiers: Math.floor(owned.garrison / 2),
          },
        });
      }
    }
  }, 450);

  const startedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));
  clearInterval(commandTimer);

  const elapsed = (performance.now() - startedAt) / 1000;
  const lastSnapshots = clients.map((client) => client.snapshots.at(-1));
  const maxTick = Math.max(...lastSnapshots.map((snapshot) => snapshot?.tick ?? 0));

  // Drift: for every tick reported by every client, hashes must agree.
  /** @type {Map<number, Set<number>>} */
  const hashesByTick = new Map();
  for (const client of clients) {
    for (const entry of client.snapshots) {
      const set = hashesByTick.get(entry.tick) ?? new Set();
      set.add(entry.hash);
      hashesByTick.set(entry.tick, set);
    }
  }
  let alignedTicks = 0;
  let driftTicks = 0;
  for (const hashes of hashesByTick.values()) {
    if (hashes.size === 1) alignedTicks += 1;
    else driftTicks += 1;
  }

  // Snapshot cadence.
  const intervals = [];
  const reference = clients[0].snapshots;
  for (let index = 1; index < reference.length; index += 1) {
    intervals.push(reference[index].at - reference[index - 1].at);
  }
  const intervalP50 = percentile(intervals, 0.5);
  const intervalP95 = percentile(intervals, 0.95);

  const latencies = clients.flatMap((client) => client.latencies);
  const latencyP95 = percentile(latencies, 0.95);

  // Captures prove command validation and combat flow under load.
  const firstSnapshot = clients[0].snapshots[0];
  const initialOwners = new Map(
    (starts[0].snapshot.cities ?? []).map((city) => [city.id, city.owner]),
  );
  const lastSnapshot = lastSnapshots[0];
  const finalSnapshot = lastSnapshot ?? null;
  // Use the latest full snapshot from any client for ownership change counts.
  const latestFull = clients.find((client) => client.latest())?.latest();
  let ownerChanges = 0;
  if (latestFull) {
    for (const city of latestFull.cities) {
      if (initialOwners.has(city.id) && initialOwners.get(city.id) !== city.owner) {
        ownerChanges += 1;
      }
    }
  }

  // Standalone simulation tick performance for the same player/city load.
  const simMap = generateMap({ seed: latestFull?.seed ?? 42, cityCount: options.cities });
  const simState = createMultiplayerMatch(
    simMap,
    balance,
    Array.from({ length: playerCount }, (_, index) => ({
      id: index,
      name: `bench-${index}`,
    })),
    { matchSeconds: 600 },
  );
  const tickDurations = [];
  for (let tick = 0; tick < 600; tick += 1) {
    const started = performance.now();
    step(simState, balance, []);
    tickDurations.push(performance.now() - started);
  }
  const simP95 = percentile(tickDurations, 0.95);

  console.log(`observed ticks: ${maxTick} (${alignedTicks} aligned, ${driftTicks} drifting)`);
  console.log(
    `snapshot interval: p50 ${intervalP50.toFixed(1)}ms, p95 ${intervalP95.toFixed(1)}ms`,
  );
  console.log(
    `command latency: p95 ${latencyP95.toFixed(1)}ms (${latencies.length} samples)`,
  );
  console.log(`owner changes (captures): ${ownerChanges}`);
  console.log(`sim tick p95: ${simP95.toFixed(3)}ms (${playerCount}p / ${options.cities} cities)`);

  passed =
    maxTick > (options.seconds * 1000 * 0.6) / balance.tickMs &&
    driftTicks === 0 &&
    intervalP95 < 300 &&
    simP95 < 2 &&
    latencies.length > 0 &&
    ownerChanges > 0;
  console.log(passed ? 'RESULT: PASS' : 'RESULT: FAIL');
  clients.forEach((client) => client.close());
} catch (error) {
  console.log('RESULT: FAIL', error instanceof Error ? error.message : error);
} finally {
  multiplayer.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  process.exitCode = passed ? 0 : 1;
}
