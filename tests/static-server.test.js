import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSafePath } from '../src/server/static-server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('resolves files inside the repository root', () => {
  assert.equal(resolveSafePath(ROOT, '/'), join(ROOT, 'index.html'));
  assert.equal(resolveSafePath(ROOT, '/src/client/main.js'), join(ROOT, 'src/client/main.js'));
  assert.equal(
    resolveSafePath(ROOT, '/src/client/main.js?v=1'),
    join(ROOT, 'src/client/main.js'),
  );
  assert.equal(resolveSafePath(ROOT, '/src/client/main.js#hash'), join(ROOT, 'src/client/main.js'));
});

test('rejects path traversal attempts', () => {
  assert.equal(resolveSafePath(ROOT, '/../etc/passwd'), null);
  assert.equal(resolveSafePath(ROOT, '/%2e%2e/etc/passwd'), null);
  assert.equal(resolveSafePath(ROOT, '/src/../../etc/passwd'), null);
  assert.equal(resolveSafePath(ROOT, '/%00/index.html'), null);
});

test('rejects malformed URL encodings', () => {
  assert.equal(resolveSafePath(ROOT, '/%E0%A4%A'), null);
});
