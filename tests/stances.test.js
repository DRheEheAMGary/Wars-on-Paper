import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { applyCommand } from '../src/shared/commands.js';
import { estimateBattle, resolveBattle } from '../src/shared/combat.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 41, cityCount: 60 });

function makeState() {
  return createMatch(map, balance, { seed: 41, aiCount: 0 });
}

function deployWithStance(stance) {
  const state = makeState();
  const from = state.cities.find((city) => city.owner === 0);
  const toId = map.cities[from.id].neighbors.find(
    (neighbour) => state.cities[neighbour].owner !== 0,
  );
  assert.ok(toId !== undefined);
  const result = applyCommand(state, balance, {
    type: 'deploy',
    fromCity: from.id,
    toCity: toId,
    soldiers: 30,
    stance,
  });
  assert.equal(result.ok, true);
  return state.armies[0];
}

test('stances change march timing and are stored on the army', () => {
  const normal = deployWithStance('none');
  const raid = deployWithStance('raid');
  const hold = deployWithStance('hold');
  assert.equal(normal.stance, 'none');
  assert.equal(raid.stance, 'raid');
  assert.equal(hold.stance, 'hold');
  assert.ok(raid.arriveTick < normal.arriveTick, '袭扰 should arrive earlier');
  assert.ok(hold.arriveTick > normal.arriveTick, '固守 should arrive later');
});

test('unknown stance falls back to none', () => {
  const army = deployWithStance('unknown-stance');
  assert.equal(army.stance, 'none');
});

test('assault raises attack power but increases own casualties', () => {
  const city = {
    level: 1,
    terrain: 'plains',
    garrison: 30,
    units: { infantry: 30, cavalry: 0, siege: 0 },
  };
  const attacker = { infantry: 40, cavalry: 0, siege: 0 };
  const normal = resolveBattle(attacker, city, balance, () => 0.5);
  const assault = resolveBattle(attacker, city, balance, () => 0.5, {
    stance: balance.stances.assault,
  });
  assert.ok(assault.defenderLoss >= normal.defenderLoss);
  const survivors = (units) => units.infantry + units.cavalry + units.siege;
  assert.ok(
    survivors(assault.attackerRemaining) >= survivors(normal.attackerRemaining),
    'assault should win faster with at least as many survivors',
  );
});

test('estimate reacts to stance', () => {
  const city = {
    level: 1,
    terrain: 'plains',
    garrison: 30,
    units: { infantry: 30, cavalry: 0, siege: 0 },
  };
  const normal = estimateBattle({ infantry: 30 }, city, balance).odds;
  const assault = estimateBattle({ infantry: 30 }, city, balance, {
    stance: balance.stances.assault,
  }).odds;
  const raid = estimateBattle({ infantry: 30 }, city, balance, {
    stance: balance.stances.raid,
  }).odds;
  assert.ok(assault > normal);
  assert.ok(raid < normal);
});

test('AI armies can carry stances', async () => {
  const { step } = await import('../src/shared/sim.js');
  const state = createMatch(map, balance, { seed: 41, aiCount: 2 });
  let found = false;
  for (let tick = 0; tick < 900 && !found; tick += 1) {
    step(state, balance, []);
    found = state.armies.some(
      (army) => army.owner > 0 && typeof army.stance === 'string' && balance.stances[army.stance],
    );
  }
  assert.ok(found, 'AI should eventually attack with a stance');
});
