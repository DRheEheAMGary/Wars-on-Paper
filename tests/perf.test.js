import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { generateMap } from '../src/shared/mapgen.js';
import { createMultiplayerMatch } from '../src/shared/multiplayer.js';
import { step } from '../src/shared/sim.js';

const balance = JSON.parse(
  readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'),
);

test('32-player, 240-city simulation p95 tick stays under the 2ms budget', () => {
  const map = generateMap({ seed: 42, cityCount: 240 });
  const players = Array.from({ length: 32 }, (_, index) => ({
    id: index,
    name: `P${index}`,
  }));
  const state = createMultiplayerMatch(map, balance, players, {
    matchSeconds: 600,
  });

  const durations = [];
  for (let tick = 0; tick < 600; tick += 1) {
    const commands = [];
    if (tick % 20 === 0) {
      const player = state.players[tick % state.players.length];
      const city = state.cities.find((candidate) => candidate.owner === player.id);
      if (city) commands.push({ type: 'recruit', cityId: city.id, owner: player.id });
    }
    const started = performance.now();
    step(state, balance, commands);
    durations.push(performance.now() - started);
  }

  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)];
  assert.ok(p95 < 2, `p95 ${p95.toFixed(3)}ms exceeds 2ms budget`);
});
