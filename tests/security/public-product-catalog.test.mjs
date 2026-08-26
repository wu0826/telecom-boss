import assert from 'node:assert/strict';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

test('public Catalog V2 routes reject malformed selectors and retain fixed safe response boundaries', async (t) => {
  const application = await startSeededApplication(t, {
    catalogClock: () => Date.parse('2026-08-17T00:00:00.000Z'),
  });
  const malformedLocale = await fetch(`${application.origin}/api/v1/catalog/products?locale=zh-TW%3Cscript%3E`);
  assert.equal(malformedLocale.status, 422);
  assert.equal((await malformedLocale.json()).error.code, 'INVALID_LOCALE');
  const duplicateLocale = await fetch(`${application.origin}/api/v1/catalog/products?locale=zh-TW&locale=en-US`);
  assert.equal(duplicateLocale.status, 422);
  assert.equal((await duplicateLocale.json()).error.code, 'INVALID_LOCALE');
  const malformedCategory = await fetch(`${application.origin}/api/v1/catalog/products?category=%2F%2Fother.example`);
  assert.equal(malformedCategory.status, 422);
  assert.equal((await malformedCategory.json()).error.code, 'INVALID_CATEGORY');
  const malformedSlug = await fetch(`${application.origin}/api/v1/catalog/products/%2Funsafe`);
  assert.equal(malformedSlug.status, 404);
  assert.equal((await malformedSlug.json()).error.code, 'PRODUCT_NOT_FOUND');
  const unsupported = await fetch(`${application.origin}/api/v1/catalog/products`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
});
