import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { step } from '../src/shared/sim.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);
const map = generateMap({ seed: 31, cityCount: 100 });

test('endless matches start without a timer or rebel waves', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  assert.equal(state.mode, 'endless');
  assert.equal(state.nextWaveTick, undefined);
  assert.equal(state.wave, undefined);
});

test('endless mode never spawns rebel armies', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  for (let tick = 0; tick < 1800 && state.phase === 'playing'; tick += 1) {
    step(state, balance, []);
    assert.ok(!state.armies.some((army) => army.owner < 0));
    assert.ok(!state.events.some((event) => event.type === 'wave'));
  }
});

test('endless mode does not end on the timed match clock', () => {
  const state = createMatch(map, balance, {
    seed: 31,
    aiCount: 0,
    mode: 'endless',
    matchSeconds: 20,
  });
  for (let tick = 0; tick < 400 && state.phase === 'playing'; tick += 1) {
    step(state, balance, []);
  }
  assert.equal(state.phase, 'playing');
});

test('losing every city ends an endless run', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  for (const city of state.cities) {
    if (city.owner === 0) city.owner = null;
  }
  step(state, balance, []);
  assert.equal(state.phase, 'lost');
  assert.equal(state.result.mode, 'endless');
  assert.ok(state.result.elapsed >= 0);
});

test('difficulty profiles include AI pacing controls', () => {
  for (const key of ['easy', 'normal', 'hard']) {
    const profile = balance.difficulties[key];
    assert.ok(profile.aiThinkTicks > 0);
    assert.ok(profile.aiActionsPerThink >= 1);
    assert.ok(profile.aiStartDelaySeconds >= 0);
  }
  assert.ok(
    balance.difficulties.hard.aiActionsPerThink >
      balance.difficulties.normal.aiActionsPerThink,
  );
  assert.ok(
    balance.difficulties.easy.aiStartDelaySeconds >
      balance.difficulties.hard.aiStartDelaySeconds,
  );
});
