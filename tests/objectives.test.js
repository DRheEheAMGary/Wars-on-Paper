import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { estimateBattle } from '../src/shared/combat.js';
import { step } from '../src/shared/sim.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 61, cityCount: 160 });

test('maps contain fortresses, mines and granaries spread across the map', () => {
  const sites = map.specialSites;
  assert.ok(sites.length >= 3);
  const types = new Set(sites.map((site) => site.type));
  assert.ok(types.has('fortress'));
  assert.ok(types.has('mine'));
  assert.ok(types.has('granary'));
  for (const site of sites) {
    assert.equal(map.cities[site.id].special, site.type);
  }
});

test('special cities start with stronger garrisons and levels', () => {
  const state = createMatch(map, balance, { seed: 61, aiCount: 0 });
  const fortress = map.cities.find((city) => city.special === 'fortress');
  assert.ok(fortress);
  assert.ok(state.cities[fortress.id].garrison >= 60);
  assert.ok(state.cities[fortress.id].level >= 2);
});

test('owning a gold mine adds gold income', () => {
  const withMine = createMatch(map, balance, { seed: 61, aiCount: 0 });
  const without = createMatch(map, balance, { seed: 61, aiCount: 0 });
  const mineCity = withMine.cities.find((city) => city.special === 'mine');
  assert.ok(mineCity);
  mineCity.owner = 0;
  mineCity.units = { infantry: 30, cavalry: 0, siege: 0 };
  mineCity.garrison = 30;
  const startWith = withMine.players[0].gold;
  const startWithout = without.players[0].gold;
  step(withMine, balance, []);
  step(without, balance, []);
  assert.ok(
    withMine.players[0].gold - startWith >
      without.players[0].gold - startWithout + 0.2,
  );
});

test('fortress cities have higher defense in estimate', () => {
  const fortress = map.cities.find((city) => city.special === 'fortress');
  const plain = map.cities.find((city) => !city.special);
  assert.ok(fortress && plain);
  const units = { infantry: 30, cavalry: 0, siege: 0 };
  const fortressEstimate = estimateBattle(units, {
    level: 1,
    terrain: 'plains',
    units,
    special: 'fortress',
  }, balance);
  const plainEstimate = estimateBattle(units, {
    level: 1,
    terrain: 'plains',
    units,
    special: null,
  }, balance);
  assert.ok(fortressEstimate.defense > plainEstimate.defense);
});

test('controlling enough strategic sites wins a timed match', () => {
  const state = createMatch(map, balance, { seed: 61, aiCount: 0 });
  const sites = state.cities.filter((city) => city.special);
  const required = Math.ceil(sites.length * balance.objectives.requiredFraction);
  assert.ok(required < sites.length);
  for (const site of sites.slice(0, required)) {
    site.owner = 0;
  }
  // Keep at least one neutral city so this is not a domination win.
  for (const city of state.cities) {
    if (city.owner === 0 && !city.special) city.owner = null;
  }
  step(state, balance, []);
  assert.equal(state.phase, 'won');
  assert.equal(state.result.outcome, 'objectives');
});
