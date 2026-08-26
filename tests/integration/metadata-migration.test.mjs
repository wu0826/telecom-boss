import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  MetadataMigrationError,
  migrateMetadataDatabase,
} from '../../src/server/db/metadata-migration.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'website_db.schema.json');
const EXPECTED_TABLES = [
  'dict_columns',
  'dict_databases',
  'dict_fk_selects',
  'dict_relations',
  'dict_systems',
  'dict_table_groups',
  'dict_table_subgroups',
  'dict_tables',
  'portal_minor',
  'products',
  'website_path',
  'work_tab_design',
];

function openForInspection(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function listApplicationTables(database) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT GLOB 'sqlite_*'
        AND substr(name, 1, 1) <> '_'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
}

function listIndexedLeadingColumns(database, tableName) {
  const columns = new Set();
  for (const index of database.prepare(`PRAGMA index_list('${tableName}')`).all()) {
    const [firstColumn] = database.prepare(`PRAGMA index_info('${index.name}')`).all();
    if (firstColumn?.name) columns.add(firstColumn.name);
  }
  return columns;
}

test('migrateMetadataDatabase creates the complete constrained metadata schema', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-metadata-'));
  const databasePath = join(temporaryDirectory, 'website_db.sqlite');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const report = await migrateMetadataDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });

  assert.equal(report.databaseName, 'website_db');
  assert.equal(report.referenceTableCount, 12);
  assert.equal(report.referenceColumnCount, 106);

  database = openForInspection(databasePath);

  assert.deepEqual(listApplicationTables(database), EXPECTED_TABLES);
  assert.deepEqual(
    database
      .prepare('SELECT version, name FROM _schema_migrations ORDER BY version')
      .all()
      .map(({ version, name }) => ({ version, name })),
    [{ version: 1, name: 'create_metadata_schema' }],
  );

  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  const tableNameById = new Map(snapshot.tables.map(({ id, en_name }) => [id, en_name]));
  const expectedColumnsByTable = Map.groupBy(
    snapshot.columns,
    ({ table_id }) => tableNameById.get(table_id),
  );

  for (const tableName of EXPECTED_TABLES) {
    const columns = database.prepare(`PRAGMA table_info('${tableName}')`).all();
    assert.ok(columns.some(({ pk }) => pk === 1), `${tableName} must have a primary key`);
    assert.deepEqual(
      columns.map(({ name }) => name),
      expectedColumnsByTable.get(tableName).map(({ en_name }) => en_name),
      `${tableName} columns must match the website_db snapshot`,
    );

    const indexedColumns = listIndexedLeadingColumns(database, tableName);
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list('${tableName}')`).all();
    for (const foreignKey of foreignKeys) {
      assert.ok(
        indexedColumns.has(foreignKey.from),
        `${tableName}.${foreignKey.from} must be the leading column of an index`,
      );
    }
  }

  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('metadata uniqueness prevents duplicate names within the same parent', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-metadata-unique-'));
  const databasePath = join(temporaryDirectory, 'website_db.sqlite');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await migrateMetadataDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');

  database.prepare(`
    INSERT INTO portal_minor (website_id, website_name, is_active, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(1, 'CSMU', 1, 1);
  database.prepare(`
    INSERT INTO dict_systems (sys_sr_id, website_id, en_name, zh_name, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, 1, 'dbedit', '資料庫編輯系統', 1);
  database.prepare(`
    INSERT INTO dict_databases (id, system_id, en_name, zh_name, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, 1, 'website_db', '資訊系統資料庫', 1);

  assert.throws(
    () => database.prepare(`
      INSERT INTO dict_databases (id, system_id, en_name, zh_name, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(2, 1, 'website_db', '重複資料庫', 2),
    /UNIQUE constraint failed/,
  );
});

test('metadata migration refuses overwrite unless an explicit backup path is provided', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-metadata-backup-'));
  const databasePath = join(temporaryDirectory, 'website_db.sqlite');
  const backupPath = join(temporaryDirectory, 'backups', 'website_db.before-remigrate.sqlite');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await migrateMetadataDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });

  await assert.rejects(
    () => migrateMetadataDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH }),
    (error) => error instanceof MetadataMigrationError && /backupPath/.test(error.message),
  );

  const secondReport = await migrateMetadataDatabase({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    backupPath,
  });

  await access(backupPath);
  assert.ok((await stat(backupPath)).size > 0);
  assert.equal(secondReport.backupPath, backupPath);

  database = openForInspection(databasePath);
  assert.deepEqual(listApplicationTables(database), EXPECTED_TABLES);
});
