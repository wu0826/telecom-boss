import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const FIXED_NOW = Date.parse('2026-07-21T03:00:00.000Z');
const NOTIFICATION_PATH = '/api/v1/admin/notifications';

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function getNotifications(application, staffUserId, query = '') {
  const cookie = await login(application, staffUserId);
  const suffix = query ? `?${query}` : '';
  const response = await fetch(`${application.origin}${NOTIFICATION_PATH}${suffix}`, {
    headers: { cookie },
  });
  return { response, body: await response.json() };
}

function seedNotificationRows(databasePath, { additionalOpenWork = 0 } = {}) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  try {
    database.exec(`
      INSERT INTO customers (
        id, customer_no, customer_type, display_name, status, created_at, updated_at
      ) VALUES (600, 'CUS-NOTICE', 'PERSON', 'Very Private Notification Customer', 'ACTIVE',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

      INSERT INTO service_locations (
        id, location_no, customer_id, city, district, address_line, status,
        created_at, updated_at
      ) VALUES (600, 'LOC-NOTICE', 600, '台北市', '中正區', 'Extremely Private Notification Address',
        'SERVICEABLE', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

      INSERT INTO work_orders (
        id, work_order_no, service_location_id, work_type, priority, status,
        created_at, updated_at
      ) VALUES
        (600, 'WO-NOTICE-URGENT', 600, 'REPAIR', 'URGENT', 'OPEN',
          '2026-07-18T01:00:00.000Z', '2026-07-18T01:00:00.000Z'),
        (601, 'WO-NOTICE-HIGH', 600, 'INSTALL', 'HIGH', 'ASSIGNED',
          '2026-07-19T01:00:00.000Z', '2026-07-19T01:00:00.000Z'),
        (602, 'WO-NOTICE-DONE', 600, 'REPAIR', 'NORMAL', 'COMPLETED',
          '2026-07-20T01:00:00.000Z', '2026-07-20T01:00:00.000Z');

      INSERT INTO invoices (
        id, billing_period_key, invoice_no, customer_id, billing_period_start,
        billing_period_end, issued_at, due_date, subtotal_amount, tax_amount,
        total_amount, balance_due, status, created_at, updated_at
      ) VALUES
        (600, '600:2026-06', 'INV-NOTICE-OVERDUE', 600, '2026-06-01', '2026-06-30',
          '2026-07-01T00:00:00.000Z', '2026-07-19', 10000, 500, 10500, 10500,
          'ISSUED', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (601, '600:2026-07', 'INV-NOTICE-CURRENT', 600, '2026-07-01', '2026-07-31',
          '2026-07-20T00:00:00.000Z', '2026-07-21', 10000, 500, 10500, 10500,
          'ISSUED', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');

      INSERT INTO stock_items (
        id, sku, item_name, item_type, unit, reorder_level, is_active,
        created_at, updated_at
      ) VALUES (600, 'SKU-NOTICE', 'Private Router Name', 'EQUIPMENT', 'PCS', 5000, 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouses (
        id, warehouse_code, warehouse_name, is_active, created_at, updated_at
      ) VALUES (600, 'WH-NOTICE', 'Private Warehouse Name', 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouse_stock (
        id, balance_key, warehouse_id, stock_item_id, quantity_on_hand,
        quantity_reserved, updated_at
      ) VALUES (600, '600:600', 600, 600, 4000, 1000, '2026-07-20T03:00:00.000Z');

      INSERT INTO promotions (
        id, promotion_code, promotion_name, discount_type, discount_value, gift_quantity,
        starts_at, ends_at, is_active, created_at, updated_at
      ) VALUES
        (600, 'PROMO-NOTICE-SOON', 'Private Promotion Name', 'FIXED', 1000, 0,
          '2026-07-01T00:00:00.000Z', '2026-07-24T03:00:00.000Z', 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (601, 'PROMO-NOTICE-OUTSIDE', 'Outside Window', 'FIXED', 1000, 0,
          '2026-07-01T00:00:00.000Z', '2026-07-28T03:00:00.000Z', 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);

    const insertWorkOrder = database.prepare(`
      INSERT INTO work_orders (
        id, work_order_no, service_location_id, work_type, priority, status, created_at, updated_at
      ) VALUES (?, ?, 600, 'INSTALL', 'NORMAL', 'OPEN', ?, ?)
    `);
    for (let offset = 0; offset < additionalOpenWork; offset += 1) {
      const id = 700 + offset;
      const createdAt = `2026-07-20T${String(offset % 24).padStart(2, '0')}:00:00.000Z`;
      insertWorkOrder.run(id, `WO-NOTICE-LIMIT-${String(offset).padStart(2, '0')}`, createdAt, createdAt);
    }
  } finally {
    database.close();
  }
}

function reviewedCounts(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return [
      ['OVERDUE_INVOICE', database.prepare(`
        SELECT COUNT(*) AS count FROM invoices
        WHERE due_date < ? AND balance_due > 0 AND status IN ('ISSUED', 'PARTIAL', 'OVERDUE')
      `).get('2026-07-21').count],
      ['OPEN_WORK', database.prepare(`
        SELECT COUNT(*) AS count FROM work_orders
        WHERE status IN ('OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS')
      `).get().count],
      ['LOW_STOCK', database.prepare(`
        SELECT COUNT(*) AS count
        FROM warehouse_stock
        JOIN stock_items ON stock_items.id = warehouse_stock.stock_item_id
        JOIN warehouses ON warehouses.id = warehouse_stock.warehouse_id
        WHERE stock_items.is_active = 1 AND warehouses.is_active = 1
          AND warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved
            <= stock_items.reorder_level
      `).get().count],
      ['EXPIRING_PROMOTION', database.prepare(`
        SELECT COUNT(*) AS count FROM promotions
        WHERE is_active = 1 AND ends_at IS NOT NULL
          AND (starts_at IS NULL OR starts_at <= ?)
          AND ends_at >= ? AND ends_at < ?
      `).get(
        '2026-07-21T03:00:00.000Z',
        '2026-07-21T03:00:00.000Z',
        '2026-07-28T03:00:00.000Z',
      ).count],
    ].map(([type, count]) => ({ type, count: Number(count) }));
  } finally {
    database.close();
  }
}

test('in-app notifications are permission-filtered, reconciled, deterministic, and non-PII', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    notificationClock: () => FIXED_NOW,
  });
  seedNotificationRows(application.telecomDatabasePath);

  const expectedByRole = new Map([
    [2, []],
    [3, ['OPEN_WORK']],
    [4, ['OVERDUE_INVOICE']],
    [5, []],
  ]);
  for (const [staffUserId, expectedTypes] of expectedByRole) {
    const result = await getNotifications(application, staffUserId);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data.typeTotals.map(({ type }) => type), expectedTypes);
    assert.deepEqual([...new Set(result.body.data.notifications.map(({ type }) => type))], expectedTypes);
  }

  const first = await getNotifications(application, 1);
  const second = await getNotifications(application, 1);
  assert.equal(first.response.status, 200);
  assert.deepEqual(second.body.data, first.body.data);
  assert.equal(first.body.data.asOf, '2026-07-21T03:00:00.000Z');
  assert.equal(first.body.data.itemLimit, 50);
  assert.deepEqual(first.body.data.typeTotals, reviewedCounts(application.telecomDatabasePath));
  assert.deepEqual(first.body.data.notifications.slice(0, 4).map(({ id, type, reference, href }) => ({ id, type, reference, href })), [
    { id: 'invoice:INV-NOTICE-OVERDUE', type: 'OVERDUE_INVOICE', reference: 'INV-NOTICE-OVERDUE', href: '#billing' },
    { id: 'work-order:WO-NOTICE-URGENT', type: 'OPEN_WORK', reference: 'WO-NOTICE-URGENT', href: '#operations' },
    { id: 'work-order:WO-NOTICE-HIGH', type: 'OPEN_WORK', reference: 'WO-NOTICE-HIGH', href: '#operations' },
    { id: 'stock:SKU-NOTICE:WH-NOTICE', type: 'LOW_STOCK', reference: 'SKU-NOTICE', href: '#inventory' },
  ]);
  for (const notification of first.body.data.notifications) {
    assert.deepEqual(Object.keys(notification).sort(), [
      'detail', 'href', 'id', 'occurredAt', 'reference', 'severity', 'title', 'type',
    ]);
  }
  assert.deepEqual(new Set(first.body.data.notifications.map(({ href }) => href)), new Set([
    '#operations', '#billing', '#inventory', '#products',
  ]));
  assert.doesNotMatch(JSON.stringify(first.body), /Very Private Notification Customer|Extremely Private Notification Address|Private Router Name|Private Warehouse Name|Private Promotion Name/);
});

test('in-app notifications enforce a fixed global limit and reject client selectors without writes', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    notificationClock: () => FIXED_NOW,
  });
  seedNotificationRows(application.telecomDatabasePath, { additionalOpenWork: 55 });

  const before = reviewedCounts(application.telecomDatabasePath);
  const result = await getNotifications(application, 1);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.itemLimit, 50);
  assert.equal(result.body.data.notifications.length, 50);
  assert.equal(result.body.data.hasMore, true);
  assert.equal(result.body.data.total, before.reduce((sum, { count }) => sum + count, 0));
  assert.deepEqual(result.body.data.typeTotals, before);
  assert.deepEqual(reviewedCounts(application.telecomDatabasePath), before);

  const cookie = await login(application, 1);
  const anonymous = await fetch(`${application.origin}${NOTIFICATION_PATH}`);
  assert.equal(anonymous.status, 401);
  for (const query of ['limit=1', 'type=OPEN_WORK', 'type=OPEN_WORK&type=LOW_STOCK']) {
    const response = await fetch(`${application.origin}${NOTIFICATION_PATH}?${query}`, { headers: { cookie } });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'INVALID_QUERY');
  }
});
