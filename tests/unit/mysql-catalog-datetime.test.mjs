import assert from 'node:assert/strict';
import test from 'node:test';
import { mysqlDateTime } from '../../src/server/admin/catalog/plan-repository.mjs';

test('catalog plan timestamps serialize ISO instants for MySQL DATETIME(3)', () => {
  assert.equal(mysqlDateTime('2026-08-20T05:26:19.935Z'), '2026-08-20 05:26:19.935');
  assert.equal(mysqlDateTime(null), null);
  assert.throws(() => mysqlDateTime('not-a-date'), /Invalid MySQL datetime value/);
});