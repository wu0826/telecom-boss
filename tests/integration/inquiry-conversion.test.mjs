import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const INQUIRY = {
  planId: 2,
  name: '轉換測試客戶',
  phone: '0912-888-777',
  email: 'conversion@example.test',
  address: '台北市信義區轉換路 88 號',
  consent: true,
  company: '',
};

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

async function qualifiedInquiry(application) {
  const response = await fetch(`${application.origin}/api/v1/inquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(INQUIRY),
  });
  const submitted = await response.json();
  assert.equal(response.status, 201);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    UPDATE service_inquiries
    SET status = 'QUALIFIED', assigned_staff_user_id = 2,
      updated_at = '2026-07-21T10:00:00.000Z'
    WHERE inquiry_no = ?
  `).run(submitted.inquiryNo);
  const row = database.prepare(`
    SELECT id, updated_at FROM service_inquiries WHERE inquiry_no = ?
  `).get(submitted.inquiryNo);
  database.close();
  return { id: Number(row.id), updatedAt: new Date(row.updated_at).toISOString() };
}

function payload(inquiry, overrides = {}) {
  return {
    expectedUpdatedAt: inquiry.updatedAt,
    customer: {
      mode: 'NEW',
      customerType: 'PERSON',
      displayName: INQUIRY.name,
      legalName: null,
    },
    location: {
      create: true,
      serviceAreaId: null,
      postalCode: '110',
      city: '台北市',
      district: '信義區',
      addressLine: '轉換路 88 號',
      floorUnit: null,
      accessNotes: null,
      status: 'PENDING_SURVEY',
    },
    ...overrides,
  };
}

async function convert(application, session, inquiryId, body) {
  const response = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiryId}/conversion`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('qualified inquiry converts customer, contact, location, draft order, and audit atomically', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    inquiryConversionClock: () => Date.parse('2026-07-21T11:00:00.000Z'),
  });
  const inquiry = await qualifiedInquiry(application);
  const session = await login(application, 2);
  const result = await convert(application, session, inquiry.id, payload(inquiry));

  assert.equal(result.response.status, 201);
  assert.deepEqual(Object.keys(result.body.data).sort(), [
    'contactId', 'customerId', 'locationId', 'orderId', 'orderNo',
  ]);
  assert.equal(result.body.data.orderNo, `O-${String(inquiry.id).padStart(8, '0')}`);
  assert.doesNotMatch(JSON.stringify(result.body), /0912|conversion@example|identity|address|notes/i);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const converted = database.prepare(`
    SELECT customer_id, status, updated_at FROM service_inquiries WHERE id = ?
  `).get(inquiry.id);
  const order = database.prepare(`
    SELECT customer_id, service_location_id, status, sales_staff_user_id,
      subtotal_amount, tax_amount, total_amount
    FROM sales_orders WHERE id = ?
  `).get(result.body.data.orderId);
  const contact = database.prepare(`
    SELECT customer_id, phone, email, is_primary FROM customer_contacts WHERE id = ?
  `).get(result.body.data.contactId);
  const audit = database.prepare(`
    SELECT action, entity_type, entity_id, before_json, after_json
    FROM audit_logs WHERE action = 'INQUIRY_CONVERTED'
    ORDER BY id DESC LIMIT 1
  `).get();
  database.close();
  assert.equal(Number(converted.customer_id), result.body.data.customerId);
  assert.equal(converted.status, 'CONVERTED');
  assert.equal(new Date(converted.updated_at).toISOString(), '2026-07-21T11:00:00.000Z');
  assert.equal(order.status, 'DRAFT');
  assert.equal(Number(order.customer_id), result.body.data.customerId);
  assert.equal(Number(order.service_location_id), result.body.data.locationId);
  assert.equal(Number(order.sales_staff_user_id), 2);
  assert.deepEqual([Number(order.subtotal_amount), Number(order.tax_amount), Number(order.total_amount)], [0, 0, 0]);
  assert.equal(Number(contact.customer_id), result.body.data.customerId);
  assert.equal(contact.phone, INQUIRY.phone);
  assert.equal(contact.email, INQUIRY.email);
  assert.equal(Boolean(contact.is_primary), true);
  assert.equal(audit.entity_type, 'SERVICE_INQUIRY');
  assert.equal(audit.entity_id, String(inquiry.id));
  assert.deepEqual(JSON.parse(audit.before_json), { status: 'QUALIFIED' });
  assert.deepEqual(JSON.parse(audit.after_json), { status: 'CONVERTED' });
});

test('conversion can link an existing customer without creating a duplicate customer', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const inquiry = await qualifiedInquiry(application);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO customers (
      id, customer_no, customer_type, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    901, 'C-EXISTING-901', 'BUSINESS', '既有客戶', 'ACTIVE',
    '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
  database.close();
  const session = await login(application, 2);
  const result = await convert(application, session, inquiry.id, payload(inquiry, {
    customer: { mode: 'EXISTING', customerId: 901 },
    location: { create: false },
  }));
  assert.equal(result.response.status, 201);
  assert.equal(result.body.data.customerId, 901);
  assert.equal(result.body.data.locationId, null);
  const verification = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 1);
  assert.equal(verification.prepare(
    'SELECT COUNT(*) AS count FROM customer_contacts WHERE customer_id = 901',
  ).get().count, 1);
  verification.close();
});

test('repeated and concurrent conversion requests create one result and deterministic conflicts', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const inquiry = await qualifiedInquiry(application);
  const session = await login(application, 2);
  const [left, right] = await Promise.all([
    convert(application, session, inquiry.id, payload(inquiry)),
    convert(application, session, inquiry.id, payload(inquiry)),
  ]);
  const statuses = [left.response.status, right.response.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const conflict = left.response.status === 409 ? left : right;
  assert.equal(conflict.body.error.code, 'INQUIRY_ALREADY_CONVERTED');

  const repeated = await convert(application, session, inquiry.id, payload(inquiry));
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'INQUIRY_ALREADY_CONVERTED');
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count, 1);
  database.close();
});

test('conversion validates permission, CSRF, body allowlist, status, and stale versions', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const inquiry = await qualifiedInquiry(application);
  const writer = await login(application, 2);
  const readonly = await login(application, 3);

  const denied = await convert(application, readonly, inquiry.id, payload(inquiry));
  assert.equal(denied.response.status, 403);
  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiry.id}/conversion`, {
    method: 'POST',
    headers: {
      cookie: writer.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(payload(inquiry)),
  });
  assert.equal(missingCsrf.status, 403);
  const unknown = await convert(application, writer, inquiry.id, {
    ...payload(inquiry), identityEncrypted: 'forbidden',
  });
  assert.equal(unknown.response.status, 422);
  assert.equal(unknown.body.error.code, 'INVALID_BODY');
  const stale = await convert(application, writer, inquiry.id, {
    ...payload(inquiry), expectedUpdatedAt: '2026-07-21T09:00:00.000Z',
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'INQUIRY_CONFLICT');

  const bypass = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiry.id}`, {
    method: 'PATCH',
    headers: {
      cookie: writer.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': writer.csrfToken,
    },
    body: JSON.stringify({ expectedUpdatedAt: inquiry.updatedAt, status: 'CONVERTED' }),
  });
  assert.equal(bypass.status, 422);
  assert.equal((await bypass.json()).error.code, 'INVALID_TRANSITION');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare("UPDATE service_inquiries SET status = 'CONTACTED' WHERE id = ?").run(inquiry.id);
  database.close();
  const wrongStatus = await convert(application, writer, inquiry.id, payload(inquiry));
  assert.equal(wrongStatus.response.status, 422);
  assert.equal(wrongStatus.body.error.code, 'INQUIRY_NOT_QUALIFIED');
});

test('failure at each conversion write step rolls back every new record and keeps inquiry retryable', async (t) => {
  for (const [table, timing] of [
    ['customer_contacts', 'BEFORE INSERT'],
    ['service_locations', 'BEFORE INSERT'],
    ['sales_orders', 'BEFORE INSERT'],
    ['service_inquiries', 'BEFORE UPDATE'],
    ['audit_logs', 'BEFORE INSERT'],
  ]) {
    await t.test(`${table} ${timing}`, async (subtest) => {
      const application = await startSeededApplication(subtest, { enableDevelopmentLogin: true });
      const inquiry = await qualifiedInquiry(application);
      const session = await login(application, 2);
      const database = new DatabaseSync(application.telecomDatabasePath);
      database.exec(`
        CREATE TRIGGER fail_conversion_step
        ${timing} ON ${table}
        BEGIN
          SELECT RAISE(ABORT, 'simulated conversion failure');
        END;
      `);
      const result = await convert(application, session, inquiry.id, payload(inquiry));
      assert.equal(result.response.status, 500);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM customer_contacts').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_locations').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count, 0);
      const inquiryRow = database.prepare(
        'SELECT customer_id, status FROM service_inquiries WHERE id = ?',
      ).get(inquiry.id);
      database.close();
      assert.equal(inquiryRow.customer_id, null);
      assert.equal(inquiryRow.status, 'QUALIFIED');
    });
  }
});
