import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlRuntimeDatabase } from '../../src/server/db/mysql.mjs';

test('mysql runtime binds LIMIT and OFFSET as integer strings for prepared statements', async () => {
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{ id: 1 }], []];
    },
  };
  const database = createMysqlRuntimeDatabase({
    pool,
    databaseName: 'telecom_boss',
  });

  await database
    .prepare('SELECT id FROM customers WHERE status = ? ORDER BY id LIMIT ? OFFSET ?')
    .all('ACTIVE', 20, 0);
  await database
    .prepare('SELECT id FROM customers WHERE id = ?')
    .all(7);

  assert.deepEqual(calls[0].params, ['ACTIVE', '20', '0']);
  assert.deepEqual(calls[1].params, [7]);
});
