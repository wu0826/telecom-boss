import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const VALID_INQUIRY = {
  planId: 2,
  name: '王小明',
  phone: '0912-345-678',
  email: 'customer@example.test',
  address: '台北市中正區測試路 100 號',
  consent: true,
  company: '',
};

async function postInquiry(application, body, {
  idempotencyKey = randomUUID(),
  extraHeaders = {},
} = {}) {
  return fetch(`${application.origin}/api/v1/inquiries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

test('plan detail returns one active public plan and rejects unavailable identifiers', async (t) => {
  const application = await startSeededApplication(t);
  const response = await fetch(`${application.origin}/api/v1/catalog/plans/2`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.plan.id, 2);
  assert.equal(body.plan.code, 'FTTH-300M');
  assert.equal(body.plan.lowestMonthlyAmount, '396.00');
  assert.equal(body.plan.promotions[0].gift.modelName, 'Archer A6');
  assert.doesNotMatch(JSON.stringify(body), /created_at|updated_at|unit_cost/);

  const missingResponse = await fetch(`${application.origin}/api/v1/catalog/plans/999`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'PLAN_NOT_FOUND');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare('UPDATE service_plans SET is_active = 0 WHERE id = ?').run(2);
  database.close();
  const inactiveResponse = await fetch(`${application.origin}/api/v1/catalog/plans/2`);
  assert.equal(inactiveResponse.status, 404);
  assert.equal((await inactiveResponse.json()).error.code, 'PLAN_NOT_FOUND');
});

test('valid inquiry is persisted with server-owned workflow fields', async (t) => {
  const application = await startSeededApplication(t);
  const response = await postInquiry(application, VALID_INQUIRY);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.match(body.inquiryNo, /^WEB-[A-F0-9]{24}$/);
  assert.deepEqual(body.status, 'NEW');
  assert.equal(body.duplicate, false);
  assert.equal(new Date(body.createdAt).toISOString(), body.createdAt);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const row = database.prepare(`
    SELECT inquiry_no, prospect_name, phone, email, requested_plan_id,
           address_text, channel, status, customer_id, assigned_staff_user_id, notes
    FROM service_inquiries
    WHERE inquiry_no = ?
  `).get(body.inquiryNo);
  database.close();
  assert.equal(row.prospect_name, VALID_INQUIRY.name);
  assert.equal(row.phone, VALID_INQUIRY.phone);
  assert.equal(row.email, VALID_INQUIRY.email);
  assert.equal(row.requested_plan_id, VALID_INQUIRY.planId);
  assert.equal(row.address_text, VALID_INQUIRY.address);
  assert.equal(row.channel, 'WEB');
  assert.equal(row.status, 'NEW');
  assert.equal(row.customer_id, null);
  assert.equal(row.assigned_staff_user_id, null);
  assert.match(row.notes, /^PUBLIC_WEB_V1:[a-f0-9]{64}$/);
  const unkeyedPayloadHash = createHash('sha256').update(JSON.stringify({
    planId: VALID_INQUIRY.planId,
    name: VALID_INQUIRY.name,
    phone: VALID_INQUIRY.phone,
    email: VALID_INQUIRY.email,
    address: VALID_INQUIRY.address,
  })).digest('hex');
  assert.notEqual(row.notes, `PUBLIC_WEB_V1:${unkeyedPayloadHash}`);
});

test('inquiry validation rejects invalid data, unknown fields, and inactive plans', async (t) => {
  const application = await startSeededApplication(t);
  const cases = [
    [{ ...VALID_INQUIRY, name: ' ' }, 'name'],
    [{ ...VALID_INQUIRY, phone: '', email: '' }, 'contact'],
    [{ ...VALID_INQUIRY, planId: 999 }, 'planId'],
    [{ ...VALID_INQUIRY, status: 'CONVERTED' }, 'status'],
    [{ ...VALID_INQUIRY, company: 'spam.example' }, 'company'],
  ];

  for (const [payload, field] of cases) {
    const response = await postInquiry(application, payload);
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.details.some((detail) => detail.field === field));
  }

  const missingKeyResponse = await fetch(`${application.origin}/api/v1/inquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(VALID_INQUIRY),
  });
  assert.equal(missingKeyResponse.status, 400);
  assert.equal((await missingKeyResponse.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('prepared insert safely stores SQL-looking input without changing the schema', async (t) => {
  const application = await startSeededApplication(t);
  const injectionName = "測試'); DROP TABLE service_inquiries; --";
  const response = await postInquiry(application, { ...VALID_INQUIRY, name: injectionName });
  const body = await response.json();

  assert.equal(response.status, 201);
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(
    database.prepare('SELECT prospect_name FROM service_inquiries WHERE inquiry_no = ?')
      .get(body.inquiryNo).prospect_name,
    injectionName,
  );
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'service_inquiries'").get());
  database.close();
});

test('idempotency replay returns the original result and conflicting reuse is rejected', async (t) => {
  const application = await startSeededApplication(t);
  const key = randomUUID();
  const firstResponse = await postInquiry(application, VALID_INQUIRY, { idempotencyKey: key });
  const first = await firstResponse.json();
  const replayResponse = await postInquiry(application, VALID_INQUIRY, { idempotencyKey: key });
  const replay = await replayResponse.json();
  const conflictResponse = await postInquiry(
    application,
    { ...VALID_INQUIRY, address: '台北市中正區另一個地址 2 號' },
    { idempotencyKey: key },
  );

  assert.equal(firstResponse.status, 201);
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.inquiryNo, first.inquiryNo);
  assert.equal(replay.duplicate, true);
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error.code, 'IDEMPOTENCY_CONFLICT');

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_inquiries').get().count, 1);
  database.close();
});

test('cross-site and rate-limited submissions fail closed', async (t) => {
  const application = await startSeededApplication(t, {
    inquiryRateLimit: { maxAttempts: 2, windowMs: 60_000 },
  });
  const crossSite = await postInquiry(application, VALID_INQUIRY, {
    extraHeaders: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'CROSS_SITE_REQUEST');
  const sameSite = await postInquiry(application, VALID_INQUIRY, {
    extraHeaders: { 'sec-fetch-site': 'same-site' },
  });
  assert.equal(sameSite.status, 403);
  assert.equal((await sameSite.json()).error.code, 'CROSS_SITE_REQUEST');

  assert.equal((await postInquiry(application, VALID_INQUIRY)).status, 201);
  assert.equal((await postInquiry(application, VALID_INQUIRY)).status, 201);
  const limited = await postInquiry(application, VALID_INQUIRY);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
});

test('failed database write rolls back and returns a privacy-safe error', async (t) => {
  const application = await startSeededApplication(t);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_public_inquiry
    BEFORE INSERT ON service_inquiries
    BEGIN
      SELECT RAISE(ABORT, 'simulated private database failure');
    END
  `);
  database.close();

  const response = await postInquiry(application, VALID_INQUIRY);
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.doesNotMatch(text, /simulated|database|sqlite|service_inquiries/i);

  const verification = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM service_inquiries').get().count, 0);
  verification.close();
});
