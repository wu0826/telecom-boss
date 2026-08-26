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

function categoryPayload(overrides = {}) {
  return {
    parentId: null,
    categoryCode: 'TEST_NETWORK',
    slug: 'test-network',
    categoryName: '測試網路設備',
    description: '提供測試用的網通設備分類。',
    sortOrder: 100,
    isActive: true,
    ...overrides,
  };
}

function productPayload(categoryId, overrides = {}) {
  return {
    productCode: 'GENERAL-AP-01',
    slug: 'general-ap-01',
    productName: '商用無線基地台展示頁',
    productType: 'GENERAL',
    sourceId: null,
    primaryCategoryId: categoryId,
    sortOrder: 20,
    isFeatured: false,
    ...overrides,
  };
}

test('catalog manager manages a category tree and product publication with fixed DTOs', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    productClock: () => Date.parse('2026-08-17T10:30:00.000Z'),
  });
  const admin = await login(application, 1);

  const initialCategories = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories');
  assert.equal(initialCategories.response.status, 200);
  assert.ok(initialCategories.body.data.length >= 2);
  assert.doesNotMatch(JSON.stringify(initialCategories.body), /created_by_staff_user_id|updated_by_staff_user_id/i);

  const category = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST', body: categoryPayload(),
  });
  assert.equal(category.response.status, 201);
  assert.equal(category.body.data.categoryCode, 'TEST_NETWORK');
  assert.equal(category.body.data.rowVersion, 1);

  const product = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST', body: productPayload(category.body.data.id),
  });
  assert.equal(product.response.status, 201);
  assert.equal(product.body.data.status, 'DRAFT');
  assert.deepEqual(product.body.data.primaryCategory, {
    id: category.body.data.id,
    categoryCode: 'TEST_NETWORK',
    slug: 'test-network',
    categoryName: '測試網路設備',
    isActive: true,
  });

  const listed = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products?q=${encodeURIComponent('無線')}&page=1&pageSize=10`,
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.meta.total, 1);
  assert.equal(listed.body.data[0].productCode, 'GENERAL-AP-01');
  assert.doesNotMatch(JSON.stringify(listed.body), /service_plan_id|stock_item_id|created_by_staff_user_id/i);

  const updated = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.body.data.id}`, {
    method: 'PATCH',
    body: {
      expectedVersion: product.body.data.rowVersion,
      productName: '商用無線基地台展示方案',
      isFeatured: true,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.productName, '商用無線基地台展示方案');
  assert.equal(updated.body.data.isFeatured, true);

  const published = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.body.data.id}/publish`,
    { method: 'POST', body: { expectedVersion: updated.body.data.rowVersion } },
  );
  assert.equal(published.response.status, 200);
  assert.equal(published.body.data.status, 'PUBLISHED');

  const archived = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.body.data.id}/archive`,
    { method: 'POST', body: { expectedVersion: published.body.data.rowVersion } },
  );
  assert.equal(archived.response.status, 200);
  assert.equal(archived.body.data.status, 'ARCHIVED');

  const database = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const actions = database.prepare(`
    SELECT action
    FROM audit_logs
    WHERE entity_id IN (?, ?)
    ORDER BY id
  `).all(String(category.body.data.id), String(product.body.data.id)).map(({ action }) => action);
  database.close();
  assert.deepEqual(actions, [
    'CATEGORY_CREATED',
    'PRODUCT_CREATED',
    'PRODUCT_UPDATED',
    'PRODUCT_PUBLISHED',
    'PRODUCT_ARCHIVED',
  ]);
});

test('catalog administration rejects unauthorized, stale, cyclic, invalid-source, and duplicate writes', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);

  const denied = await requestJson(application, customerService, '/api/v1/admin/catalog-v2/products');
  assert.equal(denied.response.status, 403);
  const deniedById = await requestJson(application, customerService, '/api/v1/admin/catalog-v2/products/1');
  assert.equal(deniedById.response.status, 403);

  const category = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST', body: categoryPayload(),
  });
  assert.equal(category.response.status, 201);

  const duplicate = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST', body: categoryPayload({ slug: 'another-slug' }),
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'CATEGORY_CODE_CONFLICT');
  const duplicateSlug = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST',
    body: categoryPayload({ categoryCode: 'TEST_NETWORK_OTHER' }),
  });
  assert.equal(duplicateSlug.response.status, 409);
  assert.equal(duplicateSlug.body.error.code, 'CATEGORY_SLUG_CONFLICT');

  const child = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST',
    body: categoryPayload({
      parentId: category.body.data.id,
      categoryCode: 'TEST_NETWORK_CHILD',
      slug: 'test-network-child',
      categoryName: '測試子分類',
    }),
  });
  assert.equal(child.response.status, 201);

  const cycle = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/categories/${category.body.data.id}/move`,
    { method: 'POST', body: { expectedVersion: category.body.data.rowVersion, parentId: child.body.data.id } },
  );
  assert.equal(cycle.response.status, 422);
  assert.equal(cycle.body.error.code, 'CATEGORY_CYCLE');

  let depthParentId = null;
  for (const level of [1, 2, 3, 4]) {
    const created = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
      method: 'POST',
      body: categoryPayload({
        parentId: depthParentId,
        categoryCode: `DEPTH_${level}`,
        slug: `depth-${level}`,
        categoryName: `第 ${level} 層分類`,
      }),
    });
    assert.equal(created.response.status, 201);
    depthParentId = created.body.data.id;
  }
  const tooDeep = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST',
    body: categoryPayload({
      parentId: depthParentId,
      categoryCode: 'DEPTH_5',
      slug: 'depth-5',
      categoryName: '第五層分類',
    }),
  });
  assert.equal(tooDeep.response.status, 422);
  assert.equal(tooDeep.body.error.code, 'CATEGORY_MAX_DEPTH');

  const databaseBefore = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const productCountBefore = Number(databaseBefore.prepare(
    'SELECT COUNT(*) AS count FROM catalog_products',
  ).get().count);
  databaseBefore.close();
  const invalidSource = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST',
    body: productPayload(category.body.data.id, {
      productCode: 'MISSING-SOURCE',
      slug: 'missing-source',
      productType: 'SERVICE_PLAN',
      sourceId: 999_999,
    }),
  });
  assert.equal(invalidSource.response.status, 422);
  assert.equal(invalidSource.body.error.code, 'INVALID_SOURCE');

  const databaseAfter = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const productCountAfter = Number(databaseAfter.prepare(
    'SELECT COUNT(*) AS count FROM catalog_products',
  ).get().count);
  databaseAfter.close();
  assert.equal(productCountAfter, productCountBefore);

  const product = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST', body: productPayload(child.body.data.id),
  });
  assert.equal(product.response.status, 201);
  const current = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.body.data.id}`, {
    method: 'PATCH',
    body: { expectedVersion: product.body.data.rowVersion, productName: '已更新的商品名稱' },
  });
  assert.equal(current.response.status, 200);
  const stale = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.body.data.id}`, {
    method: 'PATCH',
    body: { expectedVersion: product.body.data.rowVersion, productName: '不應寫入' },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'PRODUCT_CONFLICT');

  const disabled = await requestJson(application, admin, `/api/v1/admin/catalog-v2/categories/${category.body.data.id}`, {
    method: 'PATCH',
    body: { expectedVersion: category.body.data.rowVersion, isActive: false },
  });
  assert.equal(disabled.response.status, 200);
  const blockedPublication = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.body.data.id}/publish`,
    { method: 'POST', body: { expectedVersion: current.body.data.rowVersion } },
  );
  assert.equal(blockedPublication.response.status, 422);
  assert.equal(blockedPublication.body.error.code, 'CATEGORY_NOT_PUBLISHABLE');

  const missingCsrf = await fetch(`${application.origin}/api/v1/admin/catalog-v2/categories`, {
    method: 'POST',
    headers: {
      cookie: admin.cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(categoryPayload({ categoryCode: 'NO_CSRF', slug: 'no-csrf' })),
  });
  assert.equal(missingCsrf.status, 403);
});

test('catalog manager edits category details and safely deletes draft or archived products', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);

  const category = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST', body: categoryPayload(),
  });
  const updatedCategory = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/categories/${category.body.data.id}`,
    {
      method: 'PATCH',
      body: {
        expectedVersion: category.body.data.rowVersion,
        categoryName: '企業網通設備',
        description: '企業網路設備與連線配件。',
        sortOrder: 30,
        isActive: true,
      },
    },
  );
  assert.equal(updatedCategory.response.status, 200);
  assert.equal(updatedCategory.body.data.categoryName, '企業網通設備');
  assert.equal(updatedCategory.body.data.description, '企業網路設備與連線配件。');
  assert.equal(updatedCategory.body.data.rowVersion, category.body.data.rowVersion + 1);

  const staleCategory = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/categories/${category.body.data.id}`,
    {
      method: 'PATCH',
      body: { expectedVersion: category.body.data.rowVersion, categoryName: '不應寫入' },
    },
  );
  assert.equal(staleCategory.response.status, 409);
  assert.equal(staleCategory.body.error.code, 'CATEGORY_CONFLICT');

  const draft = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST', body: productPayload(category.body.data.id),
  });
  assert.equal((await requestJson(
    application,
    customerService,
    `/api/v1/admin/catalog-v2/products/${draft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: draft.body.data.rowVersion } },
  )).response.status, 403);

  const staleDelete = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${draft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: draft.body.data.rowVersion + 1 } },
  );
  assert.equal(staleDelete.response.status, 409);
  assert.equal(staleDelete.body.error.code, 'PRODUCT_CONFLICT');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO catalog_product_content (product_id, locale, title, summary)
    VALUES (?, 'zh-TW', '待刪除商品', '確認關聯內容會一併刪除。')
  `).run(draft.body.data.id);
  database.close();

  const deletedDraft = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${draft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: draft.body.data.rowVersion } },
  );
  assert.equal(deletedDraft.response.status, 200);
  assert.deepEqual(deletedDraft.body.data, { deleted: true, id: draft.body.data.id });

  const publishedDraft = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST',
    body: productPayload(category.body.data.id, {
      productCode: 'GENERAL-AP-02', slug: 'general-ap-02', productName: '待封存商品',
    }),
  });
  const published = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${publishedDraft.body.data.id}/publish`,
    { method: 'POST', body: { expectedVersion: publishedDraft.body.data.rowVersion } },
  );
  const blockedDelete = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${publishedDraft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: published.body.data.rowVersion } },
  );
  assert.equal(blockedDelete.response.status, 422);
  assert.equal(blockedDelete.body.error.code, 'PRODUCT_DELETE_NOT_ALLOWED');

  const archived = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${publishedDraft.body.data.id}/archive`,
    { method: 'POST', body: { expectedVersion: published.body.data.rowVersion } },
  );
  const deletedArchived = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${publishedDraft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: archived.body.data.rowVersion } },
  );
  assert.equal(deletedArchived.response.status, 200);

  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE id = ?').get(draft.body.data.id).count, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM catalog_product_content WHERE product_id = ?').get(draft.body.data.id).count, 0);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CATEGORY_UPDATED'").get().count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'PRODUCT_DELETED'").get().count, 2);
  verify.close();
});

test('product deletion rolls back when its audit record fails', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const category = await requestJson(application, admin, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST', body: categoryPayload(),
  });
  const draft = await requestJson(application, admin, '/api/v1/admin/catalog-v2/products', {
    method: 'POST', body: productPayload(category.body.data.id),
  });

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER reject_product_delete_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'PRODUCT_DELETED'
    BEGIN
      SELECT RAISE(ABORT, 'forced product delete audit failure');
    END;
  `);
  database.close();

  const failed = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${draft.body.data.id}`,
    { method: 'DELETE', body: { expectedVersion: draft.body.data.rowVersion } },
  );
  assert.equal(failed.response.status, 500);

  const verify = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE id = ?').get(draft.body.data.id).count, 1);
  verify.close();
});
