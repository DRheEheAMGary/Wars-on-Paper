import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { applyCommand } from '../src/shared/commands.js';
import { step } from '../src/shared/sim.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 77, cityCount: 100 });

test('marching armies disappear when their origin city is captured', () => {
  const state = createMatch(map, balance, { seed: 77, aiCount: 1 });
  const from = state.cities.find((city) => city.owner === 0);
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  assert.ok(toId !== undefined);
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 30,
  });
  assert.equal(state.armies.length, 1);
  const army = state.armies[0];
  state.cities[from.id].owner = 1;
  step(state, balance, []);
  assert.equal(state.armies.length, 0);
  assert.ok(state.events.some((event) => event.type === 'armyLost'));
  assert.ok(state.cities[toId].owner !== 0);
  // The army id must not have arrived as a reinforcement elsewhere.
  assert.ok(!state.armies.some((entry) => entry.id === army.id));
});
