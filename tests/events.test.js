import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMap } from '../src/shared/mapgen.js';
import { createMatch } from '../src/shared/match.js';
import { step } from '../src/shared/sim.js';
const balance = JSON.parse(readFileSync(new URL('../data/balance.json', import.meta.url), 'utf8'));
const map = generateMap({ seed: 91, cityCount: 100 });
test('world events trigger and apply effects', () => {
  const state = createMatch(map, balance, { seed: 91, aiCount: 0 });
  let seen = false;
  for (let tick = 0; tick < 900 && !seen; tick += 1) {
    step(state, balance, []);
    seen = state.events.some((event) => event.type === 'worldEvent');
  }
  assert.ok(seen);
});
test('leading human triggers an AI coalition', () => {
  const state = createMatch(map, balance, { seed: 91, aiCount: 2 });
  const neutrals = state.cities.filter((city) => city.owner === null).slice(0, 12);
  for (const city of neutrals) city.owner = 0;
  for (let tick = 0; tick < 20 && !state.coalition; tick += 1) step(state, balance, []);
  assert.equal(state.coalition, true);
  const ais = state.players.filter((player) => player.isAI);
  const key = `${Math.min(ais[0].id, ais[1].id)}:${Math.max(ais[0].id, ais[1].id)}`;
  assert.equal(state.diplomacy[key]?.status, 'ally');
});
test('difficulty profiles define reserve, mistake and multi-front behaviour', () => {
  assert.equal(balance.difficulties.easy.aiMultiFront, false);
  assert.equal(balance.difficulties.hard.aiMultiFront, true);
  assert.ok(balance.difficulties.hard.aiReserveRatio > balance.difficulties.easy.aiReserveRatio);
  assert.ok(balance.difficulties.easy.aiMistakeChance > balance.difficulties.hard.aiMistakeChance);
});
