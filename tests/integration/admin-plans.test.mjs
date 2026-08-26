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

async function requestJson(application, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['sec-fetch-site'] = 'same-origin';
    headers['x-csrf-token'] = session.csrfToken;
  }
  const response = await fetch(`${application.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function planPayload(overrides = {}) {
  return {
    planCode: 'FTTH-DRAFT-800M',
    planName: '社區光纖 800M',
    serviceCategory: 'BROADBAND',
    technology: 'FTTH',
    downloadMbps: 800,
    uploadMbps: 800,
    bandwidthLabel: '800M / 800M',
    contractMonths: 24,
    wifiIncluded: true,
    description: '適合多人家庭與遠距工作的高速方案。',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2027-12-31',
    ...overrides,
  };
}

test('admin plan list and preview use safe DTOs and the exact public projection', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const list = await requestJson(application, admin, '/api/v1/admin/catalog/plans?q=VDSL2');
  assert.equal(list.response.status, 200);
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.data[0].planCode, 'VDSL2-100M');
  assert.doesNotMatch(JSON.stringify(list.body), /created_at|updated_at|price_period_key/i);

  const publicPlanResponse = await fetch(`${application.origin}/api/v1/catalog/plans/1`);
  const publicPlan = (await publicPlanResponse.json()).plan;
  const preview = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/preview');
  assert.equal(preview.response.status, 200);
  assert.deepEqual(preview.body.data.plan, publicPlan);
});

test('catalog manager creates, edits, publishes, and unpublishes a draft without DTO drift', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    planClock: () => Date.parse('2026-07-21T12:00:00.000Z'),
  });
  const admin = await login(application, 1);
  const created = await requestJson(application, admin, '/api/v1/admin/catalog/plans', {
    method: 'POST', body: planPayload(),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.isPublished, false);
  assert.equal(created.body.data.updatedAt, '2026-07-21T12:00:00.000Z');
  const planId = created.body.data.id;

  const draftCatalog = await fetch(`${application.origin}/api/v1/catalog`).then((response) => response.json());
  assert.equal(draftCatalog.plans.some(({ id }) => id === planId), false);
  const previewBefore = await requestJson(
    application, admin, `/api/v1/admin/catalog/plans/${planId}/preview`,
  );
  assert.equal(previewBefore.response.status, 200);
  assert.equal(previewBefore.body.data.plan.code, 'FTTH-DRAFT-800M');

  const updated = await requestJson(application, admin, `/api/v1/admin/catalog/plans/${planId}`, {
    method: 'PATCH',
    body: {
      ...planPayload({ planName: '社區光纖 800M 對稱型' }),
      expectedUpdatedAt: created.body.data.updatedAt,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.planName, '社區光纖 800M 對稱型');

  const published = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog/plans/${planId}/publish`,
    { method: 'POST', body: { expectedUpdatedAt: updated.body.data.updatedAt } },
  );
  assert.equal(published.response.status, 200);
  assert.equal(published.body.data.isPublished, true);
  const livePlan = await fetch(`${application.origin}/api/v1/catalog/plans/${planId}`);
  assert.equal(livePlan.status, 200);
  const liveProjection = (await livePlan.json()).plan;
  const previewAfter = await requestJson(
    application, admin, `/api/v1/admin/catalog/plans/${planId}/preview`,
  );
  assert.deepEqual(previewAfter.body.data.plan, liveProjection);

  const unpublished = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog/plans/${planId}/unpublish`,
    { method: 'POST', body: { expectedUpdatedAt: published.body.data.updatedAt } },
  );
  assert.equal(unpublished.response.status, 200);
  assert.equal(unpublished.body.data.isPublished, false);
  assert.equal((await fetch(`${application.origin}/api/v1/catalog/plans/${planId}`)).status, 404);

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const actions = database.prepare(`
    SELECT action FROM audit_logs WHERE entity_type = 'SERVICE_PLAN' AND entity_id = ? ORDER BY id
  `).all(String(planId)).map(({ action }) => action);
  database.close();
  assert.deepEqual(actions, ['PLAN_CREATED', 'PLAN_UPDATED', 'PLAN_PUBLISHED', 'PLAN_UNPUBLISHED']);
});

test('plan validation, authorization, CSRF, uniqueness, and stale updates fail closed', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);

  const denied = await requestJson(application, customerService, '/api/v1/admin/catalog/plans');
  assert.equal(denied.response.status, 403);
  const deniedWrite = await requestJson(application, customerService, '/api/v1/admin/catalog/plans', {
    method: 'POST', body: planPayload(),
  });
  assert.equal(deniedWrite.response.status, 403);

  const invalidCases = [
    planPayload({ effectiveFrom: '2027-01-01', effectiveTo: '2026-01-01' }),
    planPayload({ technology: 'UNSAFE' }),
    planPayload({ contractMonths: 0 }),
    { ...planPayload(), isActive: true },
  ];
  for (const invalid of invalidCases) {
    const result = await requestJson(application, admin, '/api/v1/admin/catalog/plans', {
      method: 'POST', body: invalid,
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.error.code, 'INVALID_BODY');
  }

  const duplicate = await requestJson(application, admin, '/api/v1/admin/catalog/plans', {
    method: 'POST', body: planPayload({ planCode: 'VDSL2-100M' }),
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'PLAN_CODE_CONFLICT');

  const detail = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1');
  const stale = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1', {
    method: 'PATCH',
    body: { ...planPayload({ planCode: 'VDSL2-100M' }), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'PLAN_CONFLICT');
  assert.ok(detail.body.data.updatedAt);

  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/catalog/plans`, {
    method: 'POST',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(planPayload({ planCode: 'NO-CSRF' })),
  });
  assert.equal(missingCsrf.status, 403);
});

test('delete removes only unreferenced drafts and publish state never mutates order snapshots', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const created = await requestJson(application, admin, '/api/v1/admin/catalog/plans', {
    method: 'POST', body: planPayload({ planCode: 'DELETE-ME' }),
  });
  const draftId = created.body.data.id;
  const deleted = await requestJson(application, admin, `/api/v1/admin/catalog/plans/${draftId}`, {
    method: 'DELETE', body: { expectedUpdatedAt: created.body.data.updatedAt },
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body.data, { deleted: true, id: draftId });

  const seeded = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1');
  const referenced = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1', {
    method: 'DELETE', body: { expectedUpdatedAt: seeded.body.data.updatedAt },
  });
  assert.equal(referenced.response.status, 409);
  assert.equal(referenced.body.error.code, 'PLAN_REFERENCED');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO customers (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (700, 'C-HISTORY-700', 'PERSON', '歷史客戶', 'ACTIVE', ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.prepare(`
    INSERT INTO sales_orders (
      id, order_no, customer_id, order_type, status, ordered_at,
      subtotal_amount, tax_amount, total_amount, created_at, updated_at
    ) VALUES (701, 'O-HISTORY-701', 700, 'NEW_SERVICE', 'DRAFT', ?, 28800, 0, 28800, ?, ?)
  `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.prepare(`
    INSERT INTO order_service_items (
      id, sales_order_id, service_plan_id, plan_price_id, quantity,
      unit_price, contract_months, description_snapshot, created_at
    ) VALUES (702, 701, 1, 1, 1, 28800, 12, '歷史方案快照', ?)
  `).run('2026-01-01T00:00:00.000Z');
  database.close();

  const unpublished = await requestJson(application, admin, '/api/v1/admin/catalog/plans/1/unpublish', {
    method: 'POST', body: { expectedUpdatedAt: seeded.body.data.updatedAt },
  });
  assert.equal(unpublished.response.status, 200);
  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const snapshot = verify.prepare(`
    SELECT unit_price, contract_months, description_snapshot
    FROM order_service_items WHERE id = 702
  `).get();
  verify.close();
  assert.deepEqual(
    { ...snapshot, unit_price: Number(snapshot.unit_price), contract_months: Number(snapshot.contract_months) },
    { unit_price: 28800, contract_months: 12, description_snapshot: '歷史方案快照' },
  );
});
