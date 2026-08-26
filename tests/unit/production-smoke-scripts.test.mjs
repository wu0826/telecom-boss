import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('MySQL smoke requires production MySQL and uses an intentionally rolled-back write probe', async () => {
  const text = await source('scripts/smoke-mysql-runtime.mjs');
  assert.match(text, /NODE_ENV=production/);
  assert.match(text, /DB_DRIVER=mysql/);
  assert.match(text, /assertRuntimeReadiness/);
  assert.match(text, /ExpectedRollback/);
  assert.match(text, /catalog_categories/);
  assert.match(text, /remaining !== 0/);
});

test('HTTP smoke checks health, Catalog and safe unauthenticated Admin bootstrap', async () => {
  const text = await source('scripts/smoke-http.mjs');
  assert.match(text, /\/api\/v1\/health/);
  assert.match(text, /\/api\/v1\/catalog\/products/);
  assert.match(text, /\/api\/v1\/admin\/auth\/bootstrap/);
  assert.match(text, /authenticated !== false/);
  assert.match(text, /passwordLogin/);
  assert.match(text, /available-not-credential-tested/);
});

test('host verification script is read-only and checks systemd, Apache and loopback socket', async () => {
  const text = await source('scripts/verify-host-readonly.sh');
  assert.match(text, /systemctl is-active/);
  assert.match(text, /apachectl configtest/);
  assert.match(text, /127\\\\\.0/);
  assert.match(text, /journalctl/);
  assert.doesNotMatch(text, /systemctl (?:restart|start|stop)|a2ensite|apt(?:-get)? install|rm -rf/);
});
