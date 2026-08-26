import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const PUBLIC_INQUIRY = {
  planId: 2,
  name: '王小明',
  phone: '0912-345-678',
  email: 'customer@example.test',
  address: '台北市中正區測試路 100 號',
  consent: true,
  company: '',
};

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function submitPublicInquiry(application, overrides = {}) {
  const response = await fetch(`${application.origin}/api/v1/inquiries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ ...PUBLIC_INQUIRY, ...overrides }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('inquiry list finds live public submissions with allowlisted filters and masked contacts', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const first = await submitPublicInquiry(application);
  const second = await submitPublicInquiry(application, {
    name: '林測試',
    phone: '0988-765-432',
    email: 'second@example.test',
    planId: 3,
  });
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    UPDATE service_inquiries
    SET status = 'CONTACTED', channel = 'PHONE', assigned_staff_user_id = 2,
        updated_at = '2026-07-21T05:00:00.000Z'
    WHERE inquiry_no = ?
  `).run(second.inquiryNo);
  database.close();

  const cookie = await login(application, 2);
  const response = await fetch(
    `${application.origin}/api/v1/admin/inquiries?q=${encodeURIComponent(second.inquiryNo)}&planId=3&channel=PHONE&status=CONTACTED&assigneeId=2&page=1&pageSize=5&sort=inquiryNo&direction=asc`,
    { headers: { cookie } },
  );
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(body.meta.page, 1);
  assert.equal(body.meta.pageSize, 5);
  assert.equal(body.meta.total, 1);
  assert.equal(body.data.length, 1);
  assert.deepEqual(body.data[0].requestedPlan.id, 3);
  assert.equal(body.data[0].inquiryNo, second.inquiryNo);
  assert.equal(body.data[0].status, 'CONTACTED');
  assert.deepEqual(body.data[0].assignee, { id: 2, displayName: '開發客服人員' });
  assert.notEqual(body.data[0].prospectName, '林測試');
  assert.notEqual(body.data[0].phone, '0988-765-432');
  assert.notEqual(body.data[0].email, 'second@example.test');
  assert.doesNotMatch(text, /林測試|0988-765-432|second@example\.test|PUBLIC_WEB_V1/);
  assert.notEqual(first.inquiryNo, second.inquiryNo);
});

test('inquiry detail exposes full working contact fields only to customer writers', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const submitted = await submitPublicInquiry(application);
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const inquiryId = Number(database.prepare(
    'SELECT id FROM service_inquiries WHERE inquiry_no = ?',
  ).get(submitted.inquiryNo).id);
  database.close();

  const customerServiceCookie = await login(application, 2);
  const writableResponse = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiryId}`, {
    headers: { cookie: customerServiceCookie },
  });
  const writableText = await writableResponse.text();
  const writable = JSON.parse(writableText).data;
  assert.equal(writableResponse.status, 200);
  assert.equal(writable.prospectName, PUBLIC_INQUIRY.name);
  assert.equal(writable.phone, PUBLIC_INQUIRY.phone);
  assert.equal(writable.email, PUBLIC_INQUIRY.email);
  assert.equal(writable.addressText, PUBLIC_INQUIRY.address);
  assert.doesNotMatch(writableText, /PUBLIC_WEB_V1|notes|identity|idempotency/i);

  const technicianCookie = await login(application, 3);
  const readonlyResponse = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiryId}`, {
    headers: { cookie: technicianCookie },
  });
  const readonlyText = await readonlyResponse.text();
  const readonly = JSON.parse(readonlyText).data;
  assert.equal(readonlyResponse.status, 200);
  assert.notEqual(readonly.prospectName, PUBLIC_INQUIRY.name);
  assert.notEqual(readonly.phone, PUBLIC_INQUIRY.phone);
  assert.notEqual(readonly.email, PUBLIC_INQUIRY.email);
  assert.equal('addressText' in readonly, false);
  assert.doesNotMatch(readonlyText, /王小明|0912-345-678|customer@example\.test|測試路/);

  const missing = await fetch(`${application.origin}/api/v1/admin/inquiries/999999`, {
    headers: { cookie: customerServiceCookie },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'INQUIRY_NOT_FOUND');
});

test('inquiry APIs reject anonymous access and invalid or unbounded list queries', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  assert.equal((await fetch(`${application.origin}/api/v1/admin/inquiries`)).status, 401);
  const cookie = await login(application, 2);

  for (const query of [
    'page=0',
    'pageSize=101',
    'sort=phone',
    'direction=sideways',
    'status=UNKNOWN',
    'channel=UNKNOWN',
    'from=2026-02-30',
    `q=${'x'.repeat(101)}`,
    'privateField=true',
  ]) {
    const response = await fetch(`${application.origin}/api/v1/admin/inquiries?${query}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 422, query);
    assert.equal((await response.json()).error.code, 'INVALID_QUERY');
  }
});

test('full inquiry contact reads append a privacy-safe audit event', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const submitted = await submitPublicInquiry(application);
  const database = new DatabaseSync(application.telecomDatabasePath);
  const inquiryId = Number(database.prepare(
    'SELECT id FROM service_inquiries WHERE inquiry_no = ?',
  ).get(submitted.inquiryNo).id);
  const cookie = await login(application, 2);

  const response = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiryId}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const row = database.prepare(`
    SELECT actor_staff_user_id, action, entity_type, entity_id, before_json, after_json
    FROM audit_logs
    WHERE action = 'INQUIRY_CONTACT_VIEWED'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  database.close();
  assert.equal(Number(row.actor_staff_user_id), 2);
  assert.equal(row.entity_type, 'SERVICE_INQUIRY');
  assert.equal(row.entity_id, String(inquiryId));
  assert.doesNotMatch(`${row.before_json ?? ''}${row.after_json ?? ''}`, /王小明|0912|customer@example|測試路/i);
});
