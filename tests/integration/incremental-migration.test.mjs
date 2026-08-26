import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  IncrementalMigrationError,
  migrateTelecomTarget,
  rollbackIncrementalMigrations,
  runIncrementalMigrations,
} from '../../src/server/db/migration-runner.mjs';
import { restoreDatabaseBackup } from '../../src/server/db/sqlite.mjs';
import { seedTelecomDatabase } from '../../src/server/db/seed.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');

const BASE_MIGRATION = Object.freeze({
  version: 1,
  name: 'create_telecom_schema',
});

function createProbeMigration(version = 2, name = 'add_migration_probe') {
  return {
    version,
    name,
    up(database) {
      database.exec(`
        CREATE TABLE migration_probe (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `);
      database.prepare('INSERT INTO migration_probe (id, value) VALUES (?, ?)')
        .run(1, 'applied-once');
    },
    down(database) {
      database.exec('DROP TABLE migration_probe');
    },
  };
}

function createProbeDetailMigration() {
  return {
    version: 3,
    name: 'add_migration_probe_detail',
    up(database) {
      database.exec(`
        CREATE TABLE migration_probe_detail (
          id INTEGER PRIMARY KEY,
          probe_id INTEGER NOT NULL,
          note TEXT NOT NULL,
          FOREIGN KEY (probe_id) REFERENCES migration_probe(id) ON DELETE RESTRICT
        ) STRICT
      `);
      database.prepare(`
        INSERT INTO migration_probe_detail (id, probe_id, note)
        VALUES (?, ?, ?)
      `).run(1, 1, 'dependent-row');
    },
    down(database) {
      database.exec('DROP TABLE migration_probe_detail');
    },
  };
}

async function createSeededDatabase(t, prefix) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  await seedTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  return { temporaryDirectory, databasePath };
}

function inspectDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA foreign_keys = ON');
  try {
    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT GLOB 'sqlite_*'
        AND substr(name, 1, 1) <> '_'
      ORDER BY name
    `).all().map(({ name }) => name);
    const rowCounts = Object.fromEntries(tables.map((tableName) => [
      tableName,
      Number(database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count),
    ]));
    const versions = database.prepare(`
      SELECT version, name
      FROM _schema_migrations
      ORDER BY version
    `).all().map(({ version, name }) => ({ version, name }));
    const integrity = database.prepare('PRAGMA integrity_check').all()
      .map((row) => Object.values(row).at(0));
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    return { tables, rowCounts, versions, integrity, foreignKeyErrors };
  } finally {
    database.close();
  }
}

test('incremental migrations require a verified backup, apply once, and then become a no-op', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    t,
    'telecom-incremental-apply-',
  );
  const backupPath = join(temporaryDirectory, 'backups', 'before-v2.sqlite');
  const migrations = [BASE_MIGRATION, createProbeMigration()];
  const originalBytes = await readFile(databasePath);

  await assert.rejects(
    () => runIncrementalMigrations({ databasePath, migrations }),
    (error) => error instanceof IncrementalMigrationError && /backupPath/.test(error.message),
  );
  assert.deepEqual(await readFile(databasePath), originalBytes);

  const report = await runIncrementalMigrations({ databasePath, backupPath, migrations });
  assert.deepEqual(report.appliedVersions, [2]);
  assert.equal(report.previousVersion, 1);
  assert.equal(report.currentVersion, 2);
  assert.equal(report.backup.path, backupPath);
  assert.deepEqual(await readFile(backupPath), originalBytes);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM migration_probe').get().count, 1);
  assert.deepEqual(
    database.prepare('SELECT version, name FROM _schema_migrations ORDER BY version').all()
      .map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: 'create_telecom_schema' },
      { version: 2, name: 'add_migration_probe' },
    ],
  );
  database.close();

  const secondReport = await runIncrementalMigrations({ databasePath, migrations });
  assert.deepEqual(secondReport.appliedVersions, []);
  assert.equal(secondReport.previousVersion, 2);
  assert.equal(secondReport.currentVersion, 2);
  assert.equal(secondReport.backup, null);
});

test('incremental migrations reject duplicate, missing, and out-of-order definitions before mutation', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    t,
    'telecom-incremental-invalid-',
  );
  const originalBytes = await readFile(databasePath);
  const invalidSets = [
    {
      migrations: [BASE_MIGRATION, createProbeMigration(1, 'duplicate_version')],
      pattern: /duplicate migration version/,
    },
    {
      migrations: [BASE_MIGRATION, createProbeMigration(2, 'create_telecom_schema')],
      pattern: /duplicate migration name/,
    },
    {
      migrations: [BASE_MIGRATION, createProbeMigration(3, 'missing_version_two')],
      pattern: /missing migration version 2/,
    },
    {
      migrations: [
        BASE_MIGRATION,
        createProbeMigration(3, 'third_before_second'),
        createProbeMigration(2, 'second_after_third'),
      ],
      pattern: /strictly ordered/,
    },
  ];

  for (const [index, invalidSet] of invalidSets.entries()) {
    const backupPath = join(temporaryDirectory, `invalid-${index}.sqlite`);
    await assert.rejects(
      () => runIncrementalMigrations({
        databasePath,
        backupPath,
        migrations: invalidSet.migrations,
      }),
      (error) => error instanceof IncrementalMigrationError
        && invalidSet.pattern.test(error.message),
    );
    await assert.rejects(() => stat(backupPath), { code: 'ENOENT' });
  }

  assert.deepEqual(await readFile(databasePath), originalBytes);
  assert.deepEqual(inspectDatabase(databasePath).versions, [
    { version: 1, name: 'create_telecom_schema' },
  ]);
});

test('a failed migration rolls back and its verified backup can restore the exact source bytes', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    t,
    'telecom-incremental-failure-',
  );
  const backupPath = join(temporaryDirectory, 'backups', 'before-failure.sqlite');
  const originalState = inspectDatabase(databasePath);
  const originalBytes = await readFile(databasePath);
  const failingMigration = {
    version: 3,
    name: 'fail_after_probe',
    up() {
      throw new Error('intentional migration failure');
    },
    down() {},
  };

  await assert.rejects(
    () => runIncrementalMigrations({
      databasePath,
      backupPath,
      migrations: [BASE_MIGRATION, createProbeMigration(), failingMigration],
    }),
    (error) => error instanceof IncrementalMigrationError
      && /intentional migration failure/.test(error.cause?.message),
  );

  const failedState = inspectDatabase(databasePath);
  assert.deepEqual(failedState, originalState);
  assert.deepEqual(await readFile(backupPath), originalBytes);

  await writeFile(databasePath, 'intentionally damaged test copy', 'utf8');
  const restoreReport = await restoreDatabaseBackup({ databasePath, backupPath });
  assert.equal(restoreReport.databasePath, databasePath);
  assert.equal(restoreReport.backupPath, backupPath);
  assert.deepEqual(await readFile(databasePath), originalBytes);
  assert.deepEqual(inspectDatabase(databasePath), originalState);
});

test('rollback migrations restore schema version, table row counts, foreign keys, and integrity', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    t,
    'telecom-incremental-rollback-',
  );
  const beforeApplyPath = join(temporaryDirectory, 'backups', 'before-apply.sqlite');
  const beforeRollbackPath = join(temporaryDirectory, 'backups', 'before-rollback.sqlite');
  const originalState = inspectDatabase(databasePath);
  const migrations = [
    BASE_MIGRATION,
    createProbeMigration(),
    createProbeDetailMigration(),
  ];

  await runIncrementalMigrations({
    databasePath,
    backupPath: beforeApplyPath,
    migrations,
  });
  const appliedState = inspectDatabase(databasePath);
  assert.deepEqual(appliedState.versions.map(({ version }) => version), [1, 2, 3]);
  assert.equal(appliedState.foreignKeyErrors.length, 0);

  const report = await rollbackIncrementalMigrations({
    databasePath,
    backupPath: beforeRollbackPath,
    migrations,
    targetVersion: 1,
  });
  assert.deepEqual(report.rolledBackVersions, [3, 2]);
  assert.equal(report.previousVersion, 3);
  assert.equal(report.currentVersion, 1);
  assert.ok(report.backup.sha256);

  const rolledBackState = inspectDatabase(databasePath);
  assert.deepEqual(rolledBackState, originalState);
  assert.deepEqual(rolledBackState.integrity, ['ok']);
  assert.equal(rolledBackState.foreignKeyErrors.length, 0);
});

test('telecom migration target creates a missing database and never rebuilds an existing one', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-migration-target-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  const backupPath = join(temporaryDirectory, 'backups', 'before-v2.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const createReport = await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    migrations: [BASE_MIGRATION],
  });
  assert.equal(createReport.mode, 'create');
  assert.equal(createReport.tableCount, 39);

  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO service_plans (
      id, plan_code, plan_name, service_category, technology, contract_months,
      wifi_included, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(999, 'PRESERVE-ME', 'Preserved plan', 'BROADBAND', 'FTTH', 12, 0, 1);
  database.close();

  const noOpReport = await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    migrations: [BASE_MIGRATION],
  });
  assert.equal(noOpReport.mode, 'incremental');
  assert.deepEqual(noOpReport.appliedVersions, []);
  assert.equal(noOpReport.backup, null);

  const incrementalReport = await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    backupPath,
    migrations: [BASE_MIGRATION, createProbeMigration()],
  });
  assert.equal(incrementalReport.mode, 'incremental');
  assert.deepEqual(incrementalReport.appliedVersions, [2]);

  const verifiedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    verifiedDatabase.prepare('SELECT plan_name FROM service_plans WHERE id = ?').get(999).plan_name,
    'Preserved plan',
  );
  verifiedDatabase.close();
});
