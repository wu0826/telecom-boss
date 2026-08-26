import assert from 'node:assert/strict';
import test from 'node:test';
import { mysqlDateTime as repositoryDateTime } from '../../src/server/admin/orders/order-repository.mjs';
import { mysqlDateTime as workflowDateTime } from '../../src/server/admin/orders/order-workflow.mjs';

test('order persistence serializes ISO instants for MySQL DATETIME(3)', () => {
  const value = '2026-08-21T05:44:10.092Z';
  assert.equal(repositoryDateTime(value), '2026-08-21 05:44:10.092');
  assert.equal(workflowDateTime(value), '2026-08-21 05:44:10.092');
  assert.equal(repositoryDateTime(null), null);
  assert.throws(() => workflowDateTime('not-a-date'), /Invalid MySQL datetime value/);
});