import assert from 'node:assert/strict';
import test from 'node:test';

import { mysqlDateTime } from '../../src/server/admin/products/content-repository.mjs';

test('Catalog V2 product-content timestamps serialize ISO instants for MySQL DATETIME(3)', () => {
  assert.equal(mysqlDateTime('2026-08-24T05:27:57.123Z'), '2026-08-24 05:27:57.123');
  assert.equal(mysqlDateTime(null), null);
  assert.throws(() => mysqlDateTime('not-a-date'), /Invalid MySQL datetime value/);
});
