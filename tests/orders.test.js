import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { applyCommand } from '../src/shared/commands.js';
import { step } from '../src/shared/sim.js';
import { estimateBattle, resolveBattle } from '../src/shared/combat.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 71, cityCount: 100 });

test('battle orders are stored and change march timing', () => {
  const state = createMatch(map, balance, { seed: 71, aiCount: 0 });
  const from = state.cities.find((city) => city.owner === 0);
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 20,
    order: 'siege',
  });
  assert.equal(state.armies[0].order, 'siege');
  assert.ok(state.armies[0].arriveTick > state.armies[0].departTick);
});

test('siege orders reduce wall defense while focus raises attack', () => {
  const walled = {
    level: 4,
    terrain: 'plains',
    units: { infantry: 40, cavalry: 0, siege: 0 },
  };
  const normalOdds = estimateBattle({ infantry: 40 }, walled, balance).odds;
  const siegeOdds = estimateBattle({ infantry: 40 }, walled, balance, {
    order: balance.battleOrders.siege,
  }).odds;
  assert.ok(siegeOdds > normalOdds);

  const city = {
    level: 1,
    terrain: 'plains',
    units: { infantry: 30, cavalry: 0, siege: 0 },
  };
  const focusOdds = estimateBattle({ infantry: 30 }, city, balance, {
    order: balance.battleOrders.focus,
  }).odds;
  assert.ok(focusOdds > estimateBattle({ infantry: 30 }, city, balance).odds);
});

test('retreat orders bring half the survivors home after a lost battle', () => {
  const state = createMatch(map, balance, { seed: 71, aiCount: 0 });
  const from = state.cities.find((city) => city.owner === 0);
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  assert.ok(toId !== undefined);
  from.garrison = 20;
  from.units = { infantry: 20, cavalry: 0, siege: 0 };
  state.cities[toId].garrison = 300;
  state.cities[toId].units = { infantry: 300, cavalry: 0, siege: 0 };
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 20,
    order: 'retreat',
  });
  let retreatArmy = null;
  for (let tick = 0; tick < 300 && !retreatArmy; tick += 1) {
    step(state, balance, []);
    retreatArmy = state.armies.find((army) => army.retreating) ?? null;
  }
  assert.ok(retreatArmy, 'a retreating army should return to the origin');
  assert.ok(retreatArmy.soldiers > 0);
  assert.equal(retreatArmy.toCity, from.id);
});

test('retreat resolves survivors without capturing the city', () => {
  const city = {
    level: 1,
    terrain: 'plains',
    units: { infantry: 200, cavalry: 0, siege: 0 },
  };
  const result = resolveBattle(
    { infantry: 30, cavalry: 0, siege: 0 },
    city,
    balance,
    () => 0.5,
    { order: balance.battleOrders.retreat },
  );
  assert.equal(result.captured, false);
  assert.equal(result.retreated, true);
  assert.ok(result.attackerRemaining.infantry > 0);
});
