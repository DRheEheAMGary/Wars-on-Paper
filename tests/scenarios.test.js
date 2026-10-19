import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { step } from '../src/shared/sim.js';
const balance = JSON.parse(readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'));
const map = generateMap({ seed: 101, cityCount: 100 });
test('rush scenario lowers the objective requirement and boosts starting gold', () => {
  const classic = createMatch(map, balance, { seed: 101, aiCount: 0, scenario: 'classic' });
  const rush = createMatch(map, balance, { seed: 101, aiCount: 0, scenario: 'rush' });
  assert.equal(rush.scenario, 'rush');
  assert.equal(rush.objectiveFraction, 0.5);
  assert.ok(rush.players[0].gold > classic.players[0].gold);
});
test('blitz scenario overrides match length', () => {
  const state = createMatch(map, balance, { seed: 101, aiCount: 0, scenario: 'blitz' });
  assert.equal(state.matchSeconds, balance.scenarios.blitz.matchSeconds);
});
