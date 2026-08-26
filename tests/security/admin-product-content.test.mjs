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

async function createProduct(application, session) {
  const category = await requestJson(application, session, '/api/v1/admin/catalog-v2/categories', {
    method: 'POST',
    body: {
      parentId: null,
      categoryCode: 'CONTENT_TEST',
      slug: 'content-test',
      categoryName: '內容測試分類',
      description: '用於驗證商品內容的測試分類。',
      sortOrder: 90,
      isActive: true,
    },
  });
  assert.equal(category.response.status, 201);

  const product = await requestJson(application, session, '/api/v1/admin/catalog-v2/products', {
    method: 'POST',
    body: {
      productCode: 'CONTENT-TEST-01',
      slug: 'content-test-01',
      productName: '商品內容測試方案',
      productType: 'GENERAL',
      sourceId: null,
      primaryCategoryId: category.body.data.id,
      sortOrder: 30,
      isFeatured: false,
    },
  });
  assert.equal(product.response.status, 201);
  return product.body.data;
}

test('catalog manager stores plain-text localized product content with permission and stale-write guards', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);
  const product = await createProduct(application, admin);
  const contentPath = `/api/v1/admin/catalog-v2/products/${product.id}/content`;

  const denied = await requestJson(application, customerService, contentPath, {
    method: 'POST',
    body: { locale: 'zh-TW', title: '不應寫入', bodyText: '沒有權限。' },
  });
  assert.equal(denied.response.status, 403);

  const unsafe = await requestJson(application, admin, contentPath, {
    method: 'POST',
    body: { locale: 'zh-TW', title: '不安全內容', bodyText: '<script>alert(1)</script>' },
  });
  assert.equal(unsafe.response.status, 422);
  assert.equal(unsafe.body.error.code, 'UNSAFE_CONTENT');

  const created = await requestJson(application, admin, contentPath, {
    method: 'POST',
    body: {
      locale: 'zh-TW',
      title: '企業光纖專線',
      summary: '穩定連線與可預約安裝時段。',
      bodyText: '提供固定頻寬、安裝流程與服務特色說明。',
      seoTitle: '企業光纖專線｜Yankees Telecom',
      seoDescription: '適合多據點與需要穩定連線的企業方案。',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.locale, 'zh-TW');
  assert.equal(created.body.data.rowVersion, 1);
  assert.doesNotMatch(JSON.stringify(created.body), /created_by|updated_by|body_html/i);

  const updated = await requestJson(application, admin, `${contentPath}/zh-TW`, {
    method: 'PATCH',
    body: {
      expectedVersion: created.body.data.rowVersion,
      summary: '提供固定頻寬與專人協助的企業連線方案。',
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.rowVersion, 2);

  const stale = await requestJson(application, admin, `${contentPath}/zh-TW`, {
    method: 'PATCH',
    body: { expectedVersion: created.body.data.rowVersion, title: '不應覆寫' },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'CONTENT_CONFLICT');
});

test('catalog manager safely manages ordered sections, media, specifications, and brands', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(application, 1);
  const customerService = await login(application, 2);
  const product = await createProduct(application, admin);
  const contentPath = `/api/v1/admin/catalog-v2/products/${product.id}/content`;

  const content = await requestJson(application, admin, contentPath, {
    method: 'POST',
    body: { locale: 'zh-TW', title: '企業光纖專線', bodyText: '提供固定頻寬。' },
  });
  assert.equal(content.response.status, 201);

  const unsafeSection = await requestJson(application, admin, `${contentPath}/zh-TW/sections`, {
    method: 'POST',
    body: {
      sectionKey: 'overview', sectionType: 'TEXT', title: '方案特色',
      bodyText: '<strong>不安全的標記</strong>', sortOrder: 10, isActive: true,
    },
  });
  assert.equal(unsafeSection.response.status, 422);
  assert.equal(unsafeSection.body.error.code, 'UNSAFE_CONTENT');

  const section = await requestJson(application, admin, `${contentPath}/zh-TW/sections`, {
    method: 'POST',
    body: {
      sectionKey: 'overview', sectionType: 'TEXT', title: '方案特色',
      bodyText: '提供固定頻寬與企業級維運支援。', sortOrder: 10, isActive: true,
    },
  });
  assert.equal(section.response.status, 201);
  const updatedSection = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.id}/sections/${section.body.data.id}`,
    {
      method: 'PATCH',
      body: { expectedVersion: section.body.data.rowVersion, sortOrder: 2 },
    },
  );
  assert.equal(updatedSection.response.status, 200);
  const staleSection = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.id}/sections/${section.body.data.id}`,
    {
      method: 'PATCH',
      body: { expectedVersion: section.body.data.rowVersion, sortOrder: 3 },
    },
  );
  assert.equal(staleSection.response.status, 409);
  assert.equal(staleSection.body.error.code, 'SECTION_CONFLICT');

  const unsafeMedia = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`, {
    method: 'POST',
    body: {
      mediaUsage: 'PRIMARY', url: 'javascript:alert(1)', altText: '不安全圖片',
      isPrimary: true, sortOrder: 10,
    },
  });
  assert.equal(unsafeMedia.response.status, 422);
  assert.equal(unsafeMedia.body.error.code, 'INVALID_MEDIA_URL');

  const missingAlt = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`, {
    method: 'POST',
    body: {
      mediaUsage: 'GALLERY', url: '/assets/missing-alt.jpg', altText: '',
      isPrimary: false, sortOrder: 11,
    },
  });
  assert.equal(missingAlt.response.status, 422);
  assert.equal(missingAlt.body.error.details[0].field, 'altText');

  const primaryMedia = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`, {
    method: 'POST',
    body: {
      mediaUsage: 'PRIMARY', url: '/assets/fiber-primary.jpg', altText: '企業光纖專線主視覺',
      isPrimary: true, sortOrder: 10,
    },
  });
  assert.equal(primaryMedia.response.status, 201);
  const replacementMedia = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`, {
    method: 'POST',
    body: {
      mediaUsage: 'PRIMARY', url: 'https://cdn.example.test/fiber-hero.jpg', altText: '企業光纖新主視覺',
      isPrimary: true, sortOrder: 1,
    },
  });
  assert.equal(replacementMedia.response.status, 201);
  const mediaList = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`);
  assert.equal(mediaList.response.status, 200);
  assert.equal(mediaList.body.data[0].id, replacementMedia.body.data.id);
  assert.equal(mediaList.body.data.filter((media) => media.isPrimary).length, 1);
  assert.equal(mediaList.body.data.find((media) => media.id === primaryMedia.body.data.id).mediaUsage, 'GALLERY');
  const reorderedMedia = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.id}/media/${replacementMedia.body.data.id}`,
    {
      method: 'PATCH',
      body: { expectedVersion: replacementMedia.body.data.rowVersion, sortOrder: 12 },
    },
  );
  assert.equal(reorderedMedia.response.status, 200);
  assert.equal(reorderedMedia.body.data.sortOrder, 12);
  const deletedMedia = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.id}/media/${replacementMedia.body.data.id}`,
    {
      method: 'DELETE',
      body: { expectedVersion: reorderedMedia.body.data.rowVersion },
    },
  );
  assert.equal(deletedMedia.response.status, 200);
  const mediaAfterDelete = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/media`);
  assert.equal(mediaAfterDelete.response.status, 200);
  assert.equal(mediaAfterDelete.body.data.some((media) => media.id === replacementMedia.body.data.id), false);

  const deniedMedia = await requestJson(application, customerService, `/api/v1/admin/catalog-v2/products/${product.id}/media`, {
    method: 'POST',
    body: {
      mediaUsage: 'GALLERY', url: '/assets/denied.jpg', altText: '不應寫入', isPrimary: false, sortOrder: 20,
    },
  });
  assert.equal(deniedMedia.response.status, 403);

  const spec = await requestJson(application, admin, `${contentPath}/zh-TW/specs`, {
    method: 'POST',
    body: {
      specKey: 'bandwidth', groupKey: 'network', groupLabel: '網路規格',
      specLabel: '頻寬', specValue: '1,000', unit: 'Mbps', sortOrder: 1,
    },
  });
  assert.equal(spec.response.status, 201);
  const secondSpec = await requestJson(application, admin, `${contentPath}/zh-TW/specs`, {
    method: 'POST',
    body: {
      specKey: 'uptime', groupKey: 'network', groupLabel: '網路規格',
      specLabel: '可用率', specValue: '99.9', unit: '%', sortOrder: 0,
    },
  });
  assert.equal(secondSpec.response.status, 201);
  const duplicateSpec = await requestJson(application, admin, `${contentPath}/zh-TW/specs`, {
    method: 'POST',
    body: {
      specKey: 'bandwidth', groupKey: 'network', groupLabel: '網路規格',
      specLabel: '頻寬', specValue: '500', unit: 'Mbps', sortOrder: 2,
    },
  });
  assert.equal(duplicateSpec.response.status, 409);
  assert.equal(duplicateSpec.body.error.code, 'SPEC_CONFLICT');

  const brand = await requestJson(application, admin, '/api/v1/admin/catalog-v2/brands', {
    method: 'POST',
    body: {
      brandCode: 'YANKEES_NET', slug: 'yankees-net', brandName: 'Yankees Network',
      description: '企業網路服務品牌。', websiteUrl: 'https://www.example.test/',
      logoUrl: '/assets/yankees-net.svg', sortOrder: 1, isActive: true,
    },
  });
  assert.equal(brand.response.status, 201);
  const duplicateBrand = await requestJson(application, admin, '/api/v1/admin/catalog-v2/brands', {
    method: 'POST',
    body: {
      brandCode: 'YANKEES_NET', slug: 'yankees-net-duplicate', brandName: '重複品牌',
      description: null, websiteUrl: null, logoUrl: null, sortOrder: 2, isActive: true,
    },
  });
  assert.equal(duplicateBrand.response.status, 409);
  assert.equal(duplicateBrand.body.error.code, 'BRAND_CODE_CONFLICT');

  const linked = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/brands`, {
    method: 'POST',
    body: { brandId: brand.body.data.id, isPrimary: true, sortOrder: 1, expectedProductVersion: product.rowVersion },
  });
  assert.equal(linked.response.status, 201);
  assert.equal(linked.body.data.productRowVersion, product.rowVersion + 1);
  const duplicateBrandLink = await requestJson(application, admin, `/api/v1/admin/catalog-v2/products/${product.id}/brands`, {
    method: 'POST',
    body: {
      brandId: brand.body.data.id,
      isPrimary: true,
      sortOrder: 1,
      expectedProductVersion: linked.body.data.productRowVersion,
    },
  });
  assert.equal(duplicateBrandLink.response.status, 409);
  assert.equal(duplicateBrandLink.body.error.code, 'PRODUCT_BRAND_CONFLICT');
  const staleBrandLink = await requestJson(
    application,
    admin,
    `/api/v1/admin/catalog-v2/products/${product.id}/brands/${brand.body.data.id}`,
    {
      method: 'PATCH',
      body: { isPrimary: false, sortOrder: 2, expectedProductVersion: product.rowVersion },
    },
  );
  assert.equal(staleBrandLink.response.status, 409);
  assert.equal(staleBrandLink.body.error.code, 'PRODUCT_CONFLICT');

  const projection = await requestJson(application, admin, `${contentPath}/zh-TW`);
  assert.equal(projection.response.status, 200);
  assert.equal(projection.body.data.sections[0].sortOrder, 2);
  assert.equal(projection.body.data.specs[0].specKey, 'uptime');

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.exec(`
    CREATE TRIGGER reject_content_audit
    BEFORE INSERT ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'forced audit failure');
    END;
  `);
  database.close();
  const rolledBack = await requestJson(application, admin, contentPath, {
    method: 'POST', body: { locale: 'en-US', title: 'Must roll back', bodyText: 'No partial content row.' },
  });
  assert.equal(rolledBack.response.status, 500);
  const verifyDatabase = new DatabaseSync(application.telecomDatabasePath, { readOnly: true });
  const count = Number(verifyDatabase.prepare(
    'SELECT COUNT(*) AS count FROM catalog_product_content WHERE product_id = ? AND locale = ?',
  ).get(product.id, 'en-US').count);
  verifyDatabase.close();
  assert.equal(count, 0);
});
