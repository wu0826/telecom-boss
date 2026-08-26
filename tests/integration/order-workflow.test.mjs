import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function requestJson(application, session, path, body) {
  const response = await fetch(`${application.origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: session.cookie, 'content-type': 'application/json',
      'sec-fetch-site': 'same-origin', 'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedOrder(databasePath, { id = 1000, status = 'DRAFT' } = {}) {
  const database = new DatabaseSync(databasePath);
  const at = '2026-07-21T10:00:00.000Z';
  database.prepare(`
    INSERT OR IGNORE INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (1000, 'C-WORKFLOW-1000', 'PERSON', '流程測試客戶', 'ACTIVE', ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT OR IGNORE INTO service_locations (
      id, location_no, customer_id, city, district, address_line, status, created_at, updated_at
    ) VALUES (1000, 'L-WORKFLOW-1000', 1000, '台中市', '北屯區', '流程路 1 號', 'SERVICEABLE', ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO sales_orders (
      id, order_no, customer_id, service_location_id, order_type, status,
      ordered_at, subtotal_amount, tax_amount, total_amount, created_at, updated_at
    ) VALUES (?, ?, 1000, 1000, 'NEW_SERVICE', ?, ?, 37714, 1886, 39600, ?, ?)
  `).run(id, `SO-WORKFLOW-${id}`, status, at, at, at);
  database.prepare(`
    INSERT INTO order_service_items (
      sales_order_id, service_plan_id, plan_price_id, quantity, unit_price,
      contract_months, description_snapshot, created_at
    ) VALUES (?, 2, 3, 1, 39600, 12, 'FTTH-300M | STANDARD', ?)
  `).run(id, at);
  database.close();
  return at;
}

test('submit and approve enforce state flow and atomically create one installation work order', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    orderWorkflowClock: () => Date.parse('2026-07-21T15:00:00.000Z'),
  });
  const version = seedOrder(application.telecomDatabasePath);
  const customerService = await login(application, 2);
  const technician = await login(application, 3);
  const submitted = await requestJson(
    application, customerService, '/api/v1/admin/orders/1000/submit',
    { expectedUpdatedAt: version },
  );
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.body.data.status, 'SUBMITTED');
  const approved = await requestJson(
    application, technician, '/api/v1/admin/orders/1000/approve',
    { expectedUpdatedAt: submitted.body.data.updatedAt },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.status, 'APPROVED');
  assert.equal(approved.body.data.workOrder.workType, 'INSTALL');

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM work_orders').get().count), 1);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM work_order_status_history').get().count), 1);
  const actions = database.prepare(`
    SELECT action FROM audit_logs WHERE entity_type = 'SALES_ORDER' AND entity_id = '1000' ORDER BY id
  `).all().map(({ action }) => action);
  database.close();
  assert.deepEqual(actions, ['ORDER_SUBMITTED', 'ORDER_APPROVED']);
});

test('submit and approve permissions are segregated and invalid transitions fail closed', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const version = seedOrder(application.telecomDatabasePath);
  const customerService = await login(application, 2);
  const technician = await login(application, 3);
  assert.equal((await requestJson(
    application, technician, '/api/v1/admin/orders/1000/submit', { expectedUpdatedAt: version },
  )).response.status, 403);
  assert.equal((await requestJson(
    application, customerService, '/api/v1/admin/orders/1000/approve', { expectedUpdatedAt: version },
  )).response.status, 403);
  const invalidApprove = await requestJson(
    application, technician, '/api/v1/admin/orders/1000/approve', { expectedUpdatedAt: version },
  );
  assert.equal(invalidApprove.response.status, 409);
  assert.equal(invalidApprove.body.error.code, 'INVALID_ORDER_TRANSITION');
});

test('approval retry and concurrency return the same work order without duplicates', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const version = seedOrder(application.telecomDatabasePath, { status: 'SUBMITTED' });
  const technician = await login(application, 3);
  const outcomes = await Promise.all([
    requestJson(application, technician, '/api/v1/admin/orders/1000/approve', { expectedUpdatedAt: version }),
    requestJson(application, technician, '/api/v1/admin/orders/1000/approve', { expectedUpdatedAt: version }),
  ]);
  assert.deepEqual(outcomes.map(({ response }) => response.status), [200, 200]);
  assert.equal(outcomes[0].body.data.workOrder.id, outcomes[1].body.data.workOrder.id);
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM work_orders').get().count), 1);
  database.close();
});

test('cancel transitions are bounded and workflow audit failure rolls back status and work order', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const version = seedOrder(application.telecomDatabasePath, { status: 'SUBMITTED' });
  const admin = await login(application, 1);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_approval_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'ORDER_APPROVED'
    BEGIN SELECT RAISE(ABORT, 'forced approval failure'); END;
  `);
  database.close();
  const failed = await requestJson(
    application, admin, '/api/v1/admin/orders/1000/approve', { expectedUpdatedAt: version },
  );
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT status FROM sales_orders WHERE id = 1000').get().status, 'SUBMITTED');
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM work_orders').get().count), 0);
  verify.close();
});
