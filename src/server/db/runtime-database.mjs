import { openSqliteDatabase } from './sqlite.mjs';

function sqliteStatement(database, sql) {
  const statement = database.prepare(sql);
  return {
    async all(...params) {
      return statement.all(...params);
    },
    async get(...params) {
      return statement.get(...params);
    },
    async run(...params) {
      const result = statement.run(...params);
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      };
    },
  };
}

export function createSqliteRuntimeDatabase(databasePath, { readOnly = false } = {}) {
  const raw = openSqliteDatabase(databasePath, { readOnly });
  let transactionDepth = 0;
  return {
    kind: 'sqlite',
    databasePath,
    prepare(sql) {
      return sqliteStatement(raw, sql);
    },
    async execute(sql) {
      raw.exec(sql);
    },
    async transaction(operation) {
      if (transactionDepth > 0) return operation(this);
      raw.exec('BEGIN IMMEDIATE');
      transactionDepth += 1;
      try {
        const result = await operation(this);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    async ping() {
      raw.prepare('SELECT 1 AS ok').get();
      return true;
    },
    async close() {
      raw.close();
    },
  };
}


export function openRuntimeDatabase(database, options = {}) {
  if (typeof database === 'string') return createSqliteRuntimeDatabase(database, options);
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    throw new TypeError('A runtime database adapter is required');
  }
  return {
    kind: database.kind,
    databasePath: database.databasePath,
    databaseName: database.databaseName,
    prepare: database.prepare.bind(database),
    execute: database.execute.bind(database),
    transaction: database.transaction.bind(database),
    ping: database.ping.bind(database),
    close() {},
  };
}

const SUCCESS_RESULT_KINDS = new Set([
  'created', 'updated', 'deleted', 'replayed', 'converted', 'found', 'resolved',
]);

class RollbackResultSignal extends Error {
  constructor(result) {
    super(`Transaction result requires rollback: ${result?.kind ?? 'unknown'}`);
    this.name = 'RollbackResultSignal';
    this.result = result;
  }
}

export async function runInTransaction(database, operation) {
  return database.transaction(operation);
}

export async function runAtomicResult(database, operation, {
  successKinds = SUCCESS_RESULT_KINDS,
} = {}) {
  try {
    return await database.transaction(async () => {
      const result = await operation();
      if (
        result
        && typeof result === 'object'
        && typeof result.kind === 'string'
        && !successKinds.has(result.kind)
      ) {
        throw new RollbackResultSignal(result);
      }
      return result;
    });
  } catch (error) {
    if (error instanceof RollbackResultSignal) return error.result;
    throw error;
  }
}
