import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(app, id) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId: id }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedInstall(path) {
  const database = new DatabaseSync(path);
  const at = '2026-07-21T08:00:00.000Z';
  database.prepare(`INSERT INTO customers
    (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (1200, 'C-SUB-1200', 'PERSON', '合約測試客戶', 'ACTIVE', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO service_locations
    (id, location_no, customer_id, city, district, address_line, status, created_at, updated_at)
    VALUES (1200, 'L-SUB-1200', 1200, '台北市', '信義區', '合約路 12 號', 'SERVICEABLE', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO sales_orders
    (id, order_no, customer_id, service_location_id, order_type, status,
      sales_staff_user_id, ordered_at, subtotal_amount, tax_amount, total_amount,
      created_at, updated_at)
    VALUES (1200, 'SO-SUB-1200', 1200, 1200, 'NEW_SERVICE', 'APPROVED', 1, ?, 28800, 0, 28800, ?, ?)`).run(at, at, at);
  database.prepare(`INSERT INTO order_service_items
    (id, sales_order_id, service_plan_id, plan_price_id, quantity, unit_price,
      contract_months, description_snapshot, created_at)
    VALUES (1200, 1200, 1, 1, 1, 28800, 12, 'VDSL2 100M 月租方案', ?)`).run(at);
  database.prepare(`INSERT INTO work_orders
    (id, work_order_no, service_location_id, sales_order_id, work_type, priority,
      status, assigned_staff_user_id, scheduled_at, started_at, problem_description,
      created_at, updated_at)
    VALUES (1200, 'WO-SUB-1200', 1200, 1200, 'INSTALL', 'NORMAL', 'IN_PROGRESS', 3, ?, ?, '裝機', ?, ?)`).run(at, at, at, at);
  database.prepare(`INSERT INTO work_order_status_history
    (work_order_id, from_status, to_status, changed_by_staff_user_id, changed_at)
    VALUES (1200, 'SCHEDULED', 'IN_PROGRESS', 3, ?)`).run(at);
  database.close();
  return at;
}

async function completeInstall(app, session, expectedUpdatedAt) {
  return request(app, session, '/api/v1/admin/work-orders/1200/complete', {
    method: 'POST', body: {
      expectedUpdatedAt,
      resolutionNotes: '裝機與線路測試完成',
      installationVerified: true,
    },
  });
}

test('completed installation provisions and links one immutable subscription snapshot', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    workOrderClock: () => Date.parse('2026-07-21T16:00:00.000Z'),
  });
  const expectedUpdatedAt = seedInstall(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const completed = await completeInstall(app, admin, expectedUpdatedAt);
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'COMPLETED');
  assert.equal(completed.body.data.subscriptionId, 1);

  const list = await request(app, admin, '/api/v1/admin/subscriptions?status=PENDING&q=SUB-');
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data.length, 1);
  const detail = await request(app, admin, '/api/v1/admin/subscriptions/1');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.monthlyFee, '288.00');
  assert.equal(detail.body.data.contract.start, '2026-07-21');
  assert.equal(detail.body.data.contract.end, '2027-07-21');
  assert.equal(detail.body.data.sourceOrder.id, 1200);
  assert.equal(detail.body.data.workOrders[0].id, 1200);
  assert.deepEqual(detail.body.data.history.map(({ toStatus }) => toStatus), ['PENDING']);

  const database = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count), 1);
  database.close();
});

test('subscription lifecycle is optimistic, ordered, permission-bounded, and terminal-safe', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const expectedUpdatedAt = seedInstall(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const billing = await login(app, 4);
  assert.equal((await request(app, billing, '/api/v1/admin/subscriptions')).response.status, 403);
  await completeInstall(app, admin, expectedUpdatedAt);
  let current = (await request(app, admin, '/api/v1/admin/subscriptions/1')).body.data;
  current = (await request(app, admin, '/api/v1/admin/subscriptions/1/activate', {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt },
  })).body.data;
  current = (await request(app, admin, '/api/v1/admin/subscriptions/1/suspend', {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, reason: '等待線路檢修' },
  })).body.data;
  const stale = await request(app, admin, '/api/v1/admin/subscriptions/1/resume', {
    method: 'POST', body: { expectedUpdatedAt: expectedUpdatedAt },
  });
  assert.equal(stale.response.status, 409);
  current = (await request(app, admin, '/api/v1/admin/subscriptions/1/resume', {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt },
  })).body.data;
  current = (await request(app, admin, '/api/v1/admin/subscriptions/1/terminate', {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, reason: '客戶申請退租' },
  })).body.data;
  assert.equal(current.status, 'TERMINATED');
  assert.deepEqual(current.history.map(({ toStatus }) => toStatus), [
    'PENDING', 'ACTIVE', 'SUSPENDED', 'ACTIVE', 'TERMINATED',
  ]);
  const terminal = await request(app, admin, '/api/v1/admin/subscriptions/1/activate', {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt },
  });
  assert.equal(terminal.response.status, 409);
});

test('service-account metadata accepts secret references but never plaintext or returned secrets', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const expectedUpdatedAt = seedInstall(app.telecomDatabasePath);
  const admin = await login(app, 1);
  await completeInstall(app, admin, expectedUpdatedAt);
  const current = (await request(app, admin, '/api/v1/admin/subscriptions/1')).body.data;
  const plaintext = await request(app, admin, '/api/v1/admin/subscriptions/1/account', {
    method: 'PATCH', body: {
      expectedUpdatedAt: current.updatedAt,
      circuitNo: 'CIR-1200',
      ipAssignment: 'PPPOE',
      password: 'plain-secret',
    },
  });
  assert.equal(plaintext.response.status, 422);
  const saved = await request(app, admin, '/api/v1/admin/subscriptions/1/account', {
    method: 'PATCH', body: {
      expectedUpdatedAt: current.updatedAt,
      circuitNo: 'CIR-1200',
      accessUsername: 'user-1200',
      credentialSecretRef: 'vault://telecom/subscriptions/1',
      ipAssignment: 'PPPOE',
      staticIp: null,
      vlanId: 120,
    },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.data.serviceAccount.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(saved.body), /credentialSecretRef|plain-secret|vault:\/\//i);

  const database = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  const row = database.prepare('SELECT credential_secret_ref FROM service_accounts WHERE subscription_id = 1').get();
  assert.equal(row.credential_secret_ref, 'vault://telecom/subscriptions/1');
  database.close();
});

test('duplicate completion and audit failures preserve one subscription and its history', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const expectedUpdatedAt = seedInstall(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const attempts = await Promise.all([
    completeInstall(app, admin, expectedUpdatedAt),
    completeInstall(app, admin, expectedUpdatedAt),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [200, 409]);

  const before = (await request(app, admin, '/api/v1/admin/subscriptions/1')).body.data;
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_subscription_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'SUBSCRIPTION_ACTIVATED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();
  const failed = await request(app, admin, '/api/v1/admin/subscriptions/1/activate', {
    method: 'POST', body: { expectedUpdatedAt: before.updatedAt },
  });
  assert.equal(failed.response.status, 500);
  const after = (await request(app, admin, '/api/v1/admin/subscriptions/1')).body.data;
  assert.equal(after.status, 'PENDING');
  assert.deepEqual(after.history.map(({ toStatus }) => toStatus), ['PENDING']);

  const immutable = new DatabaseSync(app.telecomDatabasePath);
  assert.throws(
    () => immutable.prepare(`
      UPDATE subscription_status_history SET to_status = 'ACTIVE' WHERE subscription_id = 1
    `).run(),
    /append-only/i,
  );
  assert.throws(
    () => immutable.prepare('DELETE FROM subscription_status_history WHERE subscription_id = 1').run(),
    /append-only/i,
  );
  immutable.close();
});
