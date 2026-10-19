import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng, deriveSeed } from '../src/shared/rng.js';

test('same seed produces the same sequence', () => {
  const a = createRng('alpha');
  const b = createRng('alpha');
  const sequenceA = Array.from({ length: 16 }, () => a.next());
  const sequenceB = Array.from({ length: 16 }, () => b.next());
  assert.deepEqual(sequenceA, sequenceB);
});

test('different seeds diverge', () => {
  const a = createRng('alpha');
  const b = createRng('beta');
  const sequenceA = Array.from({ length: 8 }, () => a.next());
  const sequenceB = Array.from({ length: 8 }, () => b.next());
  assert.notDeepEqual(sequenceA, sequenceB);
});

test('values stay in their ranges', () => {
  const rng = createRng(42);
  for (let i = 0; i < 500; i += 1) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1);

    const ranged = rng.range(-5, 5);
    assert.ok(ranged >= -5 && ranged < 5);

    const integer = rng.int(3, 7);
    assert.ok(Number.isInteger(integer) && integer >= 3 && integer <= 7);

    const picked = rng.pick(['a', 'b', 'c']);
    assert.ok(['a', 'b', 'c'].includes(picked));
  }
});

test('shuffle keeps the same elements', () => {
  const rng = createRng('shuffle');
  const source = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = rng.shuffle(source);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), source);
  assert.deepEqual(source, [1, 2, 3, 4, 5, 6, 7, 8], 'input must not be mutated');
});

test('derived seeds are stable and independent', () => {
  assert.equal(deriveSeed('match', 'edge:1|2'), deriveSeed('match', 'edge:1|2'));
  assert.notEqual(deriveSeed('match', 'edge:1|2'), deriveSeed('match', 'edge:1|3'));
  assert.notEqual(deriveSeed('match', 'edge:1|2'), deriveSeed('other', 'edge:1|2'));
});
