import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { step } from '../src/shared/sim.js';
import { applyCommand } from '../src/shared/commands.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 7, cityCount: 40 });
const makeState = () => createMatch(map, balance, { seed: 7 });

test('match starts with owned spawn cities and starting resources', () => {
  const state = makeState();
  assert.equal(state.cities.length, 40);
  const owned = state.cities.filter((city) => city.owner === 0);
  assert.equal(owned.length, balance.spawnCities);
  assert.equal(state.players[0].gold, balance.startGold);
  assert.equal(state.phase, 'playing');
});

test('economy produces gold and grows population', () => {
  const state = makeState();
  const goldBefore = state.players[0].gold;
  for (let i = 0; i < 100; i += 1) step(state, balance, []);
  assert.ok(state.players[0].gold > goldBefore);
  assert.ok(state.players[0].food >= 0);
  const owned = state.cities.filter((city) => city.owner === 0);
  assert.ok(owned.some((city) => city.population > balance.startPopulation));
});

test('recruit costs gold and population and adds soldiers', () => {
  const state = makeState();
  state.players[0].gold = 1000;
  const city = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);
  const garrisonBefore = city.garrison;
  const populationBefore = city.population;
  const result = applyCommand(state, balance, { type: 'recruit', cityId: city.id });
  assert.equal(result.ok, true);
  assert.equal(city.garrison, garrisonBefore + balance.recruitBatch);
  assert.ok(state.players[0].gold < 1000);
  assert.ok(city.population < populationBefore);
});

test('recruit is rejected without enough gold', () => {
  const state = makeState();
  state.players[0].gold = 0;
  const city = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);
  const result = applyCommand(state, balance, { type: 'recruit', cityId: city.id });
  assert.equal(result.ok, false);
});

test('deploy marches an army and captures an undefended city', () => {
  const state = makeState();
  const from = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(from);
  const toId = from.neighbors.find(
    (neighbour) => state.cities[neighbour].owner === null,
  );
  assert.ok(toId !== undefined);
  state.cities[toId].garrison = 0;
  state.cities[toId].units = { infantry: 0, cavalry: 0, siege: 0 };
  from.garrison = 50;
  from.units = { infantry: 50, cavalry: 0, siege: 0 };

  const result = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
  });
  assert.equal(result.ok, true);
  assert.equal(from.garrison, 0);
  assert.equal(state.armies.length, 1);
  assert.ok(state.armies[0].arriveTick > state.tick);

  for (let i = 0; i < 200 && state.cities[toId].owner === null; i += 1) {
    step(state, balance, []);
  }
  assert.equal(state.cities[toId].owner, 0);
  assert.ok(state.players[0].cityCount >= balance.spawnCities + 1);
});

test('upgrade spends gold and completes after its timer', () => {
  const state = makeState();
  state.players[0].gold = 5000;
  const city = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);

  const result = applyCommand(state, balance, { type: 'upgrade', cityId: city.id });
  assert.equal(result.ok, true);
  assert.ok(city.upgrading);
  const endTick = city.upgrading.endsTick;
  while (state.tick <= endTick) step(state, balance, []);
  assert.equal(city.level, 2);
  assert.equal(city.upgrading, null);
});

test('same seed and commands produce identical state', () => {
  const a = makeState();
  const b = makeState();
  for (const state of [a, b]) {
    const city = state.cities.find((candidate) => candidate.owner === 0);
    assert.ok(city);
    applyCommand(state, balance, { type: 'recruit', cityId: city.id });
  }
  for (let i = 0; i < 50; i += 1) {
    step(a, balance, []);
    step(b, balance, []);
  }
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('resources never go negative', () => {
  const state = makeState();
  for (let i = 0; i < 300; i += 1) {
    step(state, balance, []);
    assert.ok(state.players[0].gold >= 0);
    assert.ok(state.players[0].food >= 0);
  }
});

test('match ends in victory after conquering every city', () => {
  const state = makeState();
  for (const city of state.cities) city.owner = 0;
  step(state, balance, []);
  assert.equal(state.phase, 'won');
  assert.equal(state.result.outcome, 'won');
  assert.ok(state.result.score > 0);
});

test('troops can be transferred between your own cities', () => {
  const state = createMatch(map, balance, { seed: 7, aiCount: 0 });
  const from = state.cities.find((candidate) => candidate.owner === 0);
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner === 0,
  );
  assert.ok(toId !== undefined);
  const fromBefore = from.garrison;
  const toBefore = state.cities[toId].garrison;

  const result = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(from.garrison, fromBefore - 20);

  for (let i = 0; i < 120 && state.armies.length > 0; i += 1) {
    step(state, balance, []);
  }
  assert.equal(state.cities[toId].garrison, toBefore + 20);
  assert.equal(state.cities[from.id].garrison, fromBefore - 20);
});

test('reinforcements can travel to any of your cities, but attacks stay adjacent', () => {
  const state = createMatch(map, balance, { seed: 7, aiCount: 0 });
  const from = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(from);

  // Pick a city that is neither adjacent nor sea-linked, then make it ours.
  const distant = state.cities.find(
    (candidate) =>
      candidate.id !== from.id &&
      candidate.owner === null &&
      !map.cities[from.id].neighbors.includes(candidate.id) &&
      !(map.cities[from.id].seaNeighbors ?? []).includes(candidate.id),
  );
  assert.ok(distant);
  distant.owner = 0;
  distant.garrison = 10;
  distant.units = { infantry: 10, cavalry: 0, siege: 0 };

  const transfer = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: distant.id,
    soldiers: 10,
  });
  assert.equal(transfer.ok, true);
  const army = state.armies.find((candidate) => candidate.toCity === distant.id);
  assert.ok(army);
  assert.ok(army.arriveTick - army.departTick > balance.soldierTravelSeconds * 10);

  // The same distant city is still not attackable while neutral.
  const neutral = state.cities.find(
    (candidate) =>
      candidate.owner === null &&
      candidate.id !== from.id &&
      !map.cities[from.id].neighbors.includes(candidate.id) &&
      !(map.cities[from.id].seaNeighbors ?? []).includes(candidate.id),
  );
  assert.ok(neutral);
  const attack = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: neutral.id,
    soldiers: 5,
  });
  assert.equal(attack.ok, false);
});

test('failed attacks wipe the attacker instead of retreating', () => {
  const state = makeState();
  const from = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(from);
  const toId = from.neighbors.find((neighbour) => state.cities[neighbour].owner === null);
  assert.ok(toId !== undefined);
  from.garrison = 8;
  from.units = { infantry: 8, cavalry: 0, siege: 0 };
  state.cities[toId].garrison = 200;
  state.cities[toId].units = { infantry: 200, cavalry: 0, siege: 0 };

  applyCommand(state, balance, { type: 'deploy', fromCity: from.id, toCity: toId });
  let sawReturn = false;
  for (let i = 0; i < 200; i += 1) {
    step(state, balance, []);
    if (state.armies.some((army) => army.fromCity === toId && army.toCity === from.id)) {
      sawReturn = true;
    }
  }
  assert.equal(sawReturn, false);
  assert.equal(state.cities[toId].owner, null);
  assert.ok(state.cities[toId].garrison < 200);
});

test('armies can cross the sea between continents', () => {
  const state = makeState();
  assert.ok(map.seaRoutes.length > 0);
  const route = map.seaRoutes[0];
  state.cities[route.a].owner = 0;
  state.cities[route.a].garrison = 150;
  state.cities[route.a].units = { infantry: 150, cavalry: 0, siege: 0 };
  state.cities[route.b].owner = null;
  state.cities[route.b].garrison = 0;
  state.cities[route.b].units = { infantry: 0, cavalry: 0, siege: 0 };

  const result = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: route.a,
    toCity: route.b,
  });
  assert.equal(result.ok, true);
  assert.equal(state.armies[0].sea, true);
  assert.ok(state.armies[0].arriveTick > balance.soldierTravelSeconds * 10);

  for (let i = 0; i < 300 && state.cities[route.b].owner === null; i += 1) {
    step(state, balance, []);
  }
  assert.equal(state.cities[route.b].owner, 0);
});

test('difficulty profile scales AI income', () => {
  const low = createMatch(map, balance, {
    seed: 7,
    aiCount: 1,
    aiProfile: { aiGoldMultiplier: 0.5 },
  });
  const normal = createMatch(map, balance, {
    seed: 7,
    aiCount: 1,
    aiProfile: { aiGoldMultiplier: 1.0 },
  });
  const lowStart = low.players[1].gold;
  const normalStart = normal.players[1].gold;
  step(low, balance, []);
  step(normal, balance, []);
  assert.ok(
    normal.players[1].gold - normalStart > low.players[1].gold - lowStart,
    'higher difficulty should earn more AI gold',
  );
});

test('match length can be overridden', () => {
  const state = createMatch(map, balance, {
    seed: 7,
    aiCount: 0,
    matchSeconds: 30,
  });
  for (let i = 0; i < 320; i += 1) step(state, balance, []);
  assert.equal(state.phase, 'ended');
  assert.equal(state.result.outcome, 'ended');
  assert.ok(state.result.rank >= 1);
});

test('research costs gold, respects prerequisites and completes on a timer', () => {
  const state = makeState();
  state.players[0].gold = 1000;

  const result = applyCommand(state, balance, { type: 'research', techId: 'tax' });
  assert.equal(result.ok, true);
  assert.ok(state.players[0].gold < 1000);
  assert.equal(state.players[0].research.id, 'tax');
  assert.equal(
    applyCommand(state, balance, { type: 'research', techId: 'drill' }).ok,
    false,
    'only one tech may be researched at a time',
  );

  const endTick = state.players[0].research.endsTick;
  while (state.tick <= endTick) step(state, balance, []);
  assert.equal(state.players[0].tech.tax, true);
  assert.equal(state.players[0].research, null);

  assert.equal(
    applyCommand(state, balance, { type: 'research', techId: 'armor' }).ok,
    false,
    'second-tier tech requires its prerequisite',
  );
  assert.equal(
    applyCommand(state, balance, { type: 'research', techId: 'tax' }).ok,
    false,
    'already researched',
  );
});

test('AI opponents take actions over time', () => {
  const aiState = createMatch(map, balance, { seed: 7, aiCount: 2 });
  assert.ok(aiState.players.length > 1);
  const initial = aiState.players.slice(1).map((player) => player.cityCount);
  for (let i = 0; i < 400; i += 1) step(aiState, balance, []);
  const changed = aiState.players
    .slice(1)
    .some((player, index) => player.cityCount !== initial[index] || player.kills > 0);
  assert.equal(changed, true);
});
