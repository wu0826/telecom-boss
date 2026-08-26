import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const FIXED_NOW = Date.parse('2026-07-21T03:00:00.000Z');

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

function seedDashboardRows(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  try {
    database.exec(`
      INSERT INTO customers (
        id, customer_no, customer_type, display_name, status, created_at, updated_at
      ) VALUES (100, 'CUS-DASH', 'PERSON', 'Dashboard Private Customer', 'ACTIVE',
        '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z');

      INSERT INTO service_locations (
        id, location_no, customer_id, city, district, address_line, status,
        created_at, updated_at
      ) VALUES (100, 'LOC-DASH', 100, '台北市', '中正區', 'Private address',
        'SERVICEABLE', '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z');

      INSERT INTO service_inquiries (
        id, inquiry_no, prospect_name, phone, requested_plan_id, channel, status,
        created_at, updated_at
      ) VALUES
        (100, 'WEB-DASH-TODAY', 'Private Prospect', '0912345678', 1, 'WEB', 'NEW',
          '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z'),
        (101, 'WEB-DASH-YESTERDAY', 'Previous Prospect', '0987654321', 1, 'WEB', 'NEW',
          '2026-07-20T15:59:59.999Z', '2026-07-20T15:59:59.999Z');

      INSERT INTO work_orders (
        id, work_order_no, service_location_id, work_type, priority, status,
        created_at, updated_at
      ) VALUES
        (100, 'WO-DASH-OPEN', 100, 'INSTALL', 'HIGH', 'OPEN',
          '2026-07-20T16:30:00.000Z', '2026-07-20T16:30:00.000Z'),
        (101, 'WO-DASH-DONE', 100, 'REPAIR', 'NORMAL', 'COMPLETED',
          '2026-07-20T16:30:00.000Z', '2026-07-20T18:00:00.000Z');

      INSERT INTO invoices (
        id, billing_period_key, invoice_no, customer_id, billing_period_start,
        billing_period_end, issued_at, due_date, subtotal_amount, tax_amount,
        total_amount, balance_due, status, created_at, updated_at
      ) VALUES
        (100, '100:2026-06', 'INV-DASH-DUE', 100, '2026-06-01', '2026-06-30',
          '2026-07-01T00:00:00.000Z', '2026-07-20', 10000, 500, 10500, 10500,
          'ISSUED', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (101, '100:2026-05', 'INV-DASH-PAID', 100, '2026-05-01', '2026-05-31',
          '2026-06-01T00:00:00.000Z', '2026-06-20', 10000, 500, 10500, 0,
          'PAID', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

      INSERT INTO stock_items (
        id, sku, item_name, item_type, unit, reorder_level, is_active,
        created_at, updated_at
      ) VALUES (100, 'SKU-DASH', 'Dashboard Router', 'EQUIPMENT', 'PCS', 5000, 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouses (
        id, warehouse_code, warehouse_name, is_active, created_at, updated_at
      ) VALUES (100, 'WH-DASH', 'Dashboard Warehouse', 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouse_stock (
        id, balance_key, warehouse_id, stock_item_id, quantity_on_hand,
        quantity_reserved, updated_at
      ) VALUES (100, '100:100', 100, 100, 4000, 1000, '2026-07-21T02:00:00.000Z');
    `);
  } finally {
    database.close();
  }
}

async function getDashboard(application, staffUserId) {
  const cookie = await login(application, staffUserId);
  const response = await fetch(`${application.origin}/api/v1/admin/dashboard`, {
    headers: { cookie },
  });
  return { response, text: await response.text() };
}

test('dashboard filters cards and queue DTOs by effective role permissions', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    dashboardClock: () => FIXED_NOW,
  });
  seedDashboardRows(application.telecomDatabasePath);

  const administrator = await getDashboard(application, 1);
  assert.equal(administrator.response.status, 200);
  const administratorBody = JSON.parse(administrator.text);
  assert.deepEqual(administratorBody.data.cards.map(({ key, count }) => ({ key, count })), [
    { key: 'new-inquiries', count: 1 },
    { key: 'open-work-orders', count: 1 },
    { key: 'overdue-invoices', count: 1 },
    { key: 'low-stock', count: 1 },
  ]);
  assert.deepEqual(administratorBody.data.businessDay, {
    timeZone: 'Asia/Taipei',
    date: '2026-07-21',
    startAt: '2026-07-20T16:00:00.000Z',
    endAt: '2026-07-21T16:00:00.000Z',
  });
  assert.doesNotMatch(administrator.text, /Private Prospect|0912345678|Private address/);

  const expectedKeysByUser = new Map([
    [2, ['new-inquiries']],
    [3, ['new-inquiries', 'open-work-orders']],
    [4, ['new-inquiries', 'overdue-invoices']],
  ]);
  for (const [staffUserId, expectedKeys] of expectedKeysByUser) {
    const result = await getDashboard(application, staffUserId);
    assert.equal(result.response.status, 200);
    const body = JSON.parse(result.text);
    assert.deepEqual(body.data.cards.map(({ key }) => key), expectedKeys);
    assert.doesNotMatch(result.text, /low-stock|SKU-DASH/);
  }
});

test('dashboard is authenticated, bounded, and returns recoverable empty queues', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    dashboardClock: () => FIXED_NOW,
  });
  const anonymous = await fetch(`${application.origin}/api/v1/admin/dashboard`);
  assert.equal(anonymous.status, 401);

  const administrator = await getDashboard(application, 1);
  assert.equal(administrator.response.status, 200);
  const body = JSON.parse(administrator.text);
  assert.equal(body.data.asOf, '2026-07-21T03:00:00.000Z');
  assert.equal(body.data.cards.length, 4);
  for (const card of body.data.cards) {
    assert.equal(card.count, 0);
    assert.deepEqual(card.items, []);
    assert.ok(card.items.length <= 5);
  }
  assert.equal(typeof body.meta.requestId, 'string');
});
