import assert from 'node:assert/strict';
import test from 'node:test';
import { mysqlDateTime } from '../../src/server/admin/access/access-repository.mjs';

test('access timestamps serialize ISO instants for MySQL DATETIME(3)', () => {
  assert.equal(mysqlDateTime('2026-08-21T05:42:04.233Z'), '2026-08-21 05:42:04.233');
  assert.equal(mysqlDateTime(null), null);
  assert.throws(() => mysqlDateTime('not-a-date'), /Invalid MySQL datetime value/);
});