import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mysqlDateTime,
  writeDateTime,
} from '../../src/server/admin/inquiries/inquiry-repository.mjs';

test('inquiry workflow timestamps convert only at the MySQL boundary', () => {
  const timestamp = '2026-08-24T01:48:12.345Z';

  assert.equal(mysqlDateTime(timestamp), '2026-08-24 01:48:12.345');
  assert.equal(
    writeDateTime({ kind: 'mysql' }, timestamp),
    '2026-08-24 01:48:12.345',
  );
  assert.equal(writeDateTime({ kind: 'sqlite' }, timestamp), timestamp);
});
