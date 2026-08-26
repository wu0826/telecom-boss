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

function seedSubscriptions(path) {
  const db = new DatabaseSync(path);
  const at = '2026-07-21T08:00:00.000Z';
  for (const id of [1300, 1301]) {
    db.prepare(`INSERT INTO customers
      (id, customer_no, customer_type, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'PERSON', ?, 'ACTIVE', ?, ?)`).run(id, `C-OUT-${id}`, `障礙測試客戶 ${id}`, at, at);
    db.prepare(`INSERT INTO service_locations
      (id, location_no, customer_id, city, district, address_line, status, created_at, updated_at)
      VALUES (?, ?, ?, '台北市', '信義區', ?, 'SERVICEABLE', ?, ?)`).run(
      id, `L-OUT-${id}`, id, `私密地址 ${id} 號`, at, at,
    );
    db.prepare(`INSERT INTO subscriptions
      (id, subscription_no, customer_id, service_location_id, service_plan_id, status,
        contract_start_date, contract_end_date, activated_at, monthly_fee, billing_day,
        auto_renew, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, '2026-01-01', '2027-01-01', ?, 28800, 1, 0, ?, ?)`).run(
      id, `SUB-OUT-${id}`, id, id, id === 1300 ? 'ACTIVE' : 'PENDING',
      id === 1300 ? at : null, at, at,
    );
  }
  db.prepare(`INSERT INTO service_accounts
    (id, subscription_id, circuit_no, access_username, credential_secret_ref,
      ip_assignment, created_at, updated_at)
    VALUES (1300, 1300, 'CIR-PRIVATE-1300', 'private-user', 'vault://private/1300',
      'PPPOE', ?, ?)`).run(at, at);
  db.close();
}

function incidentBody(overrides = {}) {
  return {
    title: '信義區骨幹線路異常', severity: 'MAJOR', serviceAreaId: null,
    detectedAt: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

test('operations staff creates, filters, and reads derived outage impact counts', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const tech = await login(app, 3);
  const created = await request(app, tech, '/api/v1/admin/outages', {
    method: 'POST', body: incidentBody(),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'INVESTIGATING');
  assert.deepEqual(created.body.data.impact, { subscriptions: 0, customers: 0 });
  const added = await request(app, tech, `/api/v1/admin/outages/${created.body.data.id}/subscriptions`, {
    method: 'POST', body: {
      expectedUpdatedAt: created.body.data.updatedAt, subscriptionId: 1300,
      notes: '骨幹節點關聯',
    },
  });
  assert.equal(added.response.status, 200);
  assert.deepEqual(added.body.data.impact, { subscriptions: 1, customers: 1 });
  const list = await request(app, tech, '/api/v1/admin/outages?status=INVESTIGATING&severity=MAJOR&q=骨幹');
  assert.equal(list.body.data.length, 1);
  assert.deepEqual(list.body.data[0].impact, { subscriptions: 1, customers: 1 });
});

test('outage membership accepts active subscriptions only and stays unique under concurrency', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const outage = (await request(app, admin, '/api/v1/admin/outages', {
    method: 'POST', body: incidentBody(),
  })).body.data;
  const pending = await request(app, admin, `/api/v1/admin/outages/${outage.id}/subscriptions`, {
    method: 'POST', body: {
      expectedUpdatedAt: outage.updatedAt, subscriptionId: 1301, notes: null,
    },
  });
  assert.equal(pending.response.status, 409);
  const attempts = await Promise.all([
    request(app, admin, `/api/v1/admin/outages/${outage.id}/subscriptions`, {
      method: 'POST', body: { expectedUpdatedAt: outage.updatedAt, subscriptionId: 1300, notes: null },
    }),
    request(app, admin, `/api/v1/admin/outages/${outage.id}/subscriptions`, {
      method: 'POST', body: { expectedUpdatedAt: outage.updatedAt, subscriptionId: 1300, notes: null },
    }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [200, 409]);
  const db = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM outage_subscriptions').get().count), 1);
  db.close();
});

test('outage follows the strict lifecycle and public draft contains no private service data', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const admin = await login(app, 1);
  let current = (await request(app, admin, '/api/v1/admin/outages', {
    method: 'POST', body: incidentBody(),
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/outages/${current.id}/subscriptions`, {
    method: 'POST', body: {
      expectedUpdatedAt: current.updatedAt, subscriptionId: 1300, notes: '內部私密說明',
    },
  })).body.data;
  const invalid = await request(app, admin, `/api/v1/admin/outages/${current.id}/monitor`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, resolutionNotes: '觀察' },
  });
  assert.equal(invalid.response.status, 409);
  current = (await request(app, admin, `/api/v1/admin/outages/${current.id}/identify`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, rootCause: '上游骨幹設備故障' },
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/outages/${current.id}/monitor`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, resolutionNotes: '流量已切換備援' },
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/outages/${current.id}/resolve`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, resolutionNotes: '服務恢復穩定' },
  })).body.data;
  assert.equal(current.status, 'RESOLVED');
  assert.ok(current.resolvedAt);
  assert.match(current.publicAnnouncementDraft, /影響 1 項服務/);
  assert.doesNotMatch(current.publicAnnouncementDraft, /障礙測試客戶|私密地址|CIR-PRIVATE|private-user|vault|內部私密/i);
});

test('outage permission, stale versions, and audit failure leave incident membership unchanged', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const billing = await login(app, 4);
  assert.equal((await request(app, billing, '/api/v1/admin/outages')).response.status, 403);
  const current = (await request(app, admin, '/api/v1/admin/outages', {
    method: 'POST', body: incidentBody(),
  })).body.data;
  const db = new DatabaseSync(app.telecomDatabasePath);
  db.exec(`CREATE TRIGGER fail_outage_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'OUTAGE_SUBSCRIPTION_ADDED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  db.close();
  const failed = await request(app, admin, `/api/v1/admin/outages/${current.id}/subscriptions`, {
    method: 'POST', body: {
      expectedUpdatedAt: current.updatedAt, subscriptionId: 1300, notes: null,
    },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM outage_subscriptions').get().count), 0);
  assert.equal(verify.prepare('SELECT updated_at FROM outage_incidents WHERE id = ?').get(current.id).updated_at, current.updatedAt);
  verify.close();
});
