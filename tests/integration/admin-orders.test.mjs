import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function requestJson(application, session, path, {
  method = 'GET', body, idempotencyKey,
} = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['sec-fetch-site'] = 'same-origin';
    headers['x-csrf-token'] = session.csrfToken;
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${application.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedOrderReferences(databasePath) {
  const database = new DatabaseSync(databasePath);
  const at = '2026-01-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (900, 'C-ORDER-900', 'BUSINESS', '訂單測試客戶', 'ACTIVE', ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO service_locations (
      id, location_no, customer_id, city, district, address_line, status, created_at, updated_at
    ) VALUES (901, 'L-ORDER-901', 900, '台中市', '西屯區', '測試路 1 號', 'SERVICEABLE', ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO engineering_projects (
      id, project_no, customer_id, service_location_id, project_type, project_name,
      status, estimated_amount, created_at, updated_at
    ) VALUES (902, 'P-ORDER-902', 900, 901, 'NETWORK_BUILD', '企業網路建置',
      'APPROVED', 500000, ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO stock_items (
      id, sku, item_name, item_type, equipment_model_id, unit,
      standard_cost, selling_price, reorder_level, is_active, created_at, updated_at
    ) VALUES (903, 'SKU-ROUTER-903', 'Archer A6 零售設備', 'EQUIPMENT', 1, 'PCS',
      90000, 150000, 1, 1, ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO warehouses (id, warehouse_code, warehouse_name, is_active, created_at, updated_at)
    VALUES (904, 'WH-ORDER-904', '訂單測試倉', 1, ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO warehouse_stock (
      id, balance_key, warehouse_id, stock_item_id, quantity_on_hand, quantity_reserved, updated_at
    ) VALUES (905, '904:903', 904, 903, 5000, 1000, ?)
  `).run(at);
  database.close();
}

function draftPayload(overrides = {}) {
  return {
    customerId: 900,
    serviceLocationId: 901,
    engineeringProjectId: 902,
    orderType: 'NEW_SERVICE',
    notes: '由已轉換洽詢建立',
    serviceItems: [{ servicePlanId: 2, planPriceId: 3, promotionId: 1, quantity: 1 }],
    productItems: [{ stockItemId: 903, quantity: 1 }],
    ...overrides,
  };
}

test('draft creation resolves references, prices, promotion, tax, and immutable snapshots server-side', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    orderClock: () => Date.parse('2026-07-21T14:00:00.000Z'),
  });
  seedOrderReferences(application.telecomDatabasePath);
  const admin = await login(application, 1);
  const created = await requestJson(application, admin, '/api/v1/admin/orders', {
    method: 'POST', body: draftPayload(), idempotencyKey: randomUUID(),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'DRAFT');
  assert.deepEqual(created.body.data.amounts, {
    subtotal: '1805.71', tax: '90.29', total: '1896.00',
  });
  assert.equal(created.body.data.serviceItems[0].unitPrice, '396.00');
  assert.equal(created.body.data.serviceItems[0].contractMonths, 12);
  assert.match(created.body.data.serviceItems[0].descriptionSnapshot, /FTTH-300M.*STANDARD.*FTTH-A6-GIFT/);
  assert.equal(created.body.data.productItems[0].unitPrice, '1500.00');

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const stored = database.prepare(`
    SELECT subtotal_amount, tax_amount, total_amount FROM sales_orders WHERE id = ?
  `).get(created.body.data.id);
  const item = database.prepare(`
    SELECT unit_price, contract_months, description_snapshot FROM order_service_items
    WHERE sales_order_id = ?
  `).get(created.body.data.id);
  database.close();
  assert.deepEqual({ ...stored }, { subtotal_amount: 180571, tax_amount: 9029, total_amount: 189600 });
  assert.equal(Number(item.unit_price), 39600);
  assert.match(item.description_snapshot, /FTTH-300M.*STANDARD.*FTTH-A6-GIFT/);
});

test('draft submission is idempotent and conflicting key reuse fails', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedOrderReferences(application.telecomDatabasePath);
  const admin = await login(application, 1);
  const key = randomUUID();
  const first = await requestJson(application, admin, '/api/v1/admin/orders', {
    method: 'POST', body: draftPayload(), idempotencyKey: key,
  });
  const replay = await requestJson(application, admin, '/api/v1/admin/orders', {
    method: 'POST', body: draftPayload(), idempotencyKey: key,
  });
  const conflict = await requestJson(application, admin, '/api/v1/admin/orders', {
    method: 'POST', body: draftPayload({ notes: '不同內容' }), idempotencyKey: key,
  });
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count), 1);
  database.close();
});

test('invalid ownership, inactive references, unsafe totals, and insufficient stock roll back fully', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedOrderReferences(application.telecomDatabasePath);
  const admin = await login(application, 1);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (910, 'C-OTHER-910', 'PERSON', '其他客戶', 'ACTIVE', ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.prepare('UPDATE stock_items SET is_active = 0 WHERE id = 903').run();
  database.close();

  const invalidCases = [
    draftPayload({ customerId: 910 }),
    draftPayload({ productItems: [{ stockItemId: 903, quantity: 1 }] }),
    draftPayload({ productItems: [{ stockItemId: 903, quantity: 999 }] }),
    { ...draftPayload(), totalAmount: '1.00' },
    draftPayload({ serviceItems: [{ servicePlanId: 1, planPriceId: 4, promotionId: 1, quantity: 1 }] }),
  ];
  for (const body of invalidCases) {
    const result = await requestJson(application, admin, '/api/v1/admin/orders', {
      method: 'POST', body, idempotencyKey: randomUUID(),
    });
    assert.ok([409, 422].includes(result.response.status));
  }
  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count), 0);
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM order_service_items').get().count), 0);
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM order_product_items').get().count), 0);
  verify.close();
});

test('order list/detail are permission-bounded and audit failure rolls back all writes', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedOrderReferences(application.telecomDatabasePath);
  const admin = await login(application, 1);
  const billingStaff = await login(application, 4);
  const denied = await requestJson(application, billingStaff, '/api/v1/admin/orders');
  assert.equal(denied.response.status, 403);

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_order_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'ORDER_DRAFT_CREATED'
    BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
  `);
  database.close();
  const failed = await requestJson(application, admin, '/api/v1/admin/orders', {
    method: 'POST', body: draftPayload(), idempotencyKey: randomUUID(),
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count), 0);
  verify.close();
});
