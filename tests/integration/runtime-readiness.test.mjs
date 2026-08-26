import assert from 'node:assert/strict';
import test from 'node:test';

import { startApplicationServer } from '../../src/server/http/server.mjs';

function fakeRuntimeDatabase(databaseName, migrations) {
  let closeCount = 0;
  return {
    kind: 'mysql',
    databaseName,
    prepare(sql) {
      return {
        async get(name) {
          if (/FROM _schema_migrations/.test(sql)) {
            return migrations.has(name) ? { name } : undefined;
          }
          return undefined;
        },
        async all() { return []; },
        async run() { return { changes: 0, lastInsertRowid: 0 }; },
      };
    },
    async execute() {},
    async transaction(operation) { return operation(this); },
    async ping() { return true; },
    async close() { closeCount += 1; },
    get closeCount() { return closeCount; },
  };
}

test('startup readiness refuses a telecom database missing Catalog V2 and closes both databases', async () => {
  const metadataDatabase = fakeRuntimeDatabase('website_db', new Set(['create_metadata_schema']));
  const telecomDatabase = fakeRuntimeDatabase('telecom_boss', new Set(['create_telecom_schema']));

  await assert.rejects(
    () => startApplicationServer({
      host: '127.0.0.1',
      port: 0,
      metadataDatabase,
      telecomDatabase,
      requireStartupReadiness: true,
    }),
    /Runtime database readiness check failed: telecom/,
  );

  assert.equal(metadataDatabase.closeCount, 1);
  assert.equal(telecomDatabase.closeCount, 1);
});

test('startup readiness accepts both required schemas before listening', async (t) => {
  const metadataDatabase = fakeRuntimeDatabase('website_db', new Set(['create_metadata_schema']));
  const telecomDatabase = fakeRuntimeDatabase('telecom_boss', new Set([
    'create_telecom_schema',
    'create_catalog_v2_schema',
    'create_admin_password_auth',
  ]));

  const application = await startApplicationServer({
    host: '127.0.0.1',
    port: 0,
    metadataDatabase,
    telecomDatabase,
    requireStartupReadiness: true,
  });
  t.after(() => application.close());

  const response = await fetch(`${application.origin}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).databases, { metadata: 'ok', telecom: 'ok' });
});
