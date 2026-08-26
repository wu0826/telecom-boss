import { rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createVerifiedDatabaseBackup,
  openSqliteDatabase,
} from './sqlite.mjs';
import { CATALOG_V2_MIGRATION } from './catalog-v2-migration.mjs';
import { ADMIN_PASSWORD_AUTH_MIGRATION } from './admin-password-auth-migration.mjs';
import { migrateTelecomDatabase } from './telecom-migration.mjs';

const MIGRATION_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export const TELECOM_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'create_telecom_schema',
  }),
  CATALOG_V2_MIGRATION,
  ADMIN_PASSWORD_AUTH_MIGRATION,
]);

export class IncrementalMigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'IncrementalMigrationError';
  }
}

function validateMigrationDefinitions(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new IncrementalMigrationError('At least one migration definition is required');
  }

  const versions = new Set();
  const names = new Set();
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration?.version) || migration.version < 1) {
      throw new IncrementalMigrationError('Migration versions must be positive integers');
    }
    if (versions.has(migration.version)) {
      throw new IncrementalMigrationError(`Found duplicate migration version ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new IncrementalMigrationError(`Found duplicate migration name ${migration.name}`);
    }
    if (migration.version <= previousVersion) {
      throw new IncrementalMigrationError('Migration definitions must be strictly ordered');
    }
    if (!MIGRATION_NAME_PATTERN.test(migration.name ?? '')) {
      throw new IncrementalMigrationError(`Invalid migration name: ${migration.name ?? ''}`);
    }
    versions.add(migration.version);
    names.add(migration.name);
    previousVersion = migration.version;
  }

  for (let version = 1; version <= migrations.length; version += 1) {
    if (!versions.has(version)) {
      throw new IncrementalMigrationError(`Found missing migration version ${version}`);
    }
  }
}

function readAndValidateHistory(database, migrations) {
  let history;
  try {
    history = database.prepare(`
      SELECT version, name
      FROM _schema_migrations
      ORDER BY version
    `).all();
  } catch (error) {
    throw new IncrementalMigrationError(
      'Database must contain the initialized _schema_migrations registry',
      { cause: error },
    );
  }

  if (history.length === 0) {
    throw new IncrementalMigrationError('Migration registry cannot be empty');
  }
  for (const [index, migration] of history.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new IncrementalMigrationError(
        `Applied migration history is missing version ${expectedVersion}`,
      );
    }
    const definition = migrations[index];
    if (!definition) {
      throw new IncrementalMigrationError(
        `Applied migration version ${migration.version} has no local definition`,
      );
    }
    if (migration.name !== definition.name) {
      throw new IncrementalMigrationError(
        `Applied migration version ${migration.version} name does not match local definition`,
      );
    }
  }
  return history;
}

function assertDatabaseHealth(database) {
  const integrity = database.prepare('PRAGMA integrity_check').all()
    .map((row) => Object.values(row).at(0));
  if (integrity.length !== 1 || integrity[0] !== 'ok') {
    throw new IncrementalMigrationError(`Database integrity check failed: ${integrity.join(', ')}`);
  }
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    throw new IncrementalMigrationError(
      `Database foreign key check failed with ${foreignKeyErrors.length} error(s)`,
    );
  }
  return { integrity: 'ok', foreignKeyErrorCount: 0 };
}

function checkpointDatabase(database) {
  const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (Number(result?.busy) !== 0) {
    throw new IncrementalMigrationError(
      'Unable to checkpoint the database; stop active writers before migration',
    );
  }
}

async function requireExistingDatabase(databasePath) {
  try {
    const metadata = await stat(databasePath);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('not a non-empty file');
  } catch (error) {
    throw new IncrementalMigrationError(
      `Incremental migration requires an existing database: ${databasePath}`,
      { cause: error },
    );
  }
}

async function databaseFileExists(databasePath) {
  try {
    const metadata = await stat(databasePath);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new IncrementalMigrationError(
        `Database target must be a non-empty file when it already exists: ${databasePath}`,
      );
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error instanceof IncrementalMigrationError) throw error;
    throw new IncrementalMigrationError(`Unable to inspect database target: ${databasePath}`, {
      cause: error,
    });
  }
}

async function beginProtectedChange({
  database,
  databasePath,
  backupPath,
  requireBackup = true,
}) {
  checkpointDatabase(database);
  database.exec('BEGIN IMMEDIATE');
  if (!backupPath && !requireBackup) return null;
  try {
    return await createVerifiedDatabaseBackup({ databasePath, backupPath });
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function rollbackOpenTransaction(database) {
  try {
    database.exec('ROLLBACK');
  } catch {
    // SQLite has already rolled back or closed the failed transaction.
  }
}

async function applyIncrementalMigrations({
  databasePath,
  backupPath = null,
  migrations,
  requireBackup,
}) {
  validateMigrationDefinitions(migrations);
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedBackupPath = backupPath ? resolve(backupPath) : null;
  await requireExistingDatabase(resolvedDatabasePath);

  const database = openSqliteDatabase(resolvedDatabasePath);
  try {
    const history = readAndValidateHistory(database, migrations);
    const previousVersion = history.at(-1).version;
    const pending = migrations.filter(({ version }) => version > previousVersion);
    if (pending.length === 0) {
      const health = assertDatabaseHealth(database);
      return {
        databasePath: resolvedDatabasePath,
        previousVersion,
        currentVersion: previousVersion,
        appliedVersions: [],
        backup: null,
        health,
      };
    }
    if (requireBackup && !resolvedBackupPath) {
      throw new IncrementalMigrationError(
        'backupPath is required before applying pending migrations',
      );
    }
    for (const migration of pending) {
      if (typeof migration.up !== 'function') {
        throw new IncrementalMigrationError(
          `Pending migration version ${migration.version} must define up(database)`,
        );
      }
    }

    let backup;
    try {
      backup = await beginProtectedChange({
        database,
        databasePath: resolvedDatabasePath,
        backupPath: resolvedBackupPath,
        requireBackup,
      });
      const insertMigration = database.prepare(`
        INSERT INTO _schema_migrations (version, name)
        VALUES (?, ?)
      `);
      for (const migration of pending) {
        migration.up(database);
        insertMigration.run(migration.version, migration.name);
      }
      const health = assertDatabaseHealth(database);
      database.exec('COMMIT');
      return {
        databasePath: resolvedDatabasePath,
        previousVersion,
        currentVersion: pending.at(-1).version,
        appliedVersions: pending.map(({ version }) => version),
        backup,
        health,
      };
    } catch (error) {
      rollbackOpenTransaction(database);
      if (error instanceof IncrementalMigrationError) throw error;
      throw new IncrementalMigrationError('Incremental migration failed', { cause: error });
    }
  } finally {
    database.close();
  }
}

export async function runIncrementalMigrations({ databasePath, backupPath = null, migrations }) {
  return applyIncrementalMigrations({
    databasePath,
    backupPath,
    migrations,
    requireBackup: true,
  });
}

export async function migrateTelecomTarget({
  databasePath,
  snapshotPath,
  backupPath = null,
  migrations = TELECOM_MIGRATIONS,
}) {
  validateMigrationDefinitions(migrations);
  const resolvedDatabasePath = resolve(databasePath);
  if (!(await databaseFileExists(resolvedDatabasePath))) {
    let createdDatabase = false;
    try {
      const createReport = await migrateTelecomDatabase({
        databasePath: resolvedDatabasePath,
        snapshotPath,
      });
      createdDatabase = true;
      const incrementalReport = await applyIncrementalMigrations({
        databasePath: resolvedDatabasePath,
        migrations,
        requireBackup: false,
      });
      return {
        mode: 'create',
        ...createReport,
        previousVersion: incrementalReport.previousVersion,
        currentVersion: incrementalReport.currentVersion,
        appliedVersions: incrementalReport.appliedVersions,
        backup: null,
        health: incrementalReport.health,
      };
    } catch (error) {
      if (createdDatabase) {
        await rm(resolvedDatabasePath, { force: true });
        await rm(`${resolvedDatabasePath}-wal`, { force: true });
        await rm(`${resolvedDatabasePath}-shm`, { force: true });
      }
      throw error;
    }
  }

  const report = await runIncrementalMigrations({
    databasePath: resolvedDatabasePath,
    backupPath,
    migrations,
  });
  return { mode: 'incremental', ...report };
}

export async function rollbackIncrementalMigrations({
  databasePath,
  backupPath = null,
  migrations,
  targetVersion,
}) {
  validateMigrationDefinitions(migrations);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new IncrementalMigrationError('targetVersion must be a positive integer');
  }

  const resolvedDatabasePath = resolve(databasePath);
  const resolvedBackupPath = backupPath ? resolve(backupPath) : null;
  await requireExistingDatabase(resolvedDatabasePath);

  const database = openSqliteDatabase(resolvedDatabasePath);
  try {
    const history = readAndValidateHistory(database, migrations);
    const previousVersion = history.at(-1).version;
    if (targetVersion > previousVersion) {
      throw new IncrementalMigrationError(
        `targetVersion ${targetVersion} exceeds current version ${previousVersion}`,
      );
    }
    const rollbackDefinitions = history
      .filter(({ version }) => version > targetVersion)
      .map(({ version }) => migrations[version - 1])
      .reverse();
    if (rollbackDefinitions.length === 0) {
      const health = assertDatabaseHealth(database);
      return {
        databasePath: resolvedDatabasePath,
        previousVersion,
        currentVersion: previousVersion,
        rolledBackVersions: [],
        backup: null,
        health,
      };
    }
    if (!resolvedBackupPath) {
      throw new IncrementalMigrationError(
        'backupPath is required before rolling back migrations',
      );
    }
    for (const migration of rollbackDefinitions) {
      if (typeof migration.down !== 'function') {
        throw new IncrementalMigrationError(
          `Migration version ${migration.version} must define down(database) for rollback`,
        );
      }
    }

    let backup;
    try {
      backup = await beginProtectedChange({
        database,
        databasePath: resolvedDatabasePath,
        backupPath: resolvedBackupPath,
      });
      const deleteMigration = database.prepare(`
        DELETE FROM _schema_migrations
        WHERE version = ? AND name = ?
      `);
      for (const migration of rollbackDefinitions) {
        migration.down(database);
        const result = deleteMigration.run(migration.version, migration.name);
        if (Number(result.changes) !== 1) {
          throw new IncrementalMigrationError(
            `Migration version ${migration.version} registry row was not removed`,
          );
        }
      }
      const health = assertDatabaseHealth(database);
      database.exec('COMMIT');
      return {
        databasePath: resolvedDatabasePath,
        previousVersion,
        currentVersion: targetVersion,
        rolledBackVersions: rollbackDefinitions.map(({ version }) => version),
        backup,
        health,
      };
    } catch (error) {
      rollbackOpenTransaction(database);
      if (error instanceof IncrementalMigrationError) throw error;
      throw new IncrementalMigrationError('Incremental rollback failed', { cause: error });
    }
  } finally {
    database.close();
  }
}
