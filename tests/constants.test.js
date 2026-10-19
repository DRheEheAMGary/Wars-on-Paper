import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TICK_MS,
  TICK_RATE,
  PROTOCOL_VERSION,
  STATE_VERSION,
  DEFAULT_PORT,
} from '../src/shared/constants.js';

test('tick constants are consistent', () => {
  assert.equal(TICK_MS, 100);
  assert.equal(TICK_RATE, 1000 / TICK_MS);
  assert.equal(TICK_RATE, 10);
});

test('version constants are positive integers', () => {
  for (const version of [PROTOCOL_VERSION, STATE_VERSION]) {
    assert.ok(Number.isInteger(version), `expected integer, got ${version}`);
    assert.ok(version > 0, `expected positive, got ${version}`);
  }
});

test('default port is a valid TCP port', () => {
  assert.ok(Number.isInteger(DEFAULT_PORT));
  assert.ok(DEFAULT_PORT > 0 && DEFAULT_PORT < 65536);
});
