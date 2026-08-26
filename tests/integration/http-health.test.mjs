import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { migrateMetadataDatabase } from '../../src/server/db/metadata-migration.mjs';
import { migrateTelecomTarget } from '../../src/server/db/migration-runner.mjs';
import { startApplicationServer } from '../../src/server/http/server.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const WEBSITE_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'website_db.schema.json');
const TELECOM_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');

async function fixture(t, { missingTelecom = false, bodyLimitBytes = 64 * 1024 } = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-http-'));
  const metadataDatabasePath = join(temporaryDirectory, 'website_db.sqlite');
  const telecomDatabasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  await migrateMetadataDatabase({
    databasePath: metadataDatabasePath,
    snapshotPath: WEBSITE_SNAPSHOT_PATH,
  });
  if (!missingTelecom) {
    await migrateTelecomTarget({
      databasePath: telecomDatabasePath,
      snapshotPath: TELECOM_SNAPSHOT_PATH,
    });
  }

  const application = await startApplicationServer({
    host: '127.0.0.1',
    port: 0,
    metadataDatabasePath,
    telecomDatabasePath,
    bodyLimitBytes,
  });
  t.after(async () => {
    await application.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  return application;
}

function assertSecurityHeaders(response) {
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
}

test('GET /api/v1/health checks both migrated databases', async (t) => {
  const application = await fixture(t);
  const response = await fetch(`${application.origin}/api/v1/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(body.status, 'ok');
  assert.deepEqual(body.databases, { metadata: 'ok', telecom: 'ok' });
  assert.equal(new Date(body.checkedAt).toISOString(), body.checkedAt);
});

test('health failure is generic and does not expose paths or stack traces', async (t) => {
  const application = await fixture(t, { missingTelecom: true });
  const response = await fetch(`${application.origin}/api/v1/health`);
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 503);
  assertSecurityHeaders(response);
  assert.deepEqual(body, {
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: '資料庫健康檢查失敗',
      details: [],
    },
  });
  assert.doesNotMatch(text, /telecom_boss\.sqlite|AppData|stack/i);
});

test('unknown routes and unsupported methods use the shared error contract', async (t) => {
  const application = await fixture(t);
  const missingResponse = await fetch(`${application.origin}/api/v1/not-found`);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), {
    error: { code: 'NOT_FOUND', message: '找不到要求的資源', details: [] },
  });

  const methodResponse = await fetch(`${application.origin}/api/v1/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'GET');
  assert.deepEqual(await methodResponse.json(), {
    error: { code: 'METHOD_NOT_ALLOWED', message: '此端點不支援該 HTTP 方法', details: [] },
  });
});

test('JSON parsing and body size limits fail closed', async (t) => {
  const application = await fixture(t, { bodyLimitBytes: 32 });
  const malformedResponse = await fetch(`${application.origin}/api/v1/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error.code, 'MALFORMED_JSON');

  const oversizedResponse = await fetch(`${application.origin}/api/v1/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(100) }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.equal((await oversizedResponse.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('server refuses a non-loopback bind address', async () => {
  await assert.rejects(
    () => startApplicationServer({
      host: '0.0.0.0',
      port: 0,
      metadataDatabasePath: 'unused',
      telecomDatabasePath: 'unused',
    }),
    /127\.0\.0\.1/,
  );
});
