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
  from.garrison = 50;

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

test('match ends in victory when the home continent is fully owned', () => {
  const state = makeState();
  for (const city of state.cities) {
    if (city.continent === state.spawnContinent) city.owner = 0;
  }
  step(state, balance, []);
  assert.equal(state.phase, 'won');
  assert.equal(state.result.outcome, 'won');
  assert.ok(state.result.score > 0);
});
