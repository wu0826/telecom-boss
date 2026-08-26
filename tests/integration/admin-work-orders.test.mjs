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

function seedLocation(path) {
  const db = new DatabaseSync(path);
  const at = '2026-07-21T08:00:00.000Z';
  db.prepare(`INSERT INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (1100, 'C-WO-1100', 'PERSON', '工單測試客戶', 'ACTIVE', ?, ?)`).run(at, at);
  db.prepare(`INSERT INTO service_locations
    (id, location_no, customer_id, city, district, address_line, status, created_at, updated_at)
    VALUES (1100, 'L-WO-1100', 1100, '台中市', '南區', '工單路 1 號', 'SERVICEABLE', ?, ?)`).run(at, at);
  db.close();
}

function createBody(overrides = {}) {
  return {
    serviceLocationId: 1100,
    subscriptionId: null,
    salesOrderId: null,
    workType: 'INSTALL',
    priority: 'NORMAL',
    problemDescription: '新裝服務',
    ...overrides,
  };
}

test('authorized operations user creates, filters, and reads a safe work-order detail', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedLocation(app.telecomDatabasePath);
  const tech = await login(app, 3);
  const created = await request(app, tech, '/api/v1/admin/work-orders', {
    method: 'POST', body: createBody(),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'OPEN');
  const list = await request(app, tech, '/api/v1/admin/work-orders?status=OPEN&q=WO-');
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data.length, 1);
  const detail = await request(app, tech, `/api/v1/admin/work-orders/${created.body.data.id}`);
  assert.equal(detail.body.data.history[0].toStatus, 'OPEN');
  assert.doesNotMatch(JSON.stringify(detail.body), /identity|accessNotes|phone|email/i);
});

test('scheduled date filters return the same authorized work-order projection used by every desktop view', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    workOrderClock: () => Date.parse('2026-07-21T16:00:00.000Z'),
  });
  seedLocation(app.telecomDatabasePath);
  const admin = await login(app, 1);

  async function createScheduledWorkOrder(scheduledAt) {
    let workOrder = (await request(app, admin, '/api/v1/admin/work-orders', {
      method: 'POST', body: createBody(),
    })).body.data;
    workOrder = (await request(app, admin, `/api/v1/admin/work-orders/${workOrder.id}/assign`, {
      method: 'POST', body: { expectedUpdatedAt: workOrder.updatedAt, assignedStaffUserId: 3 },
    })).body.data;
    return (await request(app, admin, `/api/v1/admin/work-orders/${workOrder.id}/schedule`, {
      method: 'POST', body: { expectedUpdatedAt: workOrder.updatedAt, scheduledAt },
    })).body.data;
  }

  const included = await createScheduledWorkOrder('2026-07-22T02:00:00.000Z');
  await createScheduledWorkOrder('2026-07-24T02:00:00.000Z');
  const filtered = await request(
    app,
    admin,
    '/api/v1/admin/work-orders?status=SCHEDULED&assignedStaffUserId=3&from=2026-07-21T16:00:00.000Z&to=2026-07-22T16:00:00.000Z',
  );
  assert.equal(filtered.response.status, 200);
  assert.deepEqual(filtered.body.data.map((workOrder) => workOrder.id), [included.id]);
  assert.equal(filtered.body.data[0].status, 'SCHEDULED');
  assert.equal(filtered.body.data[0].assignedStaff.id, 3);
});

test('assignment, scheduling, start, and completion append immutable ordered history', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    workOrderClock: () => Date.parse('2026-07-21T16:00:00.000Z'),
  });
  seedLocation(app.telecomDatabasePath);
  const admin = await login(app, 1);
  let current = (await request(app, admin, '/api/v1/admin/work-orders', {
    method: 'POST', body: createBody(),
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/work-orders/${current.id}/assign`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, assignedStaffUserId: 3 },
  })).body.data;
  assert.equal(current.status, 'ASSIGNED');
  current = (await request(app, admin, `/api/v1/admin/work-orders/${current.id}/schedule`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, scheduledAt: '2026-07-22T02:00:00.000Z' },
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/work-orders/${current.id}/start`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt },
  })).body.data;
  current = (await request(app, admin, `/api/v1/admin/work-orders/${current.id}/complete`, {
    method: 'POST', body: {
      expectedUpdatedAt: current.updatedAt,
      resolutionNotes: '光功率與連線測試完成',
      installationVerified: true,
    },
  })).body.data;
  assert.equal(current.status, 'COMPLETED');
  assert.deepEqual(current.history.map(({ toStatus }) => toStatus), [
    'OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED',
  ]);
  assert.equal(current.resolutionNotes, '光功率與連線測試完成');
});

test('stale, terminal, ineligible assignee, invalid schedule, and incomplete completion fail closed', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedLocation(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const current = (await request(app, admin, '/api/v1/admin/work-orders', {
    method: 'POST', body: createBody(),
  })).body.data;
  const invalidBodies = [
    ['assign', { expectedUpdatedAt: current.updatedAt, assignedStaffUserId: 4 }],
    ['schedule', { expectedUpdatedAt: current.updatedAt, scheduledAt: '2020-01-01T00:00:00.000Z' }],
    ['start', { expectedUpdatedAt: current.updatedAt }],
    ['complete', { expectedUpdatedAt: current.updatedAt, resolutionNotes: '', installationVerified: false }],
  ];
  for (const [action, body] of invalidBodies) {
    const result = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/${action}`, {
      method: 'POST', body,
    });
    assert.ok([409, 422].includes(result.response.status));
  }

  const assigned = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/assign`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, assignedStaffUserId: 3 },
  });
  assert.equal(assigned.response.status, 200);
  const stale = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/cancel`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, reason: '使用舊版本取消' },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'WORK_ORDER_CONFLICT');

  const cancelled = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/cancel`, {
    method: 'POST', body: { expectedUpdatedAt: assigned.body.data.updatedAt, reason: '客戶取消施工' },
  });
  assert.equal(cancelled.response.status, 200);
  const terminal = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/assign`, {
    method: 'POST', body: {
      expectedUpdatedAt: cancelled.body.data.updatedAt, assignedStaffUserId: 3,
    },
  });
  assert.equal(terminal.response.status, 409);
  assert.equal(terminal.body.error.code, 'INVALID_WORK_ORDER_TRANSITION');
  assert.deepEqual(cancelled.body.data.history.map(({ toStatus }) => toStatus), [
    'OPEN', 'ASSIGNED', 'CANCELLED',
  ]);
});

test('permissions, concurrent transitions, and audit failures preserve state and history', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedLocation(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const billing = await login(app, 4);
  assert.equal((await request(app, billing, '/api/v1/admin/work-orders')).response.status, 403);
  const current = (await request(app, admin, '/api/v1/admin/work-orders', {
    method: 'POST', body: createBody(),
  })).body.data;
  const db = new DatabaseSync(app.telecomDatabasePath);
  db.exec(`CREATE TRIGGER fail_wo_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'WORK_ORDER_ASSIGNED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  db.close();
  const failed = await request(app, admin, `/api/v1/admin/work-orders/${current.id}/assign`, {
    method: 'POST', body: { expectedUpdatedAt: current.updatedAt, assignedStaffUserId: 3 },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT status FROM work_orders WHERE id = ?').get(current.id).status, 'OPEN');
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM work_order_status_history WHERE work_order_id = ?').get(current.id).count), 1);
  verify.close();
});

test('work-order status history is append-only at the database boundary', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedLocation(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const current = (await request(app, admin, '/api/v1/admin/work-orders', {
    method: 'POST', body: createBody(),
  })).body.data;
  const database = new DatabaseSync(app.telecomDatabasePath);
  assert.throws(
    () => database.prepare(`
      UPDATE work_order_status_history SET to_status = 'CANCELLED' WHERE work_order_id = ?
    `).run(current.id),
    /append-only/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM work_order_status_history WHERE work_order_id = ?').run(current.id),
    /append-only/i,
  );
  database.close();
});
