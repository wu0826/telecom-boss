import { DatabaseSync } from 'node:sqlite';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export function openSqliteDatabase(databasePath, { readOnly = false } = {}) {
  const database = new DatabaseSync(databasePath, { readOnly });
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

export function runInTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');

  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function resolveDistinctDatabasePaths(databasePath, backupPath) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedBackupPath = resolve(backupPath);
  if (resolvedDatabasePath === resolvedBackupPath) {
    throw new Error('backupPath must differ from databasePath');
  }
  return { resolvedDatabasePath, resolvedBackupPath };
}

export async function createVerifiedDatabaseBackup({ databasePath, backupPath }) {
  if (!backupPath) throw new Error('backupPath is required before changing an existing database');
  const { resolvedDatabasePath, resolvedBackupPath } = resolveDistinctDatabasePaths(
    databasePath,
    backupPath,
  );

  const sourceStat = await stat(resolvedDatabasePath);
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Database backup source must be a non-empty file: ${resolvedDatabasePath}`);
  }

  await mkdir(dirname(resolvedBackupPath), { recursive: true });
  await copyFile(resolvedDatabasePath, resolvedBackupPath, constants.COPYFILE_EXCL);

  try {
    const backupStat = await stat(resolvedBackupPath);
    const [sourceSha256, backupSha256] = await Promise.all([
      sha256File(resolvedDatabasePath),
      sha256File(resolvedBackupPath),
    ]);
    if (backupStat.size !== sourceStat.size || backupSha256 !== sourceSha256) {
      throw new Error('Database backup verification failed');
    }
    return {
      path: resolvedBackupPath,
      size: backupStat.size,
      sha256: backupSha256,
    };
  } catch (error) {
    await rm(resolvedBackupPath, { force: true });
    throw error;
  }
}

export async function restoreDatabaseBackup({ databasePath, backupPath }) {
  const { resolvedDatabasePath, resolvedBackupPath } = resolveDistinctDatabasePaths(
    databasePath,
    backupPath,
  );
  const backupStat = await stat(resolvedBackupPath);
  if (!backupStat.isFile() || backupStat.size === 0) {
    throw new Error(`Database backup must be a non-empty file: ${resolvedBackupPath}`);
  }
  const backupSha256 = await sha256File(resolvedBackupPath);

  await mkdir(dirname(resolvedDatabasePath), { recursive: true });
  await rm(`${resolvedDatabasePath}-wal`, { force: true });
  await rm(`${resolvedDatabasePath}-shm`, { force: true });
  await copyFile(resolvedBackupPath, resolvedDatabasePath);

  const restoredSha256 = await sha256File(resolvedDatabasePath);
  if (restoredSha256 !== backupSha256) {
    throw new Error('Restored database verification failed');
  }
  return {
    databasePath: resolvedDatabasePath,
    backupPath: resolvedBackupPath,
    size: backupStat.size,
    sha256: restoredSha256,
  };
}

export async function prepareDatabaseTarget({ databasePath, backupPath, databaseLabel }) {
  if (!(await fileExists(databasePath))) return null;
  if (!backupPath) {
    throw new Error(
      `Refusing to overwrite existing ${databaseLabel} database without backupPath: ${databasePath}`,
    );
  }
  if (resolve(databasePath) === resolve(backupPath)) {
    throw new Error('backupPath must differ from databasePath');
  }

  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(databasePath, backupPath, constants.COPYFILE_EXCL);

  for (const suffix of ['-wal', '-shm']) {
    const sourceSidecar = `${databasePath}${suffix}`;
    if (await fileExists(sourceSidecar)) {
      await copyFile(sourceSidecar, `${backupPath}${suffix}`, constants.COPYFILE_EXCL);
    }
  }

  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  return backupPath;
}
