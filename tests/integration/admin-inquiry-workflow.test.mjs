import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const PUBLIC_INQUIRY = {
  planId: 2,
  name: '流程測試客戶',
  phone: '0912-555-888',
  email: 'workflow@example.test',
  address: '台北市中正區流程測試路 9 號',
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

async function createInquiry(application) {
  const response = await fetch(`${application.origin}/api/v1/inquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(PUBLIC_INQUIRY),
  });
  const created = await response.json();
  assert.equal(response.status, 201);
  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const row = database.prepare(
    'SELECT id, updated_at FROM service_inquiries WHERE inquiry_no = ?',
  ).get(created.inquiryNo);
  database.close();
  return { id: Number(row.id), updatedAt: new Date(row.updated_at).toISOString() };
}

async function patchInquiry(application, session, inquiryId, body) {
  const response = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiryId}`, {
    method: 'PATCH',
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

test('customer writer atomically assigns and advances an inquiry with audit history', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    inquiryWorkflowClock: () => Date.parse('2099-07-21T08:00:00.000Z'),
  });
  const inquiry = await createInquiry(application);
  const session = await login(application, 2);
  const assigneesResponse = await fetch(`${application.origin}/api/v1/admin/inquiries/assignees`, {
    headers: { cookie: session.cookie },
  });
  const assigneesText = await assigneesResponse.text();
  assert.equal(assigneesResponse.status, 200);
  assert.deepEqual(JSON.parse(assigneesText).data.map(({ id }) => id).sort(), [1, 2]);
  assert.doesNotMatch(assigneesText, /email|provider|subject|example\.test/i);
  const result = await patchInquiry(application, session, inquiry.id, {
    expectedUpdatedAt: inquiry.updatedAt,
    assignedStaffUserId: 2,
    status: 'CONTACTED',
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.status, 'CONTACTED');
  assert.deepEqual(result.body.data.assignee, { id: 2, displayName: '開發客服人員' });
  assert.equal(result.body.data.updatedAt, '2099-07-21T08:00:00.000Z');

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const row = database.prepare(
    'SELECT status, assigned_staff_user_id, updated_at FROM service_inquiries WHERE id = ?',
  ).get(inquiry.id);
  const audit = database.prepare(`
    SELECT action, actor_staff_user_id, entity_id, before_json, after_json
    FROM audit_logs
    WHERE action = 'INQUIRY_WORKFLOW_UPDATED'
    ORDER BY id DESC LIMIT 1
  `).get();
  database.close();
  assert.equal(row.status, 'CONTACTED');
  assert.equal(Number(row.assigned_staff_user_id), 2);
  assert.equal(audit.entity_id, String(inquiry.id));
  assert.deepEqual(JSON.parse(audit.before_json), { assignedStaffUserId: null, status: 'NEW' });
  assert.deepEqual(JSON.parse(audit.after_json), { assignedStaffUserId: 2, status: 'CONTACTED' });
});

test('stale, duplicate, invalid jump, terminal edit, and ineligible assignee are rejected', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    inquiryWorkflowClock: () => Date.parse('2099-07-21T08:00:00.000Z'),
  });
  const session = await login(application, 2);

  const staleInquiry = await createInquiry(application);
  const first = await patchInquiry(application, session, staleInquiry.id, {
    expectedUpdatedAt: staleInquiry.updatedAt,
    status: 'CONTACTED',
  });
  assert.equal(first.response.status, 200);
  const stale = await patchInquiry(application, session, staleInquiry.id, {
    expectedUpdatedAt: staleInquiry.updatedAt,
    status: 'CONTACTED',
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'INQUIRY_CONFLICT');

  const jumpInquiry = await createInquiry(application);
  const jump = await patchInquiry(application, session, jumpInquiry.id, {
    expectedUpdatedAt: jumpInquiry.updatedAt,
    status: 'CONVERTED',
  });
  assert.equal(jump.response.status, 422);
  assert.equal(jump.body.error.code, 'INVALID_TRANSITION');

  const ineligibleInquiry = await createInquiry(application);
  const ineligible = await patchInquiry(application, session, ineligibleInquiry.id, {
    expectedUpdatedAt: ineligibleInquiry.updatedAt,
    assignedStaffUserId: 3,
  });
  assert.equal(ineligible.response.status, 422);
  assert.equal(ineligible.body.error.code, 'ASSIGNEE_NOT_ELIGIBLE');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare("UPDATE service_inquiries SET status = 'CLOSED' WHERE id = ?").run(ineligibleInquiry.id);
  const terminalUpdatedAt = new Date(database.prepare(
    'SELECT updated_at FROM service_inquiries WHERE id = ?',
  ).get(ineligibleInquiry.id).updated_at).toISOString();
  database.close();
  const terminal = await patchInquiry(application, session, ineligibleInquiry.id, {
    expectedUpdatedAt: terminalUpdatedAt,
    assignedStaffUserId: 2,
  });
  assert.equal(terminal.response.status, 422);
  assert.equal(terminal.body.error.code, 'TERMINAL_INQUIRY');
});

test('workflow update rejects unknown fields, missing CSRF, and read-only staff', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const inquiry = await createInquiry(application);
  const customerService = await login(application, 2);
  const unknown = await patchInquiry(application, customerService, inquiry.id, {
    expectedUpdatedAt: inquiry.updatedAt,
    status: 'CONTACTED',
    notes: 'must not be accepted',
  });
  assert.equal(unknown.response.status, 422);
  assert.equal(unknown.body.error.code, 'INVALID_BODY');

  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/inquiries/${inquiry.id}`, {
    method: 'PATCH',
    headers: {
      cookie: customerService.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ expectedUpdatedAt: inquiry.updatedAt, status: 'CONTACTED' }),
  });
  assert.equal(missingCsrf.status, 403);

  const technician = await login(application, 3);
  const denied = await patchInquiry(application, technician, inquiry.id, {
    expectedUpdatedAt: inquiry.updatedAt,
    status: 'CONTACTED',
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
});

test('workflow database failure rolls back both state and audit', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const inquiry = await createInquiry(application);
  const session = await login(application, 2);
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER fail_inquiry_workflow
    BEFORE UPDATE ON service_inquiries
    BEGIN
      SELECT RAISE(ABORT, 'simulated workflow failure');
    END;
  `);

  const result = await patchInquiry(application, session, inquiry.id, {
    expectedUpdatedAt: inquiry.updatedAt,
    status: 'CONTACTED',
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(database.prepare(
    'SELECT status FROM service_inquiries WHERE id = ?',
  ).get(inquiry.id).status, 'NEW');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM audit_logs
    WHERE action = 'INQUIRY_WORKFLOW_UPDATED' AND entity_id = ?
  `).get(String(inquiry.id)).count, 0);
  database.close();
});
