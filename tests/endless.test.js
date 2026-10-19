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

test('endless matches start without a timer and schedule the first wave', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  assert.equal(state.mode, 'endless');
  assert.equal(state.wave, 0);
  assert.equal(
    state.nextWaveTick,
    Math.round((balance.endless.firstWaveSeconds * 1000) / balance.tickMs),
  );
});

test('waves spawn rebel armies and eventually attack cities', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  let rebelsSeen = false;
  let attackSeen = false;
  let played = false;
  for (let tick = 0; tick < 1200 && state.phase === 'playing'; tick += 1) {
    step(state, balance, []);
    if (state.armies.some((army) => army.owner === -1)) rebelsSeen = true;
    if (state.events.some((event) => event.type === 'rebelAttack' || event.type === 'rebelCapture')) {
      attackSeen = true;
    }
    if (state.tick > balance.endless.firstWaveSeconds * 10) played = true;
  }
  assert.ok(played, 'time should pass beyond the first wave');
  assert.ok(rebelsSeen, 'rebel armies should be spawned');
  assert.ok(attackSeen, 'rebels should attack at least once');
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
  // Either the player survived past the timer, or rebels eliminated them.
  if (state.phase === 'ended') {
    assert.fail('endless mode must not end on the match timer');
  }
});

test('losing every city ends an endless run with the reached wave', () => {
  const state = createMatch(map, balance, { seed: 31, aiCount: 0, mode: 'endless' });
  // Advance to the first wave, then wipe the human player.
  while (state.tick < balance.endless.firstWaveSeconds * 10) step(state, balance, []);
  for (const city of state.cities) {
    if (city.owner === 0) city.owner = null;
  }
  step(state, balance, []);
  assert.equal(state.phase, 'lost');
  assert.equal(state.result.mode, 'endless');
  assert.ok(state.result.wave >= 1);
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
