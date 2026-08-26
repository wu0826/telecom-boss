import assert from 'node:assert/strict';
import test from 'node:test';

import { mysqlDateTime } from '../../src/server/admin/inquiries/inquiry-conversion-repository.mjs';

test('inquiry conversion formats ISO timestamps for MySQL DATETIME writes', () => {
  assert.equal(
    mysqlDateTime('2026-08-21T07:30:45.123Z'),
    '2026-08-21 07:30:45.123',
  );
});
