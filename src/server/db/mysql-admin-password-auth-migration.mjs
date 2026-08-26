import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Text, splitMysqlScript, summarizeMysqlScript } from './mysql-script.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, '..', '..', '..');
const MIGRATION_DIR = join(PROJECT_ROOT, 'database', 'migrations', 'mysql');

export const MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION = Object.freeze({
  version: 3,
  name: 'create_admin_password_auth',
  upPath: join(MIGRATION_DIR, '003_admin_password_auth_up.sql'),
  downPath: join(MIGRATION_DIR, '003_admin_password_auth_down.sql'),
});

export class MysqlAdminPasswordAuthMigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MysqlAdminPasswordAuthMigrationError';
  }
}

async function queryRows(connection, sql, values = []) {
  const [rows] = await connection.query(sql, values);
  return rows;
}

async function loadFiles() {
  const [upSql, downSql] = await Promise.all([
    readFile(MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.upPath, 'utf8'),
    readFile(MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.downPath, 'utf8'),
  ]);
  return { upSql, downSql, upStatements: splitMysqlScript(upSql), downStatements: splitMysqlScript(downSql) };
}

async function executeStatements(connection, statements) {
  for (const [index, statement] of statements.entries()) {
    try { await connection.query(statement); }
    catch (error) {
      throw new MysqlAdminPasswordAuthMigrationError(
        `MySQL migration v3 statement ${index + 1}/${statements.length} failed`, { cause: error },
      );
    }
  }
}

async function backupFile(backupPath) {
  if (!backupPath) throw new MysqlAdminPasswordAuthMigrationError('MYSQL_MIGRATION_BACKUP_PATH is required before applying MySQL v3');
  const resolved = resolve(backupPath);
  try {
    await access(resolved, constants.R_OK);
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('backup is empty');
    return { path: resolved, size: metadata.size };
  } catch (error) {
    throw new MysqlAdminPasswordAuthMigrationError(`Migration backup is missing or unreadable: ${resolved}`, { cause: error });
  }
}

async function history(connection) {
  const rows = await queryRows(connection, 'SELECT version, name FROM _schema_migrations ORDER BY version');
  return rows.map((row) => ({ version: Number(row.version), name: String(row.name) }));
}

async function objectExists(connection) {
  const rows = await queryRows(connection, `
    SELECT COUNT(*) AS count FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'staff_password_credentials'
  `);
  return Number(rows[0]?.count) === 1;
}

function assertUser(user) {
  if (user !== 'intern_migrate') throw new MysqlAdminPasswordAuthMigrationError('Refusing MySQL v3 migration unless DB_USER is intern_migrate');
}

export async function getMysqlAdminPasswordAuthPlan() {
  const { upSql, downSql } = await loadFiles();
  return {
    migration: { version: 3, name: MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.name },
    up: summarizeMysqlScript(upSql),
    down: summarizeMysqlScript(downSql),
    requiresMigrations: ['create_telecom_schema', 'create_catalog_v2_schema'],
    createsTables: ['staff_password_credentials'],
  };
}

export async function applyMysqlAdminPasswordAuthMigration({ connection, migrationUser, backupPath, lockTimeoutSeconds = 15 }) {
  assertUser(migrationUser);
  const lockName = 'telecom_boss:schema-migration';
  let lockHeld = false;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, lockTimeoutSeconds]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new MysqlAdminPasswordAuthMigrationError('Could not acquire the MySQL schema migration lock');
    lockHeld = true;
    const applied = await history(connection);
    const expected = [[1, 'create_telecom_schema'], [2, 'create_catalog_v2_schema']];
    for (const [version, name] of expected) {
      if (!applied.some((row) => row.version === version && row.name === name)) {
        throw new MysqlAdminPasswordAuthMigrationError(`MySQL migration v${version} ${name} must be applied before v3`);
      }
    }
    const existing = applied.find((row) => row.version === 3);
    if (existing) {
      if (existing.name !== MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.name) throw new MysqlAdminPasswordAuthMigrationError(`Migration version 3 is already registered as ${existing.name}`);
      if (!(await objectExists(connection))) throw new MysqlAdminPasswordAuthMigrationError('Migration v3 is registered but staff_password_credentials is missing');
      return { status: 'already-applied', version: 3, name: existing.name, backup: null };
    }
    if (applied.some((row) => row.version > 3)) throw new MysqlAdminPasswordAuthMigrationError('Database contains a later migration before v3');
    if (await objectExists(connection)) throw new MysqlAdminPasswordAuthMigrationError('staff_password_credentials exists without a v3 registry row');
    const backup = await backupFile(backupPath);
    const { upSql, downSql, upStatements, downStatements } = await loadFiles();
    try {
      await executeStatements(connection, upStatements);
      if (!(await objectExists(connection))) throw new MysqlAdminPasswordAuthMigrationError('MySQL v3 verification failed');
      await connection.query('INSERT INTO _schema_migrations (version, name) VALUES (?, ?)', [3, MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.name]);
      return { status: 'applied', version: 3, name: MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.name, backup, checksum: { upSha256: sha256Text(upSql), downSha256: sha256Text(downSql) } };
    } catch (error) {
      try { await executeStatements(connection, downStatements); } catch { /* preserve original */ }
      throw new MysqlAdminPasswordAuthMigrationError('Admin password authentication migration failed; compensating cleanup was attempted', { cause: error });
    }
  } finally {
    if (lockHeld) { try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch {} }
  }
}

export async function rollbackMysqlAdminPasswordAuthMigration({ connection, migrationUser, backupPath, confirmDataLoss = false, lockTimeoutSeconds = 15 }) {
  assertUser(migrationUser);
  if (!confirmDataLoss) throw new MysqlAdminPasswordAuthMigrationError('Rollback v3 deletes password credentials; explicit confirmation is required');
  const backup = await backupFile(backupPath);
  const lockName = 'telecom_boss:schema-migration';
  let lockHeld = false;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, lockTimeoutSeconds]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new MysqlAdminPasswordAuthMigrationError('Could not acquire the MySQL schema migration lock');
    lockHeld = true;
    const applied = await history(connection);
    const existing = applied.find((row) => row.version === 3);
    if (!existing) return { status: 'already-rolled-back', version: 2, backup };
    if (applied.some((row) => row.version > 3)) throw new MysqlAdminPasswordAuthMigrationError('Rollback v3 is blocked while later migrations are applied');
    const { downStatements } = await loadFiles();
    await executeStatements(connection, downStatements);
    await connection.query('DELETE FROM _schema_migrations WHERE version = 3 AND name = ?', [MYSQL_ADMIN_PASSWORD_AUTH_MIGRATION.name]);
    return { status: 'rolled-back', version: 2, backup };
  } finally {
    if (lockHeld) { try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch {} }
  }
}
