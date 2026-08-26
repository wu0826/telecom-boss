import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(app, id) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId: id }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedSubscriptions(path) {
  const database = new DatabaseSync(path);
  const at = '2026-07-01T00:00:00.000Z';
  for (const id of [1400, 1401, 1402]) {
    database.prepare(`INSERT INTO customers
      (id, customer_no, customer_type, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'PERSON', ?, 'ACTIVE', ?, ?)`)
      .run(id, `C-BILL-${id}`, `帳務測試客戶 ${id}`, at, at);
    database.prepare(`INSERT INTO service_locations
      (id, location_no, customer_id, city, district, address_line, status, created_at, updated_at)
      VALUES (?, ?, ?, '臺北市', '信義區', ?, 'SERVICEABLE', ?, ?)`)
      .run(id, `L-BILL-${id}`, id, `測試路 ${id} 號`, at, at);
    database.prepare(`INSERT INTO subscriptions
      (id, subscription_no, customer_id, service_location_id, service_plan_id, status,
        contract_start_date, contract_end_date, activated_at, monthly_fee, billing_day,
        auto_renew, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, '2026-01-01', '2027-01-01', ?, ?, 1, 0, ?, ?)`)
      .run(
        id, `SUB-BILL-${id}`, id, id, id === 1402 ? 'PENDING' : 'ACTIVE',
        id === 1402 ? null : at, id === 1401 ? 42300 : 28800, at, at,
      );
  }
  database.close();
}

function generationBody(subscriptionId, overrides = {}) {
  return {
    subscriptionId,
    billingPeriodStart: '2026-07-01',
    billingPeriodEnd: '2026-07-31',
    dueDate: '2026-08-15',
    ...overrides,
  };
}

test('billing staff generates an exact fixed-scale invoice and reads its immutable line', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    invoiceClock: () => Date.parse('2026-07-21T12:00:00.000Z'),
  });
  seedSubscriptions(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const created = await request(app, billing, '/api/v1/admin/invoices', {
    method: 'POST', body: generationBody(1400),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'DRAFT');
  assert.equal(created.body.data.subtotalAmount, '274.29');
  assert.equal(created.body.data.taxAmount, '13.71');
  assert.equal(created.body.data.totalAmount, '288.00');
  assert.equal(created.body.data.balanceDue, '288.00');
  assert.equal(created.body.data.items[0].description, 'VDSL2+ 100M 月租費');
  assert.equal(created.body.data.items[0].unitPrice, '288.00');
  assert.equal(created.body.data.items[0].quantity, '1.000');

  const detail = await request(app, billing, `/api/v1/admin/invoices/${created.body.data.id}`);
  assert.deepEqual(detail.body.data, created.body.data);
});

test('subscription period stays unique under concurrent generation and batch preserves partial success', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const attempts = await Promise.all([
    request(app, billing, '/api/v1/admin/invoices', { method: 'POST', body: generationBody(1400) }),
    request(app, billing, '/api/v1/admin/invoices', { method: 'POST', body: generationBody(1400) }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [201, 409]);

  const batch = await request(app, billing, '/api/v1/admin/invoices/batch', {
    method: 'POST', body: generationBody(undefined),
  });
  assert.equal(batch.response.status, 200);
  assert.deepEqual(batch.body.data.results.map(({ subscriptionId, outcome }) => [subscriptionId, outcome]), [
    [1400, 'FAILED'],
    [1401, 'CREATED'],
  ]);
  assert.equal(batch.body.data.summary.created, 1);
  assert.equal(batch.body.data.summary.failed, 1);
  const database = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM invoices').get().count), 2);
  database.close();
});

test('invoice issue, overdue, and void transitions are optimistic and ordered', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    invoiceClock: () => Date.parse('2026-09-01T12:00:00.000Z'),
  });
  seedSubscriptions(app.telecomDatabasePath);
  const billing = await login(app, 4);
  let invoice = (await request(app, billing, '/api/v1/admin/invoices', {
    method: 'POST', body: generationBody(1400),
  })).body.data;
  const stale = await request(app, billing, `/api/v1/admin/invoices/${invoice.id}/issue`, {
    method: 'POST', body: { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(stale.response.status, 409);
  invoice = (await request(app, billing, `/api/v1/admin/invoices/${invoice.id}/issue`, {
    method: 'POST', body: { expectedUpdatedAt: invoice.updatedAt },
  })).body.data;
  assert.equal(invoice.status, 'ISSUED');
  invoice = (await request(app, billing, `/api/v1/admin/invoices/${invoice.id}/overdue`, {
    method: 'POST', body: { expectedUpdatedAt: invoice.updatedAt },
  })).body.data;
  assert.equal(invoice.status, 'OVERDUE');
  invoice = (await request(app, billing, `/api/v1/admin/invoices/${invoice.id}/void`, {
    method: 'POST', body: { expectedUpdatedAt: invoice.updatedAt, reason: '測試作廢' },
  })).body.data;
  assert.equal(invoice.status, 'VOID');
  assert.equal(invoice.balanceDue, '0.00');
  assert.equal((await request(app, billing, `/api/v1/admin/invoices/${invoice.id}/issue`, {
    method: 'POST', body: { expectedUpdatedAt: invoice.updatedAt },
  })).response.status, 409);
});

test('invoice permission, validation, and audit failures roll back all invoice rows', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedSubscriptions(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const technician = await login(app, 3);
  assert.equal((await request(app, technician, '/api/v1/admin/invoices')).response.status, 403);
  assert.equal((await request(app, billing, '/api/v1/admin/invoices', {
    method: 'POST', body: generationBody(1402),
  })).response.status, 409);
  assert.equal((await request(app, billing, '/api/v1/admin/invoices', {
    method: 'POST', body: generationBody(1400, { dueDate: '2026-06-30' }),
  })).response.status, 422);

  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_invoice_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'INVOICE_GENERATED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();
  const failed = await request(app, billing, '/api/v1/admin/invoices', {
    method: 'POST', body: generationBody(1400),
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM invoices').get().count), 0);
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM invoice_items').get().count), 0);
  verify.close();
});
