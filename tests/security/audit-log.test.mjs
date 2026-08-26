import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAuditService } from '../../src/server/admin/audit/audit-service.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';
import { createSqliteRuntimeDatabase, runInTransaction } from '../../src/server/db/runtime-database.mjs';
import { startSeededApplication } from '../helpers/seeded-application.mjs';

const SNAPSHOT_PATH = resolve('database/snapshots/telecom_boss.schema.json');

async function migratedDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'telecom-audit-'));
  const databasePath = join(directory, 'telecom_boss.sqlite');
  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return databasePath;
}

test('audit service appends request-correlated events and keeps only safe allowlisted fields', async (t) => {
  const databasePath = await migratedDatabase(t);
  const audit = createAuditService({ databasePath });

  const event = await audit.record({
    action: 'CUSTOMER_STATUS_CHANGED',
    entityType: 'CUSTOMER',
    entityId: 'CUS-100',
    requestId: '00000000-0000-4000-8000-000000000001',
    ipAddress: '127.0.0.1',
    userAgent: 'audit-test',
    allowedFields: ['status', 'phone', 'identityHash', 'permissionCodes'],
    before: { status: 'PENDING', phone: '0912345678', identityHash: 'private' },
    after: {
      status: 'ACTIVE',
      phone: '0987654321',
      identityHash: 'private',
      permissionCodes: ['customer.read'],
    },
  });

  assert.equal(event.action, 'CUSTOMER_STATUS_CHANGED');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database.prepare('SELECT * FROM audit_logs WHERE id = ?').get(event.id);
  database.close();
  assert.equal(row.request_id, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(JSON.parse(row.before_json), { status: 'PENDING' });
  assert.deepEqual(JSON.parse(row.after_json), {
    status: 'ACTIVE',
    permissionCodes: ['customer.read'],
  });
  assert.doesNotMatch(`${row.before_json}${row.after_json}`, /0912|0987|private/);
});

test('database triggers reject audit updates and deletes while preserving rows', async (t) => {
  const databasePath = await migratedDatabase(t);
  const audit = createAuditService({ databasePath });
  const event = await audit.record({ action: 'ADMIN_LOGIN_FAILED', entityType: 'SESSION' });
  const database = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () => database.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('TAMPERED', event.id),
      /append-only/i,
    );
    assert.throws(
      () => database.prepare('DELETE FROM audit_logs WHERE id = ?').run(event.id),
      /append-only/i,
    );
    assert.equal(database.prepare('SELECT action FROM audit_logs WHERE id = ?').get(event.id).action, 'ADMIN_LOGIN_FAILED');
  } finally {
    database.close();
  }
});

test('audit records share business rollback and failure events append only after rollback', async (t) => {
  const databasePath = await migratedDatabase(t);
  const audit = createAuditService({ databasePath });
  const runtimeDatabase = createSqliteRuntimeDatabase(databasePath);
  await assert.rejects(
    runInTransaction(runtimeDatabase, async (database) => {
      await audit.record({
        action: 'ORDER_APPROVED',
        entityType: 'SALES_ORDER',
        entityId: 'SO-1',
      }, { database });
      throw new Error('simulated business failure');
    }),
    /simulated business failure/,
  );
  await runtimeDatabase.close();
  const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(rolledBack.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 0);
  rolledBack.close();

  await audit.record({
    action: 'ORDER_APPROVAL_FAILED',
    entityType: 'SALES_ORDER',
    entityId: 'SO-1',
  });
  const verification = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    verification.prepare('SELECT action FROM audit_logs').all().map((row) => row.action),
    ['ORDER_APPROVAL_FAILED'],
  );
  verification.close();
});

test('login, logout, and permission denials produce privacy-safe HTTP audit events', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const adminLogin = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'user-agent': 'audit-browser' },
    body: JSON.stringify({ staffUserId: 1 }),
  });
  const adminBody = await adminLogin.json();
  const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0];

  const customerLogin = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId: 2 }),
  });
  const customerCookie = customerLogin.headers.get('set-cookie').split(';', 1)[0];
  const denied = await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
    headers: { cookie: customerCookie },
  });
  assert.equal(denied.status, 403);

  const logout = await fetch(`${application.origin}/api/v1/admin/auth/logout`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': adminBody.data.csrfToken,
    },
  });
  assert.equal(logout.status, 200);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const rows = database.prepare(`
    SELECT action, actor_staff_user_id, request_id, before_json, after_json
    FROM audit_logs
    ORDER BY id
  `).all();
  database.close();
  assert.deepEqual(rows.map((row) => row.action), [
    'ADMIN_LOGIN_SUCCEEDED',
    'ADMIN_LOGIN_SUCCEEDED',
    'ADMIN_PERMISSION_DENIED',
    'ADMIN_LOGOUT_SUCCEEDED',
  ]);
  assert.ok(rows.every((row) => row.request_id));
  assert.doesNotMatch(JSON.stringify(rows), /token|cookie|csrf|email|phone/i);
});
