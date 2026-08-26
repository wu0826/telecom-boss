import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_CONNECTION_LIMIT = 10;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 15;

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function mysqlRuntimeConfiguration(env = process.env) {
  const runtimeUser = required(env.DB_USER, 'DB_USER');
  if (runtimeUser === 'intern_migrate') {
    throw new Error('Runtime DB_USER must not use the privileged intern_migrate account');
  }
  const base = {
    host: env.DB_HOST ?? '127.0.0.1',
    port: positiveInteger(env.DB_PORT, 3306, 'DB_PORT'),
    user: runtimeUser,
    password: required(env.DB_PASSWORD, 'DB_PASSWORD'),
    connectionLimit: positiveInteger(
      env.DB_CONNECTION_LIMIT,
      DEFAULT_CONNECTION_LIMIT,
      'DB_CONNECTION_LIMIT',
    ),
    lockTimeoutSeconds: positiveInteger(
      env.DB_TRANSACTION_LOCK_TIMEOUT,
      DEFAULT_LOCK_TIMEOUT_SECONDS,
      'DB_TRANSACTION_LOCK_TIMEOUT',
    ),
  };
  return {
    ...base,
    metadataDatabaseName: required(env.WEBSITE_DB_NAME ?? 'website_db', 'WEBSITE_DB_NAME'),
    telecomDatabaseName: required(env.TELECOM_DB_NAME ?? 'telecom_boss', 'TELECOM_DB_NAME'),
  };
}


function normalizedUniqueTarget(error) {
  const detail = `${error?.message ?? ''} ${error?.sqlMessage ?? ''} ${error?.sql ?? ''}`.toLowerCase();
  const rules = [
    ['staff_users', ['staff_no', 'email', 'provider_subject']],
    ['service_plans', ['plan_code']],
    ['plan_prices', ['price_period_key']],
    ['cms_pages', ['slug']],
    ['invoices', ['billing_period_key']],
    ['catalog_categories', ['category_code', 'slug']],
    ['catalog_products', ['product_code', 'slug', 'service_plan_id', 'stock_item_id']],
  ];
  for (const [table, fields] of rules) {
    const tableMentioned = detail.includes(table)
      || new RegExp(`(?:insert\\s+into|update)\\s+[\x60\"]?${table}[\x60\"]?`, 'i').test(error?.sql ?? '');
    if (!tableMentioned) continue;
    for (const field of fields) {
      const shortField = field
        .replace(/^(?:category|product|plan)_/, '')
        .replace(/_id$/, '');
      const aliases = [
        field,
        field.replace(/_id$/, ''),
        `uq_${table}_${field}`,
        `uq_${table}_${shortField}`,
      ];
      if (aliases.some((alias) => detail.includes(alias))) return `${table}.${field}`;
    }
  }
  return null;
}

function mysqlError(error) {
  if (!error || typeof error !== 'object') return error;
  if (error.code === 'ER_DUP_ENTRY') {
    error.constraintKind = 'unique';
    error.mysqlMessage = error.message;
    const target = normalizedUniqueTarget(error);
    if (target) error.message = `UNIQUE constraint failed: ${target}`;
  } else if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
    error.constraintKind = 'foreign-key';
  } else if (error.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    error.constraintKind = 'check';
  }
  return error;
}

function mysqlExecuteParameters(sql, params) {
  if (!/\bLIMIT\s+\?\s+OFFSET\s+\?\s*;?\s*$/i.test(sql)) {
    return params;
  }
  const normalized = [...params];
  for (const index of [normalized.length - 2, normalized.length - 1]) {
    const value = normalized[index];
    if (Number.isSafeInteger(value) && value >= 0) {
      normalized[index] = String(value);
    }
  }
  return normalized;
}

export function createMysqlRuntimeDatabase({ pool, databaseName, lockTimeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS }) {
  const transactionStorage = new AsyncLocalStorage();

  function executor() {
    return transactionStorage.getStore() ?? pool;
  }

  return {
    kind: 'mysql',
    databaseName,
    prepare(sql) {
      return {
        async all(...params) {
          try {
            const [rows] = await executor().execute(sql, mysqlExecuteParameters(sql, params));
            return rows;
          } catch (error) {
            throw mysqlError(error);
          }
        },
        async get(...params) {
          try {
            const [rows] = await executor().execute(sql, mysqlExecuteParameters(sql, params));
            return rows[0];
          } catch (error) {
            throw mysqlError(error);
          }
        },
        async run(...params) {
          try {
            const [result] = await executor().execute(sql, mysqlExecuteParameters(sql, params));
            return {
              changes: Number(result.affectedRows ?? 0),
              lastInsertRowid: Number(result.insertId ?? 0),
            };
          } catch (error) {
            throw mysqlError(error);
          }
        },
      };
    },
    async execute(sql) {
      try {
        await executor().query(sql);
      } catch (error) {
        throw mysqlError(error);
      }
    },
    async transaction(operation) {
      if (transactionStorage.getStore()) return operation(this);
      const connection = await pool.getConnection();
      let lockHeld = false;
      let transactionStarted = false;
      try {
        const lockName = `telecom-runtime-write:${databaseName}`;
        const [lockRows] = await connection.execute(
          'SELECT GET_LOCK(?, ?) AS acquired',
          [lockName, lockTimeoutSeconds],
        );
        if (Number(lockRows[0]?.acquired) !== 1) {
          throw new Error(`Unable to acquire MySQL write lock for ${databaseName}`);
        }
        lockHeld = true;
        await connection.beginTransaction();
        transactionStarted = true;
        const result = await transactionStorage.run(connection, () => operation(this));
        await connection.commit();
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            await connection.rollback();
          } catch {
            // Preserve the original transaction failure.
          }
        }
        throw mysqlError(error);
      } finally {
        if (lockHeld) {
          try {
            await connection.execute('SELECT RELEASE_LOCK(?)', [`telecom-runtime-write:${databaseName}`]);
          } catch {
            // Connection release below remains mandatory even if lock release fails.
          }
        }
        connection.release();
      }
    },
    async ping() {
      const connection = await pool.getConnection();
      try {
        await connection.ping();
        return true;
      } finally {
        connection.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function createMysqlRuntimeDatabases(env = process.env) {
  const configuration = mysqlRuntimeConfiguration(env);
  const importedMysql = await import('mysql2/promise');
  const mysql = importedMysql.default ?? importedMysql;
  const common = {
    host: configuration.host,
    port: configuration.port,
    user: configuration.user,
    password: configuration.password,
    connectionLimit: configuration.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  };
  const metadataPool = mysql.createPool({ ...common, database: configuration.metadataDatabaseName });
  const telecomPool = mysql.createPool({ ...common, database: configuration.telecomDatabaseName });
  return {
    metadataDatabase: createMysqlRuntimeDatabase({
      pool: metadataPool,
      databaseName: configuration.metadataDatabaseName,
      lockTimeoutSeconds: configuration.lockTimeoutSeconds,
    }),
    telecomDatabase: createMysqlRuntimeDatabase({
      pool: telecomPool,
      databaseName: configuration.telecomDatabaseName,
      lockTimeoutSeconds: configuration.lockTimeoutSeconds,
    }),
  };
}
