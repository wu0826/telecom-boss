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
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0] };
}

function parseCsv(text) {
  const rows = [[]];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      rows.at(-1).push(cell);
      cell = '';
    } else if (!quoted && character === '\r' && text[index + 1] === '\n') {
      rows.at(-1).push(cell);
      rows.push([]);
      cell = '';
      index += 1;
    } else {
      cell += character;
    }
  }
  if (cell || rows.at(-1).length) rows.at(-1).push(cell);
  return rows;
}

function seedExportCustomer(database) {
  const timestamp = '2026-08-17T01:00:00.000Z';
  database.prepare(`
    INSERT INTO customers (
      id, customer_no, customer_type, display_name, legal_name,
      identity_hash, identity_encrypted, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    801, '=EXPORT-DEMO', 'PERSON', '=SUM(1,1)', 'Formula Customer',
    'b'.repeat(64), 'customer-export-secret', 'ACTIVE', timestamp, timestamp,
  );
  database.prepare(`
    INSERT INTO customer_contacts (
      id, customer_id, contact_name, contact_type, phone, email,
      is_primary, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    802, 801, '+Formula Contact', 'PRIMARY', '0912-345-678', 'private@example.test',
    1, 1, timestamp, timestamp,
  );
  database.prepare(`
    INSERT INTO service_locations (
      id, location_no, customer_id, postal_code, city, district,
      address_line, floor_unit, access_notes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    803, 'LOC-EXPORT', 801, '110', '台北市', '信義區',
    '=危險路 100 號', '8 樓', '不應匯出', 'SERVICEABLE', timestamp, timestamp,
  );
}

function seedCappedCustomers(database) {
  const insert = database.prepare(`
    INSERT INTO customers (
      id, customer_no, customer_type, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const timestamp = '2026-08-17T01:00:00.000Z';
  for (let number = 1; number <= 501; number += 1) {
    insert.run(
      2_000 + number, `EXP-CAP-${String(number).padStart(3, '0')}`,
      'BUSINESS', `出口上限客戶 ${number}`, 'ACTIVE', timestamp, timestamp,
    );
  }
}

test('customer CSV export applies field permissions, masks PII, escapes formulas, and audits metadata', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const database = new DatabaseSync(application.telecomDatabasePath);
  seedExportCustomer(database);
  database.close();

  const customerService = await login(application, 2);
  const maskedResponse = await fetch(`${application.origin}/api/v1/admin/customers/export.csv?q=EXPORT-DEMO&status=ACTIVE`, {
    headers: { cookie: customerService.cookie },
  });
  const maskedText = await maskedResponse.text();
  const maskedRows = parseCsv(maskedText);
  assert.equal(maskedResponse.status, 200);
  assert.match(maskedResponse.headers.get('content-type'), /^text\/csv; charset=utf-8$/);
  assert.equal(maskedResponse.headers.get('cache-control'), 'no-store');
  assert.equal(maskedResponse.headers.get('content-disposition'), 'attachment; filename="customers-export.csv"');
  assert.deepEqual(maskedRows[0], ['customerNo', 'displayName', 'customerType', 'status']);
  assert.deepEqual(maskedRows[1], ["'=EXPORT-DEMO", "'=SUM(1,1)", 'PERSON', 'ACTIVE']);
  assert.doesNotMatch(maskedText, /0912-345-678|private@example\.test|危險路|8 樓|customer-export-secret|b{64}/i);

  const administrator = await login(application, 1);
  const sensitiveResponse = await fetch(`${application.origin}/api/v1/admin/customers/export.csv?q=EXPORT-DEMO&status=ACTIVE`, {
    headers: { cookie: administrator.cookie },
  });
  const sensitiveRows = parseCsv(await sensitiveResponse.text());
  assert.equal(sensitiveResponse.status, 200);
  assert.deepEqual(sensitiveRows[0], [
    'customerNo', 'displayName', 'customerType', 'status',
    'primaryContactName', 'maskedPhone', 'maskedEmail', 'maskedAddress',
  ]);
  assert.deepEqual(sensitiveRows[1], [
    "'=EXPORT-DEMO", "'=SUM(1,1)", 'PERSON', 'ACTIVE',
    "'+Formula Contact", '******5678', 'p***@example.test', '台北市信義區***',
  ]);

  const auditDatabase = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const audit = auditDatabase.prepare(`
    SELECT actor_staff_user_id, action, entity_type, entity_id, after_json
    FROM audit_logs WHERE action = 'CUSTOMER_EXPORT_CREATED'
    ORDER BY id DESC LIMIT 1
  `).get();
  auditDatabase.close();
  assert.equal(Number(audit.actor_staff_user_id), 1);
  assert.equal(audit.entity_type, 'CUSTOMER_EXPORT');
  assert.equal(audit.entity_id, 'CUSTOMERS');
  assert.deepEqual(JSON.parse(audit.after_json), {
    filterFields: ['q', 'status'],
    columnSet: [
      'customerNo', 'displayName', 'customerType', 'status',
      'primaryContactName', 'maskedPhone', 'maskedEmail', 'maskedAddress',
    ],
    rowCount: 1,
  });
  assert.doesNotMatch(audit.after_json, /EXPORT-DEMO|SUM\(1|0912|private@example|危險路|customer-export-secret/i);
});

test('customer CSV export rejects unsafe queries, denies unauthorized users, and caps rows at 500', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const administrator = await login(application, 1);
  const auditor = await login(application, 5);
  const database = new DatabaseSync(application.telecomDatabasePath);
  seedCappedCustomers(database);
  database.close();

  const anonymous = await fetch(`${application.origin}/api/v1/admin/customers/export.csv`);
  assert.equal(anonymous.status, 401);
  const denied = await fetch(`${application.origin}/api/v1/admin/customers/export.csv`, {
    headers: { cookie: auditor.cookie },
  });
  assert.equal(denied.status, 403);

  for (const query of ['identityHash=any', 'pageSize=501', `q=${'x'.repeat(101)}`]) {
    const response = await fetch(`${application.origin}/api/v1/admin/customers/export.csv?${query}`, {
      headers: { cookie: administrator.cookie },
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'INVALID_QUERY');
  }

  const response = await fetch(`${application.origin}/api/v1/admin/customers/export.csv?q=EXP-CAP`, {
    headers: { cookie: administrator.cookie },
  });
  assert.equal(response.status, 200);
  const rows = parseCsv(await response.text());
  assert.equal(rows.length, 501);

  const auditDatabase = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const audit = auditDatabase.prepare(`
    SELECT after_json FROM audit_logs WHERE action = 'CUSTOMER_EXPORT_CREATED'
    ORDER BY id DESC LIMIT 1
  `).get();
  auditDatabase.close();
  assert.equal(JSON.parse(audit.after_json).rowCount, 500);
});
