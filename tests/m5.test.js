import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { createMultiplayerMatch } from '../src/shared/multiplayer.js';
import { applyCommand } from '../src/shared/commands.js';
import { step } from '../src/shared/sim.js';
import { buildingEffects } from '../src/shared/buildings.js';
import {
  getRelation,
  isFriendly,
  relationLabel,
} from '../src/shared/diplomacy.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 21, cityCount: 60 });

test('buildings cost gold, occupy slots and reject duplicates', () => {
  const state = createMatch(map, balance, { seed: 21, aiCount: 0 });
  state.players[0].gold = 5000;
  const city = state.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);

  assert.equal(
    applyCommand(state, balance, { type: 'build', cityId: city.id, buildingId: 'market' }).ok,
    true,
  );
  assert.deepEqual(city.buildings, ['market']);
  assert.equal(
    applyCommand(state, balance, { type: 'build', cityId: city.id, buildingId: 'market' }).ok,
    false,
  );
  assert.equal(
    applyCommand(state, balance, { type: 'build', cityId: city.id, buildingId: 'walls' }).ok,
    true,
  );
  assert.equal(
    applyCommand(state, balance, { type: 'build', cityId: city.id, buildingId: 'barracks' }).ok,
    false,
    'third building should not fit into two slots',
  );
});

test('market increases gold income and barracks raises the garrison cap', () => {
  const withMarket = createMatch(map, balance, { seed: 21, aiCount: 0 });
  const without = createMatch(map, balance, { seed: 21, aiCount: 0 });
  const city = withMarket.cities.find((candidate) => candidate.owner === 0);
  assert.ok(city);
  city.buildings = ['market'];
  const startWith = withMarket.players[0].gold;
  const startWithout = without.players[0].gold;
  step(withMarket, balance, []);
  step(without, balance, []);
  assert.ok(
    withMarket.players[0].gold - startWith > without.players[0].gold - startWithout,
  );

  withMarket.players[0].gold = 5000;
  city.buildings = ['barracks'];
  city.units = { infantry: 140, cavalry: 0, siege: 0 };
  city.garrison = 140;
  const config = balance.cityLevels[0];
  const before = city.garrison;
  const result = applyCommand(withMarket, balance, {
    type: 'recruit',
    cityId: city.id,
    unitType: 'infantry',
  });
  assert.equal(result.ok, true);
  assert.ok(city.garrison > before);
  assert.ok(city.garrison > config.garrisonCap * 0.95);
  assert.ok(city.garrison <= config.garrisonCap * 1.3);
});

test('alliance blocks attacks, and breaking it applies a betrayal penalty', () => {
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }, { id: 1, name: 'B' }],
  );
  const a = state.players[0];
  const b = state.players[1];
  a.gold = 2000;

  const request = applyCommand(state, balance, {
    type: 'diplomacy',
    action: 'ally',
    targetId: 1,
    owner: 0,
  });
  assert.equal(request.ok, true);
  assert.equal(state.diplomacyRequests.length, 1);
  const accept = applyCommand(state, balance, {
    type: 'diplomacy',
    action: 'accept',
    requestId: state.diplomacyRequests[0].id,
    owner: 1,
  });
  assert.equal(accept.ok, true);
  assert.equal(getRelation(state, 0, 1).status, 'ally');
  assert.equal(relationLabel(state, 0, 1), '盟友');
  assert.equal(isFriendly(state, 0, 1), true);

  const from = state.cities.find((city) => city.owner === 0);
  const targetId = state.cities.find((city) => city.owner === 1).id;
  // Force adjacency for the rule check by making the target a direct neighbour.
  const target = state.cities[targetId];
  target.neighbors = [...target.neighbors, from.id];
  from.neighbors = [...from.neighbors, targetId];
  const blocked = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: targetId,
    soldiers: 10,
    owner: 0,
  });
  assert.equal(blocked.ok, false);

  const betray = applyCommand(state, balance, {
    type: 'diplomacy',
    action: 'break',
    targetId: 1,
    owner: 0,
  });
  assert.equal(betray.ok, true);
  assert.ok(state.players[0].betrayalUntil > state.tick);
  assert.equal(isFriendly(state, 0, 1), false);
  const attack = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: targetId,
    soldiers: 10,
    owner: 0,
  });
  assert.equal(attack.ok, true);
});

test('truce blocks attacks until it expires', () => {
  const state = createMultiplayerMatch(
    map,
    balance,
    [{ id: 0, name: 'A' }, { id: 1, name: 'B' }],
  );
  state.players[0].gold = 2000;
  applyCommand(state, balance, { type: 'diplomacy', action: 'truce', targetId: 1, owner: 0 });
  applyCommand(state, balance, {
    type: 'diplomacy',
    action: 'accept',
    requestId: state.diplomacyRequests[0].id,
    owner: 1,
  });
  assert.equal(isFriendly(state, 0, 1), true);
  const from = state.cities.find((city) => city.owner === 0);
  const target = state.cities.find((city) => city.owner === 1);
  from.neighbors = [...from.neighbors, target.id];
  target.neighbors = [...target.neighbors, from.id];
  assert.equal(
    applyCommand(state, balance, {
      type: 'deploy',
      fromCity: from.id,
      toCity: target.id,
      soldiers: 10,
      owner: 0,
    }).ok,
    false,
  );

  // Fast-forward past the truce window.
  state.tick += (balance.diplomacy.truceSeconds + 1) * 10;
  assert.equal(isFriendly(state, 0, 1), false);
});

test('AI accepts diplomatic requests when configured', () => {
  const friendlyBalance = {
    ...balance,
    diplomacy: { ...balance.diplomacy, aiAcceptChance: 1 },
  };
  const state = createMatch(map, friendlyBalance, { seed: 21, aiCount: 1 });
  const ai = state.players.find((player) => player.isAI);
  assert.ok(ai);
  const result = applyCommand(state, friendlyBalance, {
    type: 'diplomacy',
    action: 'truce',
    targetId: ai.id,
    owner: 0,
  });
  assert.equal(result.ok, true);
  step(state, friendlyBalance, []);
  const relation = getRelation(state, 0, ai.id);
  assert.ok(relation);
  assert.equal(relation.status, 'truce');
});

test('building effects aggregate for the renderer and simulator', () => {
  const city = { buildings: ['market', 'walls'] };
  const effects = buildingEffects(balance, city);
  assert.equal(effects.gold, 0.25);
  assert.equal(effects.defense, 0.2);
});
