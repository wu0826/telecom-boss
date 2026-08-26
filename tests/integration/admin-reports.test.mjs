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

async function getReports(application, staffUserId, query = 'from=2026-07-20&to=2026-07-21') {
  const cookie = await login(application, staffUserId);
  const suffix = query ? `?${query}` : '';
  const response = await fetch(`${application.origin}/api/v1/admin/reports/operational${suffix}`, {
    headers: { cookie },
  });
  return { response, body: await response.json() };
}

function seedOperationalReportRows(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  try {
    database.exec(`
      INSERT INTO customers (
        id, customer_no, customer_type, display_name, status, created_at, updated_at
      ) VALUES (300, 'CUS-REPORT', 'PERSON', 'Report Customer', 'ACTIVE',
        '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z');

      INSERT INTO service_locations (
        id, location_no, customer_id, city, district, address_line, status,
        created_at, updated_at
      ) VALUES (300, 'LOC-REPORT', 300, '台北市', '中正區', 'Private report address',
        'SERVICEABLE', '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z');

      INSERT INTO service_inquiries (
        id, inquiry_no, prospect_name, phone, requested_plan_id, channel, status,
        created_at, updated_at
      ) VALUES
        (300, 'WEB-REPORT-FROM', 'Private Report Prospect', '0912345678', 1, 'WEB', 'NEW',
          '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'),
        (301, 'WEB-REPORT-TO', 'Outside Report Prospect', '0987654321', 1, 'PHONE', 'CONTACTED',
          '2026-07-21T16:00:00.000Z', '2026-07-21T16:00:00.000Z');

      INSERT INTO work_orders (
        id, work_order_no, service_location_id, work_type, priority, status,
        created_at, updated_at
      ) VALUES
        (300, 'WO-REPORT-OPEN', 300, 'INSTALL', 'HIGH', 'OPEN',
          '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'),
        (301, 'WO-REPORT-DONE', 300, 'REPAIR', 'NORMAL', 'COMPLETED',
          '2026-07-21T15:59:59.999Z', '2026-07-21T15:59:59.999Z'),
        (302, 'WO-REPORT-OUTSIDE', 300, 'REPAIR', 'NORMAL', 'OPEN',
          '2026-07-21T16:00:00.000Z', '2026-07-21T16:00:00.000Z');

      INSERT INTO invoices (
        id, billing_period_key, invoice_no, customer_id, billing_period_start,
        billing_period_end, issued_at, due_date, subtotal_amount, tax_amount,
        total_amount, balance_due, status, created_at, updated_at
      ) VALUES
        (300, '300:2026-06', 'INV-REPORT-DUE', 300, '2026-06-01', '2026-06-30',
          '2026-07-01T00:00:00.000Z', '2026-07-20', 10000, 500, 10500, 10500,
          'ISSUED', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (301, '300:2026-07', 'INV-REPORT-CURRENT', 300, '2026-07-01', '2026-07-31',
          '2026-07-20T00:00:00.000Z', '2026-07-21', 10000, 500, 10500, 10500,
          'ISSUED', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');

      INSERT INTO stock_items (
        id, sku, item_name, item_type, unit, reorder_level, is_active,
        created_at, updated_at
      ) VALUES (300, 'SKU-REPORT', 'Report Router', 'EQUIPMENT', 'PCS', 5000, 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouses (
        id, warehouse_code, warehouse_name, is_active, created_at, updated_at
      ) VALUES (300, 'WH-REPORT', 'Report Warehouse', 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO warehouse_stock (
        id, balance_key, warehouse_id, stock_item_id, quantity_on_hand,
        quantity_reserved, updated_at
      ) VALUES (300, '300:300', 300, 300, 4000, 1000, '2026-07-21T02:00:00.000Z');

      INSERT INTO promotions (
        id, promotion_code, promotion_name, discount_type, discount_value, gift_quantity,
        starts_at, ends_at, is_active, created_at, updated_at
      ) VALUES
        (300, 'PROMO-REPORT-FROM', 'Report Promotion', 'FIXED', 1000, 0,
          '2026-07-01T00:00:00.000Z', '2026-07-21T15:59:59.999Z', 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (302, 'PROMO-REPORT-NO-START', 'No Start Promotion', 'FIXED', 1000, 0,
          NULL, '2026-07-21T12:00:00.000Z', 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (301, 'PROMO-REPORT-OUTSIDE', 'Outside Promotion', 'FIXED', 1000, 0,
          '2026-07-01T00:00:00.000Z', '2026-07-21T16:00:00.000Z', 1,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);
  } finally {
    database.close();
  }
}

test('operational reports reconcile fixed source queries at Asia/Taipei date boundaries', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    reportClock: () => FIXED_NOW,
  });
  seedOperationalReportRows(application.telecomDatabasePath);

  const result = await getReports(application, 1);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.asOf, '2026-07-21T03:00:00.000Z');
  assert.deepEqual(result.body.data.filters, {
    timeZone: 'Asia/Taipei',
    from: '2026-07-20',
    to: '2026-07-21',
    fromAt: '2026-07-19T16:00:00.000Z',
    toAt: '2026-07-21T16:00:00.000Z',
    maxRangeDays: 31,
  });
  assert.deepEqual(result.body.data.reports.map(({ key, total, sourceTotals }) => ({ key, total, sourceTotals })), [
    { key: 'inquiries', total: 1, sourceTotals: { records: 1 } },
    { key: 'open-work', total: 1, sourceTotals: { records: 2 } },
    { key: 'overdue-invoices', total: 1, sourceTotals: { records: 2 } },
    { key: 'low-stock', total: 1, sourceTotals: { records: 1 } },
    { key: 'expiring-promotions', total: 2, sourceTotals: { records: 2 } },
  ]);
  for (const report of result.body.data.reports) {
    assert.equal(typeof report.unit, 'string');
    assert.equal(typeof report.denominator.label, 'string');
    assert.equal(typeof report.denominator.value, 'number');
    assert.equal(typeof report.definition, 'string');
    assert.ok(report.items.length <= 50);
  }
  assert.doesNotMatch(JSON.stringify(result.body), /Private Report Prospect|0912345678|Private report address/);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  try {
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM service_inquiries
      WHERE created_at >= ? AND created_at < ?
    `).get('2026-07-19T16:00:00.000Z', '2026-07-21T16:00:00.000Z').count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM work_orders
      WHERE created_at >= ? AND created_at < ?
        AND status IN ('OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS')
    `).get('2026-07-19T16:00:00.000Z', '2026-07-21T16:00:00.000Z').count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM invoices
      WHERE due_date >= ? AND due_date <= ? AND due_date < ?
        AND balance_due > 0 AND status IN ('ISSUED', 'PARTIAL', 'OVERDUE')
    `).get('2026-07-20', '2026-07-21', '2026-07-21').count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM warehouse_stock
      JOIN stock_items ON stock_items.id = warehouse_stock.stock_item_id
      JOIN warehouses ON warehouses.id = warehouse_stock.warehouse_id
      WHERE stock_items.is_active = 1 AND warehouses.is_active = 1
        AND warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved
          <= stock_items.reorder_level
    `).get().count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM promotions
      WHERE is_active = 1 AND ends_at IS NOT NULL
        AND ends_at >= ? AND ends_at < ?
        AND (starts_at IS NULL OR starts_at <= ?) AND ends_at >= ?
    `).get(
      '2026-07-19T16:00:00.000Z',
      '2026-07-21T16:00:00.000Z',
      '2026-07-21T03:00:00.000Z',
      '2026-07-21T03:00:00.000Z',
    ).count, 2);
  } finally {
    database.close();
  }
});

test('operational reports emit only permitted modules and reject unsafe date filters', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    reportClock: () => FIXED_NOW,
  });
  seedOperationalReportRows(application.telecomDatabasePath);

  const expectedKeys = new Map([
    [2, ['inquiries']],
    [3, ['inquiries', 'open-work']],
    [4, ['inquiries', 'overdue-invoices']],
    [5, []],
  ]);
  for (const [staffUserId, keys] of expectedKeys) {
    const result = await getReports(application, staffUserId);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data.reports.map(({ key }) => key), keys);
  }
  const defaultRange = await getReports(application, 1, '');
  assert.equal(defaultRange.response.status, 200);
  assert.deepEqual(defaultRange.body.data.filters, {
    timeZone: 'Asia/Taipei',
    from: '2026-07-21',
    to: '2026-07-21',
    fromAt: '2026-07-20T16:00:00.000Z',
    toAt: '2026-07-21T16:00:00.000Z',
    maxRangeDays: 31,
  });

  const cookie = await login(application, 1);
  const anonymous = await fetch(`${application.origin}/api/v1/admin/reports/operational`);
  assert.equal(anonymous.status, 401);
  for (const query of [
    'from=2026-07-21&to=2026-07-20',
    'from=2026-07-01&to=2026-08-01',
    'from=2026-02-30&to=2026-03-01',
    'from=2026-07-20',
    'from=2026-07-20&from=2026-07-20&to=2026-07-21',
    'from=2026-07-20&to=2026-07-21&table=invoices',
  ]) {
    const response = await fetch(`${application.origin}/api/v1/admin/reports/operational?${query}`, {
      headers: { cookie },
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'INVALID_QUERY');
  }
});
