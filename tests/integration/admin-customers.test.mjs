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

function seedCustomer(database) {
  database.prepare(`
    INSERT INTO customers (
      id, customer_no, customer_type, display_name, legal_name,
      identity_hash, identity_encrypted, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    101, 'C-TEST-101', 'PERSON', '王小明', '王小明',
    'a'.repeat(64), 'encrypted-secret-value', 'ACTIVE',
    '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
  database.prepare(`
    INSERT INTO customer_contacts (
      id, customer_id, contact_name, contact_type, phone, email,
      is_primary, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    201, 101, '王小明', 'PRIMARY', '0912-345-678', 'private@example.test',
    1, 1, '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
  database.prepare(`
    INSERT INTO service_areas (
      id, area_code, area_name, area_type, postal_code, city, district,
      address, access_technology, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    301, 'AREA-301', '信義測試區', 'GENERAL', '110', '台北市', '信義區',
    null, 'FTTH', 1, '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
  database.prepare(`
    INSERT INTO service_locations (
      id, location_no, customer_id, service_area_id, postal_code, city,
      district, address_line, floor_unit, access_notes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    401, 'LOC-401', 101, 301, '110', '台北市', '信義區',
    '測試路 100 號', '8 樓', '櫃台需換證', 'SERVICEABLE',
    '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
}

async function writeJson(application, session, path, method, body) {
  const response = await fetch(`${application.origin}${path}`, {
    method,
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

test('customer list and detail stay masked and never expose stored identity material', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const database = new DatabaseSync(application.telecomDatabasePath);
  seedCustomer(database);
  database.close();
  const session = await login(application, 2);

  const listResponse = await fetch(`${application.origin}/api/v1/admin/customers?q=C-TEST-101`, {
    headers: { cookie: session.cookie },
  });
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(listResponse.status, 200);
  assert.equal(list.meta.total, 1);
  assert.equal(list.data[0].customerNo, 'C-TEST-101');
  assert.doesNotMatch(listText, /identity|encrypted-secret-value|a{64}/i);

  const detailResponse = await fetch(`${application.origin}/api/v1/admin/customers/101`, {
    headers: { cookie: session.cookie },
  });
  const detailText = await detailResponse.text();
  const detail = JSON.parse(detailText).data;
  assert.equal(detailResponse.status, 200);
  assert.notEqual(detail.contacts[0].phone, '0912-345-678');
  assert.notEqual(detail.contacts[0].email, 'private@example.test');
  assert.equal(detail.locations[0].accessNotes, undefined);
  assert.deepEqual(detail.locations[0].allowedTechnologies, ['FTTH']);
  assert.doesNotMatch(detailText, /identity|encrypted-secret-value|0912-345-678|private@example\.test|櫃台需換證/i);
});

test('sensitive customer contact access is admin-only, allowlisted, and audited', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const database = new DatabaseSync(application.telecomDatabasePath);
  seedCustomer(database);
  const customerService = await login(application, 2);
  const denied = await fetch(`${application.origin}/api/v1/admin/customers/101/sensitive`, {
    headers: { cookie: customerService.cookie },
  });
  assert.equal(denied.status, 403);

  const admin = await login(application, 1);
  const response = await fetch(`${application.origin}/api/v1/admin/customers/101/sensitive`, {
    headers: { cookie: admin.cookie },
  });
  const text = await response.text();
  const data = JSON.parse(text).data;
  assert.equal(response.status, 200);
  assert.equal(data.contacts[0].phone, '0912-345-678');
  assert.equal(data.contacts[0].email, 'private@example.test');
  assert.equal(data.locations[0].accessNotes, '櫃台需換證');
  assert.doesNotMatch(text, /identity|encrypted-secret-value|a{64}/i);

  const audit = database.prepare(`
    SELECT actor_staff_user_id, action, entity_type, entity_id, before_json, after_json
    FROM audit_logs WHERE action = 'CUSTOMER_SENSITIVE_VIEWED'
    ORDER BY id DESC LIMIT 1
  `).get();
  database.close();
  assert.equal(Number(audit.actor_staff_user_id), 1);
  assert.equal(audit.entity_type, 'CUSTOMER');
  assert.equal(audit.entity_id, '101');
  assert.doesNotMatch(`${audit.before_json ?? ''}${audit.after_json ?? ''}`, /0912|private@example|櫃台/i);
});

test('customer, contact, and location writes validate primary and serviceability rules', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    customerClock: () => Date.parse('2026-07-21T09:00:00.000Z'),
  });
  const session = await login(application, 2);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO service_areas (
      id, area_code, area_name, area_type, city, district, access_technology,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    302, 'AREA-302', '中山供裝區', 'GENERAL', '台北市', '中山區', 'MIXED',
    1, '2026-07-21T01:00:00.000Z', '2026-07-21T01:00:00.000Z',
  );
  database.close();

  const created = await writeJson(application, session, '/api/v1/admin/customers', 'POST', {
    customerNo: 'C-NEW-001',
    customerType: 'BUSINESS',
    displayName: '測試企業',
    legalName: '測試企業股份有限公司',
    status: 'LEAD',
  });
  assert.equal(created.response.status, 201);
  const customerId = created.body.data.id;
  assert.equal(created.body.data.updatedAt, '2026-07-21T09:00:00.000Z');

  const firstContact = await writeJson(
    application,
    session,
    `/api/v1/admin/customers/${customerId}/contacts`,
    'POST',
    {
      contactName: '陳經理',
      contactType: 'PRIMARY',
      phone: '02-2345-6789',
      email: 'manager@example.test',
      isPrimary: true,
      isActive: true,
    },
  );
  assert.equal(firstContact.response.status, 201);

  const duplicatePrimary = await writeJson(
    application,
    session,
    `/api/v1/admin/customers/${customerId}/contacts`,
    'POST',
    {
      contactName: '林副理',
      contactType: 'BILLING',
      phone: '02-2222-3333',
      isPrimary: true,
      isActive: true,
    },
  );
  assert.equal(duplicatePrimary.response.status, 409);
  assert.equal(duplicatePrimary.body.error.code, 'PRIMARY_CONTACT_CONFLICT');

  const invalidLocation = await writeJson(
    application,
    session,
    `/api/v1/admin/customers/${customerId}/locations`,
    'POST',
    {
      locationNo: 'LOC-NEW-BAD',
      serviceAreaId: 999999,
      postalCode: '104',
      city: '台北市',
      district: '中山區',
      addressLine: '南京東路 1 號',
      status: 'SERVICEABLE',
    },
  );
  assert.equal(invalidLocation.response.status, 422);
  assert.equal(invalidLocation.body.error.code, 'INVALID_SERVICE_AREA');

  const validLocation = await writeJson(
    application,
    session,
    `/api/v1/admin/customers/${customerId}/locations`,
    'POST',
    {
      locationNo: 'LOC-NEW-001',
      serviceAreaId: 302,
      postalCode: '104',
      city: '台北市',
      district: '中山區',
      addressLine: '南京東路 1 號',
      floorUnit: '5 樓',
      accessNotes: '請先聯絡管理室',
      status: 'SERVICEABLE',
    },
  );
  assert.equal(validLocation.response.status, 201);
  assert.deepEqual(validLocation.body.data.allowedTechnologies, ['VDSL2', 'FTTH']);

  const verification = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verification.prepare(
    'SELECT COUNT(*) AS count FROM customer_contacts WHERE customer_id = ?',
  ).get(customerId).count, 1);
  assert.equal(verification.prepare(
    'SELECT COUNT(*) AS count FROM service_locations WHERE customer_id = ?',
  ).get(customerId).count, 1);
  verification.close();
});

test('customer writes enforce CSRF, write permission, allowlists, and transaction rollback', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const writer = await login(application, 2);
  const readonly = await login(application, 3);

  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/customers`, {
    method: 'POST',
    headers: {
      cookie: writer.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({
      customerNo: 'C-CSRF', customerType: 'PERSON', displayName: 'CSRF', status: 'LEAD',
    }),
  });
  assert.equal(missingCsrf.status, 403);

  const denied = await writeJson(application, readonly, '/api/v1/admin/customers', 'POST', {
    customerNo: 'C-DENIED', customerType: 'PERSON', displayName: 'Denied', status: 'LEAD',
  });
  assert.equal(denied.response.status, 403);

  const unknown = await writeJson(application, writer, '/api/v1/admin/customers', 'POST', {
    customerNo: 'C-UNKNOWN', customerType: 'PERSON', displayName: 'Unknown', status: 'LEAD',
    identityEncrypted: 'must never be accepted',
  });
  assert.equal(unknown.response.status, 422);
  assert.equal(unknown.body.error.code, 'INVALID_BODY');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_customer_create
    BEFORE INSERT ON customers
    BEGIN
      SELECT RAISE(ABORT, 'simulated customer failure');
    END;
  `);
  const failed = await writeJson(application, writer, '/api/v1/admin/customers', 'POST', {
    customerNo: 'C-ROLLBACK', customerType: 'PERSON', displayName: 'Rollback', status: 'LEAD',
  });
  assert.equal(failed.response.status, 500);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM customers WHERE customer_no = 'C-ROLLBACK'",
  ).get().count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM audit_logs
    WHERE action = 'CUSTOMER_CREATED' AND entity_id IS NOT NULL
  `).get().count, 0);
  database.close();
});
