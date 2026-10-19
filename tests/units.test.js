import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { applyCommand } from '../src/shared/commands.js';
import { resolveBattle, estimateBattle } from '../src/shared/combat.js';
import { techEffects, checkResearch } from '../src/shared/tech.js';
import { splitUnits, totalUnits } from '../src/shared/units.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 9, cityCount: 60 });
const makeState = () => createMatch(map, balance, { seed: 9, aiCount: 0 });

test('recruiting each unit type updates the composition and costs', () => {
  const state = makeState();
  state.players[0].gold = 2000;
  const city = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);
  const goldBefore = state.players[0].gold;

  assert.equal(
    applyCommand(state, balance, {
      type: 'recruit',
      cityId: city.id,
      unitType: 'infantry',
    }).ok,
    true,
  );
  assert.equal(city.units.infantry, balance.units.infantry.batch + 60);

  assert.equal(
    applyCommand(state, balance, {
      type: 'recruit',
      cityId: city.id,
      unitType: 'cavalry',
    }).ok,
    true,
  );
  assert.equal(city.units.cavalry, balance.units.cavalry.batch);

  assert.equal(
    applyCommand(state, balance, {
      type: 'recruit',
      cityId: city.id,
      unitType: 'siege',
    }).ok,
    true,
  );
  assert.equal(city.units.siege, balance.units.siege.batch);
  assert.equal(
    city.garrison,
    totalUnits(city.units),
    'garrison total stays in sync with the composition',
  );
  assert.ok(state.players[0].gold < goldBefore);
});

test('splitting a dispatch keeps the composition proportional', () => {
  const units = { infantry: 30, cavalry: 10, siege: 5 };
  const { taken, remaining } = splitUnits(units, 18);
  assert.equal(totalUnits(taken), 18);
  assert.equal(totalUnits(remaining), totalUnits(units) - 18);
  assert.ok(taken.infantry > taken.cavalry && taken.cavalry > taken.siege);
});

test('cavalry counters infantry and siege counters walls', () => {
  const infantryCity = {
    level: 1,
    terrain: 'plains',
    garrison: 30,
    units: { infantry: 30, cavalry: 0, siege: 0 },
  };
  const infantryOdds = estimateBattle({ infantry: 30 }, infantryCity, balance).odds;
  const cavalryOdds = estimateBattle({ cavalry: 30 }, infantryCity, balance).odds;
  assert.ok(cavalryOdds > infantryOdds, 'cavalry should beat infantry composition');

  const walledCity = {
    level: 4,
    terrain: 'plains',
    garrison: 30,
    units: { infantry: 30, cavalry: 0, siege: 0 },
  };
  const siegeIntoWalls = estimateBattle({ siege: 30 }, walledCity, balance);
  const infantryIntoWalls = estimateBattle({ infantry: 30 }, walledCity, balance);
  assert.ok(
    siegeIntoWalls.attack / Math.max(1, siegeIntoWalls.defense) >
      infantryIntoWalls.attack / Math.max(1, infantryIntoWalls.defense),
    'siege should trade better than infantry against a walled city',
  );
});

test('battles produce surviving compositions instead of a single blob', () => {
  const defenderCity = {
    level: 1,
    terrain: 'plains',
    garrison: 20,
    units: { infantry: 20, cavalry: 0, siege: 0 },
  };
  const result = resolveBattle(
    { infantry: 30, cavalry: 10, siege: 5 },
    defenderCity,
    balance,
    () => 0.5,
  );
  if (result.captured) {
    assert.equal(totalUnits(result.defenderRemaining), 0);
    assert.equal(
      totalUnits(result.attackerRemaining),
      45 - result.attackerLoss,
    );
  } else {
    assert.equal(totalUnits(result.attackerRemaining), 0);
    assert.equal(
      totalUnits(result.defenderRemaining),
      20 - result.defenderLoss,
    );
  }
});

test('researched tech effects are aggregated and prerequisites are enforced', () => {
  const player = { tech: { tax: true, granary: true }, research: null, gold: 5000 };
  const effects = techEffects(player, balance);
  assert.ok(effects.gold > 0.19, 'tax gives +20% gold');
  assert.ok(effects.food > 0.29, 'granary gives +30% food');

  assert.equal(checkResearch(player, balance, 'drill').ok, true);
  assert.equal(checkResearch(player, balance, 'armor').ok, false);
  assert.equal(checkResearch(player, balance, 'tax').ok, false);
});

test('tax tech increases produced gold', async () => {
  const { step } = await import('../src/shared/sim.js');
  const withTax = makeState();
  withTax.players[0].tech = { tax: true };
  const withoutTax = makeState();
  const startWith = withTax.players[0].gold;
  const startWithout = withoutTax.players[0].gold;
  step(withTax, balance, []);
  step(withoutTax, balance, []);
  assert.ok(
    withTax.players[0].gold - startWith >
      withoutTax.players[0].gold - startWithout,
  );
});
