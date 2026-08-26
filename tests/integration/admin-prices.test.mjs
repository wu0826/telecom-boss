import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get('set-cookie').split(';', 1)[0],
    csrfToken: body.data.csrfToken,
  };
}

async function requestJson(application, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['sec-fetch-site'] = 'same-origin';
    headers['x-csrf-token'] = session.csrfToken;
  }
  const response = await fetch(`${application.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function pricePayload(overrides = {}) {
  return {
    priceType: 'STANDARD',
    billingCycle: 'MONTHLY',
    amount: '499.00',
    monthFrom: 1,
    monthTo: 12,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    priority: 50,
    isActive: true,
    ...overrides,
  };
}

test('price list returns fixed-scale strings and adjacent periods update public pricing', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const seeded = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices');
  assert.equal(seeded.response.status, 200);
  assert.equal(seeded.body.data[0].amount, '288.00');
  assert.doesNotMatch(JSON.stringify(seeded.body), /price_period_key|created_at|updated_at/i);

  const first = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices', {
    method: 'POST', body: pricePayload(),
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.data.amount, '499.00');
  const adjacent = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices', {
    method: 'POST', body: pricePayload({ amount: '599.50', monthFrom: 13, monthTo: 24 }),
  });
  assert.equal(adjacent.response.status, 201);

  const publicPlan = await fetch(`${application.origin}/api/v1/catalog/plans/1`).then(
    (response) => response.json(),
  );
  assert.equal(publicPlan.plan.prices.some(({ amount }) => amount === '499.00'), true);
  assert.equal(publicPlan.plan.prices.some(({ amount }) => amount === '599.50'), true);
});

test('price validation rejects unsafe money, enums, cycles, and reversed ranges', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const invalidCases = [
    pricePayload({ amount: '-1.00' }),
    pricePayload({ amount: '12.345' }),
    pricePayload({ amount: 12.34 }),
    pricePayload({ amount: '10000000000.00' }),
    pricePayload({ priceType: 'UNSAFE' }),
    pricePayload({ billingCycle: 'WEEKLY' }),
    pricePayload({ monthFrom: 12, monthTo: 1 }),
    pricePayload({ effectiveFrom: '2026-12-31', effectiveTo: '2026-01-01' }),
    pricePayload({ billingCycle: 'ONE_TIME', monthFrom: 1, monthTo: 1 }),
    { ...pricePayload(), pricePeriodKey: 'client-owned' },
  ];
  for (const body of invalidCases) {
    const result = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices', {
      method: 'POST', body,
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.error.code, 'INVALID_BODY');
  }
});

test('overlap checks are transactional and concurrent conflicting inserts commit once', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const first = await requestJson(application, admin, '/api/v1/admin/catalog/plans/2/prices', {
    method: 'POST', body: pricePayload({ effectiveTo: '2026-06-30' }),
  });
  assert.equal(first.response.status, 201);
  const overlap = await requestJson(application, admin, '/api/v1/admin/catalog/plans/2/prices', {
    method: 'POST', body: pricePayload({ monthFrom: 12, monthTo: 18, effectiveFrom: '2026-06-01' }),
  });
  assert.equal(overlap.response.status, 409);
  assert.equal(overlap.body.error.code, 'PRICE_PERIOD_OVERLAP');

  const concurrentBodies = [
    pricePayload({ priceType: 'DEPOSIT', billingCycle: 'ONE_TIME', monthFrom: null, monthTo: null,
      effectiveFrom: '2027-01-01', effectiveTo: '2027-06-30', amount: '1000.00' }),
    pricePayload({ priceType: 'DEPOSIT', billingCycle: 'ONE_TIME', monthFrom: null, monthTo: null,
      effectiveFrom: '2027-03-01', effectiveTo: '2027-12-31', amount: '1200.00' }),
  ];
  const outcomes = await Promise.all(concurrentBodies.map((body) => requestJson(
    application, admin, '/api/v1/admin/catalog/plans/2/prices', { method: 'POST', body },
  )));
  assert.deepEqual(outcomes.map(({ response }) => response.status).toSorted(), [201, 409]);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const deposits = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM plan_prices
    WHERE service_plan_id = 2 AND price_type = 'DEPOSIT' AND priority = 50 AND is_active = 1
  `).get().count);
  database.close();
  assert.equal(deposits, 1);
});

test('price updates use optimistic versions and never mutate historical order snapshots', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    priceClock: () => Date.parse('2026-07-21T13:00:00.000Z'),
  });
  const admin = await login(application, 1);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (800, 'C-PRICE-800', 'PERSON', '歷史價格客戶', 'ACTIVE', ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.prepare(`
    INSERT INTO sales_orders (
      id, order_no, customer_id, order_type, status, ordered_at,
      subtotal_amount, tax_amount, total_amount, created_at, updated_at
    ) VALUES (801, 'O-PRICE-801', 800, 'NEW_SERVICE', 'DRAFT', ?, 28800, 0, 28800, ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.prepare(`
    INSERT INTO order_service_items (
      id, sales_order_id, service_plan_id, plan_price_id, quantity,
      unit_price, contract_months, description_snapshot, created_at
    ) VALUES (802, 801, 1, 1, 1, 28800, 12, '成交時每月 288.00', ?)
  `).run('2026-01-01T00:00:00.000Z');
  database.close();

  const list = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices');
  const original = list.body.data.find(({ id }) => id === 1);
  const updated = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices/1', {
    method: 'PATCH', body: {
      ...pricePayload({
        priceType: original.priceType,
        billingCycle: original.billingCycle,
        monthFrom: original.monthFrom,
        monthTo: original.monthTo,
        effectiveFrom: original.effectiveFrom,
        effectiveTo: original.effectiveTo,
        priority: original.priority,
        amount: '299.00',
      }),
      expectedUpdatedAt: original.updatedAt,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.amount, '299.00');
  const stale = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/prices/1', {
    method: 'PATCH', body: { ...pricePayload(), expectedUpdatedAt: original.updatedAt },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'PRICE_CONFLICT');

  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const snapshot = verify.prepare(`
    SELECT unit_price, contract_months, description_snapshot FROM order_service_items WHERE id = 802
  `).get();
  verify.close();
  assert.deepEqual(
    { ...snapshot, unit_price: Number(snapshot.unit_price), contract_months: Number(snapshot.contract_months) },
    { unit_price: 28800, contract_months: 12, description_snapshot: '成交時每月 288.00' },
  );

  const referencedDelete = await requestJson(
    application, admin, '/api/v1/admin/catalog/plans/1/prices/1',
    { method: 'DELETE', body: { expectedUpdatedAt: updated.body.data.updatedAt } },
  );
  assert.equal(referencedDelete.response.status, 409);
  assert.equal(referencedDelete.body.error.code, 'PRICE_REFERENCED');
});

test('price writes enforce catalog permission, CSRF, and rollback audit with the write', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);
  const denied = await requestJson(application, customerService, '/api/v1/admin/catalog/plans/1/prices');
  assert.equal(denied.response.status, 403);

  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/catalog/plans/1/prices`, {
    method: 'POST',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(pricePayload()),
  });
  assert.equal(missingCsrf.status, 403);

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_price_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'PLAN_PRICE_CREATED'
    BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
  `);
  database.close();
  const failed = await requestJson(application, admin, '/api/v1/admin/catalog/plans/2/prices', {
    method: 'POST', body: pricePayload(),
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const rows = Number(verify.prepare(`
    SELECT COUNT(*) AS count FROM plan_prices
    WHERE service_plan_id = 2 AND price_type = 'STANDARD' AND priority = 50
  `).get().count);
  verify.close();
  assert.equal(rows, 0);
});
