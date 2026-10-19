import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { generateMap } from '../src/shared/mapgen.js';
import { step } from '../src/shared/sim.js';
import {
  DEFAULT_ROOM_CONFIG,
  addLatePlayer,
  createMultiplayerMatch,
  normalizeRoomConfig,
} from '../src/shared/multiplayer.js';
import { MultiplayerServer } from '../src/server/multiplayer.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 11, cityCount: 100 });

test('multiplayer match spawns a connected cluster for every player', () => {
  const players = [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
    { id: 2, name: 'C' },
    { id: 3, name: 'D' },
  ];
  const state = createMultiplayerMatch(map, balance, players);
  assert.equal(state.players.length, 4);
  assert.equal(new Set(state.players.map((player) => player.color)).size, 4);

  let ownedTotal = 0;
  for (const player of state.players) {
    const owned = state.cities.filter((city) => city.owner === player.id);
    assert.ok(owned.length >= 2);
    assert.equal(owned.length, player.cityCount);
    ownedTotal += owned.length;

    const members = new Set(owned.map((city) => city.id));
    const seen = new Set([owned[0].id]);
    const stack = [owned[0].id];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const neighbour of state.cities[current].neighbors) {
        if (members.has(neighbour) && !seen.has(neighbour)) {
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
    assert.equal(seen.size, owned.length, 'spawn cluster must be connected');
  }
  assert.equal(
    ownedTotal,
    state.cities.filter((city) => city.owner !== null).length,
  );
});

test('late joiners receive cities and the 1.5x resource bonus', () => {
  const state = createMultiplayerMatch(map, balance, [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
  ]);
  const before = state.players.length;
  const joined = addLatePlayer(state, balance, map, { name: 'C' });
  assert.ok(joined);
  assert.equal(state.players.length, before + 1);
  const player = state.players[joined.playerId];
  assert.equal(player.gold, balance.startGold * 1.5);
  assert.equal(player.food, balance.startFood * 1.5);
  assert.equal(
    state.cities.filter((city) => city.owner === joined.playerId).length,
    player.cityCount,
  );
});

test('multiplayer match ends when one player owns every city', () => {
  const state = createMultiplayerMatch(map, balance, [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
  ]);
  for (const city of state.cities) city.owner = 1;
  step(state, balance, []);
  assert.equal(state.phase, 'ended');
  assert.equal(state.result.outcome, 'victory');
  assert.equal(state.result.winner, 1);
});

test('rooms can be created in endless mode', () => {
  assert.equal(normalizeRoomConfig({ mode: 'endless' }).mode, 'endless');
  assert.equal(normalizeRoomConfig({ mode: 'timed' }).mode, 'timed');
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }, { id: 1, name: 'B' }],
    { mode: 'endless' },
  );
  assert.equal(state.mode, 'endless');
  assert.equal(state.nextWaveTick, undefined);
});

test('multiplayer endless ends when only one player has cities', () => {
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }, { id: 1, name: 'B' }],
    { mode: 'endless' },
  );
  for (const city of state.cities) if (city.owner === 1) city.owner = null;
  step(state, balance, []);
  assert.equal(state.phase, 'ended');
  assert.equal(state.result.outcome, 'victory');
  assert.equal(state.result.winner, 0);
});

test('multiplayer rooms schedule world events', () => {
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }, { id: 1, name: 'B' }],
    {},
  );
  assert.ok(state.nextEventTick > 0);
  state.tick = state.nextEventTick - 1;
  step(state, balance, []);
  assert.ok(state.events.some((event) => event.type === 'worldEvent'));
});

test('solo endless test rooms do not end instantly', () => {
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }],
    { mode: 'endless' },
  );
  step(state, balance, []);
  assert.notEqual(state.phase, 'ended');
});

test('room config falls back to defaults for invalid values', () => {
  assert.deepEqual(
    normalizeRoomConfig({ cityCount: 120, matchSeconds: 60, maxPlayers: 3 }),
    DEFAULT_ROOM_CONFIG,
  );
  assert.deepEqual(
    normalizeRoomConfig({ cityCount: 240, matchSeconds: 900, maxPlayers: 16 }),
    { cityCount: 240, matchSeconds: 900, maxPlayers: 16, mode: 'timed' },
  );
});

/** @param {string} url */
function connectClient(url) {
  const ws = new WebSocket(url);
  /** @type {any[]} */
  const queue = [];
  /** @type {any[]} */
  const waiters = [];
  ws.on('message', (raw) => {
    queue.push(JSON.parse(String(raw)));
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const found = queue.findIndex(waiter.predicate);
      if (found >= 0) {
        const [message] = queue.splice(found, 1);
        waiters.splice(index, 1);
        index -= 1;
        waiter.resolve(message);
      }
    }
  });
  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(message) {
      ws.send(JSON.stringify(message));
    },
    /** @param {(message: any) => boolean} predicate @param {number} timeout */
    waitFor(predicate, timeout = 4000) {
      const found = queue.findIndex(predicate);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for server message'));
        }, timeout);
        waiters.push({
          predicate,
          timer,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

test('two clients play, then a reconnect restores the same player and state', { timeout: 25_000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const multiplayer = new MultiplayerServer({ log: () => {} }).attach(server, '/ws');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const alpha = connectClient(url);
  const beta = connectClient(url);
  /** @type {ReturnType<typeof connectClient> | null} */
  let reconnected = null;
  try {
    await alpha.opened;
    await beta.opened;
    await alpha.waitFor((message) => message.type === 'hello');
    await beta.waitFor((message) => message.type === 'hello');

    alpha.send({ type: 'hello', name: 'Alpha' });
    const alphaWelcome = await alpha.waitFor((message) => message.type === 'welcome');
    beta.send({ type: 'hello', name: 'Beta' });
    await beta.waitFor((message) => message.type === 'welcome');

    alpha.send({
      type: 'create',
      config: { cityCount: 100, matchSeconds: 300, maxPlayers: 8 },
    });
    const created = await alpha.waitFor((message) => message.type === 'room');
    const code = created.room.code;
    assert.equal(created.room.playerCount, 1);

    beta.send({ type: 'join', code });
    await beta.waitFor((message) => message.type === 'room' && message.room.code === code);

    alpha.send({ type: 'start' });
    const alphaStart = await alpha.waitFor((message) => message.type === 'started');
    const betaStart = await beta.waitFor((message) => message.type === 'started');
    assert.equal(alphaStart.map.cities.length, 100);
    assert.equal(alphaStart.snapshot.players.length, 2);
    assert.equal(alphaStart.snapshot.multiplayer, true);
    assert.notEqual(alphaStart.playerId, betaStart.playerId);

    const cityId = alphaStart.snapshot.cities.find(
      (city) => city.owner === alphaStart.playerId,
    ).id;
    const garrisonBefore = alphaStart.snapshot.cities[cityId].garrison;
    alpha.send({ type: 'command', command: { type: 'recruit', cityId } });
    const afterRecruit = await alpha.waitFor(
      (message) =>
        message.type === 'snapshot' &&
        message.snapshot.cities[cityId].garrison > garrisonBefore,
    );
    assert.ok(afterRecruit.snapshot.cities[cityId].garrison >= garrisonBefore + 10);

    alpha.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    reconnected = connectClient(url);
    await reconnected.opened;
    await reconnected.waitFor((message) => message.type === 'hello');
    reconnected.send({ type: 'hello', name: 'Alpha', token: alphaWelcome.token });
    const welcomeAgain = await reconnected.waitFor(
      (message) => message.type === 'welcome',
    );
    assert.equal(welcomeAgain.token, alphaWelcome.token);
    const resumed = await reconnected.waitFor((message) => message.type === 'started');
    assert.equal(resumed.playerId, alphaStart.playerId);
    assert.ok(resumed.snapshot.tick >= afterRecruit.snapshot.tick);
    assert.equal(resumed.map.cities.length, 100);

    reconnected.close();
    beta.close();
  } finally {
    for (const client of [alpha, beta, reconnected]) {
      try {
        client?.ws.terminate();
      } catch {
        // already closed
      }
    }
    multiplayer.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('32 players each spawn with three cities on standard maps', () => {
  const players = Array.from({ length: 32 }, (_, index) => ({
    id: index,
    name: `P${index}`,
  }));
  for (const cityCount of [160, 240]) {
    const bigMap = generateMap({ seed: 42, cityCount });
    const state = createMultiplayerMatch(bigMap, balance, players);
    assert.equal(state.players.length, 32);
    for (const player of state.players) {
      assert.equal(player.cityCount, 3, `player ${player.id} should own 3 cities`);
    }
    assert.equal(
      state.cities.filter((city) => city.owner !== null).length,
      96,
    );
  }
});
