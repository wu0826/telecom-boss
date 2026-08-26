import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { compileTelecomSchema } from './schema-compiler.mjs';
import { openSqliteDatabase, prepareDatabaseTarget, runInTransaction } from './sqlite.mjs';

export class TelecomMigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TelecomMigrationError';
  }
}

async function readSnapshot(snapshotPath) {
  try {
    return JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch (error) {
    throw new TelecomMigrationError(`Unable to read telecom snapshot: ${snapshotPath}`, {
      cause: error,
    });
  }
}

export async function migrateTelecomDatabase({ databasePath, snapshotPath, backupPath = null }) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedSnapshotPath = resolve(snapshotPath);
  const resolvedBackupPath = backupPath ? resolve(backupPath) : null;

  if (!resolvedDatabasePath.endsWith('.sqlite')) {
    throw new TelecomMigrationError('databasePath must end with .sqlite');
  }

  const snapshot = await readSnapshot(resolvedSnapshotPath);
  let compilation;
  try {
    compilation = compileTelecomSchema(snapshot);
  } catch (error) {
    throw new TelecomMigrationError(`Telecom schema compilation failed: ${error.message}`, {
      cause: error,
    });
  }

  let createdBackup;
  try {
    createdBackup = await prepareDatabaseTarget({
      databasePath: resolvedDatabasePath,
      backupPath: resolvedBackupPath,
      databaseLabel: 'telecom',
    });
  } catch (error) {
    if (error instanceof TelecomMigrationError) throw error;
    throw new TelecomMigrationError(error.message, { cause: error });
  }

  await mkdir(dirname(resolvedDatabasePath), { recursive: true });

  let database;
  try {
    database = openSqliteDatabase(resolvedDatabasePath);
    database.exec('PRAGMA journal_mode = WAL');
    runInTransaction(database, () => {
      database.exec(compilation.schemaSql);
      database.prepare(`
        INSERT INTO _schema_migrations (version, name)
        VALUES (?, ?)
      `).run(1, 'create_telecom_schema');
    });
  } catch (error) {
    throw new TelecomMigrationError('Telecom database migration failed', { cause: error });
  } finally {
    database?.close();
  }

  return {
    databaseName: snapshot.database.en_name,
    databasePath: resolvedDatabasePath,
    backupPath: createdBackup,
    tableCount: compilation.tableCount,
    columnCount: compilation.columnCount,
    relationCount: compilation.relationCount,
    decimalScaleByColumn: compilation.decimalScaleByColumn,
  };
}
