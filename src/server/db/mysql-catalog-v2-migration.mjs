import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { sha256Text, splitMysqlScript, summarizeMysqlScript } from './mysql-script.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, '..', '..', '..');
const MYSQL_MIGRATION_DIR = join(PROJECT_ROOT, 'database', 'migrations', 'mysql');

const CORE_REQUIRED_TABLES = Object.freeze([
  'staff_users',
  'service_plans',
  'stock_items',
  'promotions',
]);

const CATALOG_TABLES = Object.freeze([
  'catalog_categories',
  'catalog_products',
  'catalog_product_categories',
  'catalog_product_content',
  'catalog_product_sections',
  'catalog_product_media',
  'catalog_product_specs',
  'catalog_brands',
  'catalog_product_brands',
  'catalog_promotion_products',
]);

const CATALOG_TRIGGERS = Object.freeze([
  'trg_catalog_categories_insert_depth',
  'trg_catalog_categories_update_parent',
]);

export const MYSQL_CATALOG_V2_MIGRATION = Object.freeze({
  version: 2,
  name: 'create_catalog_v2_schema',
  upPath: join(MYSQL_MIGRATION_DIR, '002_catalog_v2_up.sql'),
  downPath: join(MYSQL_MIGRATION_DIR, '002_catalog_v2_down.sql'),
});

export class MysqlCatalogMigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MysqlCatalogMigrationError';
  }
}

function firstValue(rows, key) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0]?.[key] ?? Object.values(rows[0] ?? {})[0] ?? null;
}

async function queryRows(connection, sql, values = []) {
  const [rows] = await connection.query(sql, values);
  return rows;
}

async function executeStatements(connection, statements) {
  for (const [index, statement] of statements.entries()) {
    try {
      await connection.query(statement);
    } catch (error) {
      throw new MysqlCatalogMigrationError(
        `MySQL migration statement ${index + 1}/${statements.length} failed`,
        { cause: error },
      );
    }
  }
}

async function loadMigrationFiles() {
  const [upSql, downSql] = await Promise.all([
    readFile(MYSQL_CATALOG_V2_MIGRATION.upPath, 'utf8'),
    readFile(MYSQL_CATALOG_V2_MIGRATION.downPath, 'utf8'),
  ]);
  return {
    upSql,
    downSql,
    upStatements: splitMysqlScript(upSql),
    downStatements: splitMysqlScript(downSql),
  };
}

export async function getMysqlCatalogV2Plan() {
  const { upSql, downSql } = await loadMigrationFiles();
  return {
    migration: {
      version: MYSQL_CATALOG_V2_MIGRATION.version,
      name: MYSQL_CATALOG_V2_MIGRATION.name,
    },
    up: summarizeMysqlScript(upSql),
    down: summarizeMysqlScript(downSql),
    requiredTables: [...CORE_REQUIRED_TABLES],
    createsTables: [...CATALOG_TABLES],
    createsTriggers: [...CATALOG_TRIGGERS],
  };
}

async function assertBackupFile(backupPath) {
  if (!backupPath) {
    throw new MysqlCatalogMigrationError(
      'MYSQL_MIGRATION_BACKUP_PATH must point to a verified non-empty backup before applying MySQL v2',
    );
  }
  const resolved = resolve(backupPath);
  try {
    await access(resolved, constants.R_OK);
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('backup is empty');
    return { path: resolved, size: metadata.size };
  } catch (error) {
    throw new MysqlCatalogMigrationError(`Migration backup is missing or unreadable: ${resolved}`, {
      cause: error,
    });
  }
}

async function readMigrationHistory(connection) {
  const tableRows = await queryRows(connection, `
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = '_schema_migrations'
  `);
  if (Number(firstValue(tableRows, 'count')) !== 1) {
    throw new MysqlCatalogMigrationError(
      'MySQL telecom_boss must already contain _schema_migrations from the v1 deployment',
    );
  }

  const rows = await queryRows(connection, `
    SELECT version, name
    FROM _schema_migrations
    ORDER BY version
  `);
  const normalized = rows.map((row) => ({ version: Number(row.version), name: String(row.name) }));
  if (normalized.length === 0) {
    throw new MysqlCatalogMigrationError('MySQL migration registry is empty');
  }
  if (normalized[0].version !== 1 || normalized[0].name !== 'create_telecom_schema') {
    throw new MysqlCatalogMigrationError(
      'MySQL migration v1 must be create_telecom_schema before Catalog V2 can be applied',
    );
  }
  return normalized;
}

async function assertCoreSchemaCompatible(connection) {
  const placeholders = CORE_REQUIRED_TABLES.map(() => '?').join(', ');
  const tableRows = await queryRows(connection, `
    SELECT TABLE_NAME AS table_name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN (${placeholders})
  `, CORE_REQUIRED_TABLES);
  const existing = new Set(tableRows.map((row) => row.table_name));
  const missing = CORE_REQUIRED_TABLES.filter((tableName) => !existing.has(tableName));
  if (missing.length > 0) {
    throw new MysqlCatalogMigrationError(
      `Catalog V2 requires missing core table(s): ${missing.join(', ')}`,
    );
  }

  const idRows = await queryRows(connection, `
    SELECT TABLE_NAME AS table_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND column_name = 'id'
      AND table_name IN (${placeholders})
  `, CORE_REQUIRED_TABLES);
  const byTable = new Map(idRows.map((row) => [row.table_name, row]));
  for (const tableName of CORE_REQUIRED_TABLES) {
    const row = byTable.get(tableName);
    const columnType = String(row?.column_type ?? '').toLowerCase();
    if (String(row?.data_type ?? '').toLowerCase() !== 'bigint' || columnType.includes('unsigned')) {
      throw new MysqlCatalogMigrationError(
        `${tableName}.id must be signed BIGINT before Catalog V2 migration`,
      );
    }
  }
}

async function findExistingCatalogObjects(connection) {
  const tablePlaceholders = CATALOG_TABLES.map(() => '?').join(', ');
  const triggerPlaceholders = CATALOG_TRIGGERS.map(() => '?').join(', ');
  const [tableRows, triggerRows] = await Promise.all([
    queryRows(connection, `
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND TABLE_NAME IN (${tablePlaceholders})
      ORDER BY TABLE_NAME
    `, CATALOG_TABLES),
    queryRows(connection, `
      SELECT TRIGGER_NAME AS trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = DATABASE()
        AND trigger_name IN (${triggerPlaceholders})
      ORDER BY trigger_name
    `, CATALOG_TRIGGERS),
  ]);
  return {
    tables: tableRows.map((row) => row.table_name),
    triggers: triggerRows.map((row) => row.trigger_name),
  };
}

async function verifyCatalogV2Objects(connection) {
  const found = await findExistingCatalogObjects(connection);
  const missingTables = CATALOG_TABLES.filter((name) => !found.tables.includes(name));
  const missingTriggers = CATALOG_TRIGGERS.filter((name) => !found.triggers.includes(name));
  if (missingTables.length || missingTriggers.length) {
    throw new MysqlCatalogMigrationError(
      `Catalog V2 verification failed; missing tables=[${missingTables.join(', ')}], triggers=[${missingTriggers.join(', ')}]`,
    );
  }
  return found;
}

async function cleanupPartialCatalogV2(connection, downStatements) {
  try {
    await executeStatements(connection, downStatements);
    return { attempted: true, succeeded: true };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertExpectedMigrationUser(expectedUser) {
  if (!expectedUser || expectedUser !== 'intern_migrate') {
    throw new MysqlCatalogMigrationError(
      'Refusing MySQL schema migration unless DB_USER is exactly intern_migrate',
    );
  }
}

export async function applyMysqlCatalogV2Migration({
  connection,
  migrationUser,
  backupPath,
  lockTimeoutSeconds = 15,
}) {
  if (!connection || typeof connection.query !== 'function') {
    throw new MysqlCatalogMigrationError('A MySQL connection is required');
  }
  assertExpectedMigrationUser(migrationUser);
  const { upSql, downSql, upStatements, downStatements } = await loadMigrationFiles();
  const lockName = 'telecom_boss:schema-migration';
  let lockAcquired = false;

  try {
    const lockRows = await queryRows(connection, 'SELECT GET_LOCK(?, ?) AS acquired', [
      lockName,
      lockTimeoutSeconds,
    ]);
    if (Number(firstValue(lockRows, 'acquired')) !== 1) {
      throw new MysqlCatalogMigrationError('Could not acquire the MySQL schema migration lock');
    }
    lockAcquired = true;

    const history = await readMigrationHistory(connection);
    const existingV2 = history.find(({ version }) => version === MYSQL_CATALOG_V2_MIGRATION.version);
    if (existingV2) {
      if (existingV2.name !== MYSQL_CATALOG_V2_MIGRATION.name) {
        throw new MysqlCatalogMigrationError(
          `Migration version 2 is already registered as ${existingV2.name}`,
        );
      }
      const objects = await verifyCatalogV2Objects(connection);
      return {
        status: 'already-applied',
        version: 2,
        name: MYSQL_CATALOG_V2_MIGRATION.name,
        objects,
        backup: null,
      };
    }

    const unexpectedLater = history.find(({ version }) => version > 2);
    if (unexpectedLater) {
      throw new MysqlCatalogMigrationError(
        `Database already contains later migration version ${unexpectedLater.version}`,
      );
    }

    await assertCoreSchemaCompatible(connection);
    const preexisting = await findExistingCatalogObjects(connection);
    if (preexisting.tables.length || preexisting.triggers.length) {
      throw new MysqlCatalogMigrationError(
        `Catalog V2 objects exist without a v2 registry row; recover this database before retrying (tables=[${preexisting.tables.join(', ')}], triggers=[${preexisting.triggers.join(', ')}])`,
      );
    }

    const backup = await assertBackupFile(backupPath);

    try {
      await executeStatements(connection, upStatements);
      const objects = await verifyCatalogV2Objects(connection);
      await connection.query(
        `INSERT INTO _schema_migrations (version, name) VALUES (?, ?)`,
        [MYSQL_CATALOG_V2_MIGRATION.version, MYSQL_CATALOG_V2_MIGRATION.name],
      );
      return {
        status: 'applied',
        version: 2,
        name: MYSQL_CATALOG_V2_MIGRATION.name,
        backup,
        objects,
        checksum: {
          upSha256: sha256Text(upSql),
          downSha256: sha256Text(downSql),
        },
      };
    } catch (error) {
      const cleanup = await cleanupPartialCatalogV2(connection, downStatements);
      throw new MysqlCatalogMigrationError(
        cleanup.succeeded
          ? 'Catalog V2 migration failed; newly created v2 objects were removed by compensating rollback'
          : `Catalog V2 migration failed and compensating rollback also failed: ${cleanup.error}`,
        { cause: error },
      );
    }
  } finally {
    if (lockAcquired) {
      try {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // Closing the migration connection also releases MySQL named locks.
      }
    }
  }
}

export async function rollbackMysqlCatalogV2Migration({
  connection,
  migrationUser,
  backupPath,
  confirmDataLoss = false,
  lockTimeoutSeconds = 15,
}) {
  if (!connection || typeof connection.query !== 'function') {
    throw new MysqlCatalogMigrationError('A MySQL connection is required');
  }
  assertExpectedMigrationUser(migrationUser);
  if (!confirmDataLoss) {
    throw new MysqlCatalogMigrationError(
      'Manual Catalog V2 rollback deletes Catalog V2 data; pass explicit confirmation before proceeding',
    );
  }
  const backup = await assertBackupFile(backupPath);
  const { downStatements } = await loadMigrationFiles();
  const lockName = 'telecom_boss:schema-migration';
  let lockAcquired = false;

  try {
    const lockRows = await queryRows(connection, 'SELECT GET_LOCK(?, ?) AS acquired', [
      lockName,
      lockTimeoutSeconds,
    ]);
    if (Number(firstValue(lockRows, 'acquired')) !== 1) {
      throw new MysqlCatalogMigrationError('Could not acquire the MySQL schema migration lock');
    }
    lockAcquired = true;

    const history = await readMigrationHistory(connection);
    const existingV2 = history.find(({ version }) => version === 2);
    if (!existingV2) {
      return { status: 'already-rolled-back', version: 1, backup };
    }
    if (existingV2.name !== MYSQL_CATALOG_V2_MIGRATION.name) {
      throw new MysqlCatalogMigrationError(`Migration version 2 is ${existingV2.name}, not Catalog V2`);
    }
    if (history.some(({ version }) => version > 2)) {
      throw new MysqlCatalogMigrationError('Rollback v2 is blocked while later migrations are applied');
    }

    await executeStatements(connection, downStatements);
    const remaining = await findExistingCatalogObjects(connection);
    if (remaining.tables.length || remaining.triggers.length) {
      throw new MysqlCatalogMigrationError('Catalog V2 rollback verification failed');
    }
    const [result] = await connection.query(
      'DELETE FROM _schema_migrations WHERE version = ? AND name = ?',
      [2, MYSQL_CATALOG_V2_MIGRATION.name],
    );
    if (Number(result?.affectedRows) !== 1) {
      throw new MysqlCatalogMigrationError('Catalog V2 registry row was not removed');
    }
    return { status: 'rolled-back', version: 1, backup };
  } finally {
    if (lockAcquired) {
      try {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // Closing the migration connection also releases MySQL named locks.
      }
    }
  }
}

