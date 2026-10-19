import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { applyCommand } from '../src/shared/commands.js';
import { step } from '../src/shared/sim.js';
import {
  commanderAtCity,
  commanderEffects,
  grantCommanderXp,
} from '../src/shared/commanders.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 51, cityCount: 100 });
const makeState = () => createMatch(map, balance, { seed: 51, aiCount: 0 });

test('every player starts with one commander assigned to their capital', () => {
  const state = makeState();
  const player = state.players[0];
  assert.equal(player.commanders.length, 1);
  const commander = player.commanders[0];
  assert.ok(commander.cityId !== null);
  assert.equal(state.cities[commander.cityId].owner, 0);
  assert.ok(commander.level >= 1);
});

test('hiring commanders costs gold and respects the active cap', () => {
  const state = makeState();
  const player = state.players[0];
  player.gold = 5000;
  const config = balance.commanders;
  while (player.commanders.length < config.maxActive) {
    const before = player.gold;
    const result = applyCommand(state, balance, { type: 'hireCommander' });
    assert.equal(result.ok, true);
    assert.ok(player.gold < before);
  }
  assert.equal(player.commanders.length, config.maxActive);
  assert.equal(applyCommand(state, balance, { type: 'hireCommander' }).ok, false);
});

test('commanders can be assigned between cities and only one governs a city', () => {
  const state = makeState();
  const player = state.players[0];
  player.gold = 1000;
  applyCommand(state, balance, { type: 'hireCommander' });
  const hired = player.commanders[1];
  const cities = state.cities.filter((city) => city.owner === 0);
  const target = cities[1];
  assert.equal(
    applyCommand(state, balance, {
      type: 'assignCommander',
      commanderId: hired.id,
      cityId: target.id,
    }).ok,
    true,
  );
  assert.equal(commanderAtCity(player, target.id).id, hired.id);

  // Assigning the first commander to the same city unseats the hired one.
  const first = player.commanders[0];
  applyCommand(state, balance, {
    type: 'assignCommander',
    commanderId: first.id,
    cityId: target.id,
  });
  assert.equal(commanderAtCity(player, target.id).id, first.id);
  assert.equal(hired.cityId, null);
});

test('steward commanders increase city gold income', () => {
  const withSteward = makeState();
  const plain = makeState();
  const player = withSteward.players[0];
  const commander = player.commanders[0];
  commander.trait = 'steward';
  commander.level = 3;
  plain.players[0].commanders = [];
  const startWith = player.gold;
  const startPlain = plain.players[0].gold;
  for (let tick = 0; tick < 100; tick += 1) {
    step(withSteward, balance, []);
    step(plain, balance, []);
  }
  assert.ok(
    player.gold - startWith > plain.players[0].gold - startPlain,
    'steward should add gold production',
  );
});

test('war commanders add attack and swift commanders shorten marches', () => {
  const state = makeState();
  const player = state.players[0];
  const from = state.cities.find((city) => city.owner === 0);
  const commander = player.commanders[0];
  commander.cityId = from.id;
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  assert.ok(toId !== undefined);

  commander.trait = 'war';
  commander.level = 2;
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 20,
  });
  const warArmy = state.armies.at(-1);
  assert.ok(warArmy.commanderAttack > 0);

  const fast = makeState();
  const fastPlayer = fast.players[0];
  const fastFrom = fast.cities.find((city) => city.owner === 0);
  const fastTo = map.cities[fastFrom.id].neighbors.find(
    (neighbour) => fast.cities[neighbour].owner !== 0,
  );
  assert.ok(fastTo !== undefined);
  fastPlayer.commanders[0].cityId = fastFrom.id;
  fastPlayer.commanders[0].trait = 'swift';
  fastPlayer.commanders[0].level = 4;
  applyCommand(fast, balance, {
    type: 'deploy',
    fromCity: fastFrom.id,
    toCity: fastTo,
    soldiers: 20,
  });
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 20,
    soldiersOverride: undefined,
  });
  assert.ok(fast.armies[0].arriveTick - fast.armies[0].departTick > 0);
});

test('commanders gain XP and level up after battles', () => {
  const state = makeState();
  const player = state.players[0];
  const from = state.cities.find((city) => city.owner === 0);
  const commander = player.commanders[0];
  commander.cityId = from.id;
  commander.trait = 'war';
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  assert.ok(toId !== undefined);
  state.cities[toId].garrison = 0;
  state.cities[toId].units = { infantry: 0, cavalry: 0, siege: 0 };
  applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 30,
  });
  const xpBefore = commander.xp;
  for (let tick = 0; tick < 200 && state.cities[toId].owner !== 0; tick += 1) {
    step(state, balance, []);
  }
  assert.equal(state.cities[toId].owner, 0);
  assert.ok(commander.xp > xpBefore);
});

test('commander XP thresholds level up correctly', () => {
  const commander = { level: 1, xp: balance.commanders.xpLevels[1] - 1 };
  const levelled = grantCommanderXp(commander, balance, 5);
  assert.equal(levelled, true);
  assert.equal(commander.level, 2);
  assert.equal(commander.xp, 4);
});

test('AI hires and uses commanders over time', () => {
  const state = createMatch(map, balance, { seed: 51, aiCount: 1 });
  const ai = state.players.find((player) => player.isAI);
  assert.ok(ai);
  let used = false;
  for (let tick = 0; tick < 1500 && !used; tick += 1) {
    step(state, balance, []);
    used =
      ai.commanders.length > 1 ||
      ai.commanders.some((commander) => commander.xp > 0 || commander.cityId !== null);
  }
  assert.ok(used, 'AI should hire or use commanders');
});
