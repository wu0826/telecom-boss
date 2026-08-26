import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMysqlRuntimeDatabase,
  mysqlRuntimeConfiguration,
} from '../../src/server/db/mysql.mjs';

function createFakeConnection({ lockAcquired = 1 } = {}) {
  const calls = [];
  const connection = {
    calls,
    async execute(sql, params = []) {
      calls.push(['execute', sql, params]);
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: lockAcquired }], []];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []];
      if (/^SELECT\b/i.test(sql)) return [[{ source: 'connection' }], []];
      return [{ affectedRows: 1, insertId: 77 }, []];
    },
    async query(sql) {
      calls.push(['query', sql]);
      return [[], []];
    },
    async beginTransaction() {
      calls.push(['beginTransaction']);
    },
    async commit() {
      calls.push(['commit']);
    },
    async rollback() {
      calls.push(['rollback']);
    },
    async ping() {
      calls.push(['ping']);
    },
    release() {
      calls.push(['release']);
    },
  };
  return connection;
}

test('mysql runtime configuration validates and normalizes production pool settings', () => {
  assert.deepEqual(
    mysqlRuntimeConfiguration({
      DB_USER: 'intern',
      DB_PASSWORD: 'secret',
      DB_PORT: '3307',
      DB_CONNECTION_LIMIT: '12',
      DB_TRANSACTION_LOCK_TIMEOUT: '20',
      WEBSITE_DB_NAME: 'website_db',
      TELECOM_DB_NAME: 'telecom_boss',
    }),
    {
      host: '127.0.0.1',
      port: 3307,
      user: 'intern',
      password: 'secret',
      connectionLimit: 12,
      lockTimeoutSeconds: 20,
      metadataDatabaseName: 'website_db',
      telecomDatabaseName: 'telecom_boss',
    },
  );
  assert.throws(() => mysqlRuntimeConfiguration({ DB_USER: 'intern', DB_PASSWORD: '' }), /DB_PASSWORD is required/);
  assert.throws(
    () => mysqlRuntimeConfiguration({ DB_USER: 'intern', DB_PASSWORD: 'secret', DB_CONNECTION_LIMIT: '0' }),
    /DB_CONNECTION_LIMIT must be a positive integer/,
  );
  assert.throws(
    () => mysqlRuntimeConfiguration({ DB_USER: 'intern_migrate', DB_PASSWORD: 'secret' }),
    /must not use the privileged intern_migrate account/,
  );
});

test('mysql runtime prepare facade normalizes reads and writes', async () => {
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push([sql, params]);
      if (/^SELECT\b/i.test(sql)) return [[{ id: 1 }, { id: 2 }], []];
      return [{ affectedRows: 2, insertId: 42 }, []];
    },
  };
  const database = createMysqlRuntimeDatabase({ pool, databaseName: 'telecom_boss' });

  assert.deepEqual(await database.prepare('SELECT id FROM example WHERE kind = ?').all('A'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await database.prepare('SELECT id FROM example WHERE kind = ?').get('A'), { id: 1 });
  assert.deepEqual(await database.prepare('UPDATE example SET kind = ?').run('B'), {
    changes: 2,
    lastInsertRowid: 42,
  });
  assert.equal(calls.length, 3);
});

test('mysql runtime transaction pins queries to one connection and releases its named lock', async () => {
  const connection = createFakeConnection();
  const poolCalls = [];
  const pool = {
    async getConnection() {
      poolCalls.push('getConnection');
      return connection;
    },
    async execute() {
      throw new Error('pool.execute must not run inside the transaction');
    },
  };
  const database = createMysqlRuntimeDatabase({
    pool,
    databaseName: 'telecom_boss',
    lockTimeoutSeconds: 9,
  });

  const result = await database.transaction(async (transactionDatabase) => {
    assert.deepEqual(await transactionDatabase.prepare('UPDATE examples SET value = ? WHERE id = ?').run('x', 1), {
      changes: 1,
      lastInsertRowid: 77,
    });
    const nested = await transactionDatabase.transaction(async (nestedDatabase) => (
      nestedDatabase.prepare('SELECT id FROM examples WHERE id = ?').get(1)
    ));
    assert.deepEqual(nested, { source: 'connection' });
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(poolCalls, ['getConnection']);
  assert.deepEqual(connection.calls[0], [
    'execute',
    'SELECT GET_LOCK(?, ?) AS acquired',
    ['telecom-runtime-write:telecom_boss', 9],
  ]);
  assert.ok(connection.calls.some(([name]) => name === 'beginTransaction'));
  assert.ok(connection.calls.some(([name]) => name === 'commit'));
  assert.ok(!connection.calls.some(([name]) => name === 'rollback'));
  assert.ok(connection.calls.some(([name, sql]) => name === 'execute' && sql === 'SELECT RELEASE_LOCK(?)'));
  assert.equal(connection.calls.at(-1)[0], 'release');
});

test('mysql runtime transaction rolls back and releases the connection after a failure', async () => {
  const connection = createFakeConnection();
  const pool = {
    async getConnection() {
      return connection;
    },
  };
  const database = createMysqlRuntimeDatabase({ pool, databaseName: 'telecom_boss' });

  await assert.rejects(
    database.transaction(async (transactionDatabase) => {
      await transactionDatabase.prepare('UPDATE examples SET value = ?').run('x');
      throw new Error('write failed');
    }),
    /write failed/,
  );

  assert.ok(connection.calls.some(([name]) => name === 'rollback'));
  assert.ok(!connection.calls.some(([name]) => name === 'commit'));
  assert.ok(connection.calls.some(([name, sql]) => name === 'execute' && sql === 'SELECT RELEASE_LOCK(?)'));
  assert.equal(connection.calls.at(-1)[0], 'release');
});


test('mysql runtime stops safely when the named write lock cannot be acquired', async () => {
  const connection = createFakeConnection({ lockAcquired: 0 });
  const pool = {
    async getConnection() {
      return connection;
    },
  };
  const database = createMysqlRuntimeDatabase({ pool, databaseName: 'telecom_boss' });

  await assert.rejects(
    database.transaction(async () => 'should-not-run'),
    /Unable to acquire MySQL write lock for telecom_boss/,
  );

  assert.ok(!connection.calls.some(([name]) => name === 'beginTransaction'));
  assert.ok(!connection.calls.some(([name]) => name === 'rollback'));
  assert.ok(!connection.calls.some(([name, sql]) => name === 'execute' && sql === 'SELECT RELEASE_LOCK(?)'));
  assert.equal(connection.calls.at(-1)[0], 'release');
});

test('mysql runtime converts duplicate, foreign-key, and check errors into repository constraint semantics', async () => {
  const duplicate = Object.assign(new Error("Duplicate entry 'CAT-01' for key 'catalog_categories.uq_catalog_categories_code'"), {
    code: 'ER_DUP_ENTRY',
    sql: 'INSERT INTO catalog_categories (category_code) VALUES (?)',
  });
  const foreignKey = Object.assign(new Error('Cannot add or update a child row'), {
    code: 'ER_NO_REFERENCED_ROW_2',
  });
  const check = Object.assign(new Error('Check constraint violated'), {
    code: 'ER_CHECK_CONSTRAINT_VIOLATED',
  });
  const errors = [duplicate, foreignKey, check];
  const pool = {
    async execute() {
      throw errors.shift();
    },
  };
  const database = createMysqlRuntimeDatabase({ pool, databaseName: 'telecom_boss' });

  await assert.rejects(
    database.prepare('INSERT INTO catalog_categories (category_code) VALUES (?)').run('CAT-01'),
    (error) => {
      assert.equal(error.constraintKind, 'unique');
      assert.equal(error.message, 'UNIQUE constraint failed: catalog_categories.category_code');
      assert.match(error.mysqlMessage, /Duplicate entry/);
      return true;
    },
  );
  await assert.rejects(
    database.prepare('INSERT INTO child VALUES (?)').run(1),
    (error) => error.constraintKind === 'foreign-key',
  );
  await assert.rejects(
    database.prepare('INSERT INTO checked VALUES (?)').run(1),
    (error) => error.constraintKind === 'check',
  );
});

test('mysql runtime ping and close use pool lifecycle methods without leaking a connection', async () => {
  const connection = createFakeConnection();
  let ended = 0;
  const pool = {
    async getConnection() {
      return connection;
    },
    async end() {
      ended += 1;
    },
  };
  const database = createMysqlRuntimeDatabase({ pool, databaseName: 'telecom_boss' });

  assert.equal(await database.ping(), true);
  await database.close();
  assert.ok(connection.calls.some(([name]) => name === 'ping'));
  assert.ok(connection.calls.some(([name]) => name === 'release'));
  assert.equal(ended, 1);
});
