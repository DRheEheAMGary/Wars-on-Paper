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
const map = generateMap({ seed: 81, cityCount: 100 });

test('cities can choose exactly one specialisation', () => {
  const state = createMatch(map, balance, { seed: 81, aiCount: 0 });
  const city = state.cities.find((entry) => entry.owner === 0);
  assert.ok(city);
  assert.equal(
    applyCommand(state, balance, {
      type: 'specialize',
      cityId: city.id,
      focus: 'commercial',
    }).ok,
    true,
  );
  assert.equal(city.focus, 'commercial');
  assert.equal(
    applyCommand(state, balance, {
      type: 'specialize',
      cityId: city.id,
      focus: 'military',
    }).ok,
    false,
  );
});

test('commercial focus increases gold income', () => {
  const focused = createMatch(map, balance, { seed: 81, aiCount: 0 });
  const plain = createMatch(map, balance, { seed: 81, aiCount: 0 });
  const city = focused.cities.find((entry) => entry.owner === 0);
  city.focus = 'commercial';
  const startFocused = focused.players[0].gold;
  const startPlain = plain.players[0].gold;
  for (let tick = 0; tick < 100; tick += 1) {
    step(focused, balance, []);
    step(plain, balance, []);
  }
  assert.ok(
    focused.players[0].gold - startFocused >
      plain.players[0].gold - startPlain,
  );
});

test('military focus reduces recruitment cost', () => {
  const military = createMatch(map, balance, { seed: 81, aiCount: 0 });
  const plain = createMatch(map, balance, { seed: 81, aiCount: 0 });
  military.players[0].gold = 2000;
  plain.players[0].gold = 2000;
  const militaryCity = military.cities.find((entry) => entry.owner === 0);
  const plainCity = plain.cities.find((entry) => entry.owner === 0);
  militaryCity.focus = 'military';
  applyCommand(military, balance, {
    type: 'recruit',
    cityId: militaryCity.id,
    unitType: 'infantry',
  });
  applyCommand(plain, balance, {
    type: 'recruit',
    cityId: plainCity.id,
    unitType: 'infantry',
  });
  assert.ok(military.players[0].gold > plain.players[0].gold);
});
