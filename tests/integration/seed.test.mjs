import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateMetadataDatabase } from '../../src/server/db/metadata-migration.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';
import {
  DatabaseSeedError,
  seedMetadataDatabase,
  seedTelecomDatabase,
} from '../../src/server/db/seed.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const WEBSITE_SNAPSHOT_PATH = join(
  PROJECT_ROOT,
  'database',
  'snapshots',
  'website_db.schema.json',
);
const TELECOM_SNAPSHOT_PATH = join(
  PROJECT_ROOT,
  'database',
  'snapshots',
  'telecom_boss.schema.json',
);

async function createMigratedDatabases(directory) {
  const metadataDatabasePath = join(directory, 'website_db.sqlite');
  const telecomDatabasePath = join(directory, 'telecom_boss.sqlite');
  await migrateMetadataDatabase({
    databasePath: metadataDatabasePath,
    snapshotPath: WEBSITE_SNAPSHOT_PATH,
  });
  await migrateTelecomDatabase({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  return { metadataDatabasePath, telecomDatabasePath };
}

function telecomSampleCounts(database) {
  return Object.fromEntries([
    'roles',
    'permissions',
    'equipment_models',
    'service_plans',
    'plan_prices',
    'promotions',
    'promotion_plans',
  ].map((tableName) => [
    tableName,
    database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count,
  ]));
}

test('seed imports navigation metadata and telecom samples with scaled decimals', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-seed-'));
  const { metadataDatabasePath, telecomDatabasePath } = await createMigratedDatabases(
    temporaryDirectory,
  );
  let metadataDatabase;
  let telecomDatabase;
  t.after(async () => {
    metadataDatabase?.close();
    telecomDatabase?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const metadataReport = await seedMetadataDatabase({
    databasePath: metadataDatabasePath,
    websiteSnapshotPath: WEBSITE_SNAPSHOT_PATH,
    telecomSnapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  const telecomReport = await seedTelecomDatabase({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });

  assert.deepEqual(metadataReport, {
    moduleCount: 8,
    tableCount: 39,
    columnCount: 421,
    relationCount: 64,
    foreignKeySelectCount: 64,
  });
  assert.deepEqual(telecomReport, { sampleRowCount: 28, servicePlanCount: 3 });

  metadataDatabase = new DatabaseSync(metadataDatabasePath, { readOnly: true });
  telecomDatabase = new DatabaseSync(telecomDatabasePath, { readOnly: true });

  const telecomDatabaseRow = metadataDatabase
    .prepare('SELECT id, en_name, zh_name FROM dict_databases WHERE en_name = ?')
    .get('telecom_boss');
  assert.equal(telecomDatabaseRow.id, 2);
  assert.equal(telecomDatabaseRow.zh_name, '電信後台管理資料庫');
  assert.equal(
    metadataDatabase.prepare('SELECT zh_name FROM dict_systems WHERE sys_sr_id = 1').get().zh_name,
    '比奇堡電信商品官網',
  );
  assert.equal(
    metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_table_groups WHERE db_id = 2').get().count,
    8,
  );
  assert.equal(
    metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_tables WHERE db_id = 2').get().count,
    39,
  );
  assert.equal(
    metadataDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM dict_columns AS columns
      JOIN dict_tables AS tables ON tables.id = columns.table_id
      WHERE tables.db_id = 2
    `).get().count,
    421,
  );
  assert.equal(metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_relations').get().count, 64);
  assert.equal(metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_fk_selects').get().count, 64);

  assert.deepEqual(telecomSampleCounts(telecomDatabase), {
    roles: 5,
    permissions: 12,
    equipment_models: 1,
    service_plans: 3,
    plan_prices: 4,
    promotions: 1,
    promotion_plans: 2,
  });
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count, 5);
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM user_roles').get().count, 5);
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM role_permissions').get().count, 20);
  assert.deepEqual(
    telecomDatabase.prepare(`
      SELECT staff_no, email, auth_provider, provider_subject, is_active
      FROM staff_users
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { staff_no: 'DEV-ADMIN', email: 'admin@example.test', auth_provider: 'OTHER', provider_subject: 'dev:admin', is_active: 1 },
      { staff_no: 'DEV-CS', email: 'customer-service@example.test', auth_provider: 'OTHER', provider_subject: 'dev:customer-service', is_active: 1 },
      { staff_no: 'DEV-TECH', email: 'technician@example.test', auth_provider: 'OTHER', provider_subject: 'dev:technician', is_active: 1 },
      { staff_no: 'DEV-BILL', email: 'billing@example.test', auth_provider: 'OTHER', provider_subject: 'dev:billing', is_active: 1 },
      { staff_no: 'DEV-AUDIT', email: 'auditor@example.test', auth_provider: 'OTHER', provider_subject: 'dev:auditor', is_active: 1 },
    ],
  );
  assert.equal(
    telecomDatabase.prepare('SELECT amount FROM plan_prices WHERE id = 1').get().amount,
    28_800,
  );
  assert.equal(telecomDatabase.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('seeding twice is idempotent in both databases', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-seed-idempotent-'));
  const { metadataDatabasePath, telecomDatabasePath } = await createMigratedDatabases(
    temporaryDirectory,
  );
  let metadataDatabase;
  let telecomDatabase;
  t.after(async () => {
    metadataDatabase?.close();
    telecomDatabase?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  for (let iteration = 0; iteration < 2; iteration += 1) {
    await seedMetadataDatabase({
      databasePath: metadataDatabasePath,
      websiteSnapshotPath: WEBSITE_SNAPSHOT_PATH,
      telecomSnapshotPath: TELECOM_SNAPSHOT_PATH,
    });
    await seedTelecomDatabase({
      databasePath: telecomDatabasePath,
      snapshotPath: TELECOM_SNAPSHOT_PATH,
    });
  }

  metadataDatabase = new DatabaseSync(metadataDatabasePath, { readOnly: true });
  telecomDatabase = new DatabaseSync(telecomDatabasePath, { readOnly: true });
  assert.equal(metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_table_groups').get().count, 8);
  assert.equal(metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_tables').get().count, 39);
  assert.equal(metadataDatabase.prepare('SELECT COUNT(*) AS count FROM dict_columns').get().count, 421);
  assert.deepEqual(telecomSampleCounts(telecomDatabase), {
    roles: 5,
    permissions: 12,
    equipment_models: 1,
    service_plans: 3,
    plan_prices: 4,
    promotions: 1,
    promotion_plans: 2,
  });
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count, 5);
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM user_roles').get().count, 5);
  assert.equal(telecomDatabase.prepare('SELECT COUNT(*) AS count FROM role_permissions').get().count, 20);
});

test('invalid fixed-scale sample data aborts without partial writes', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-seed-invalid-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  const invalidSnapshotPath = join(temporaryDirectory, 'invalid.schema.json');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await migrateTelecomDatabase({ databasePath, snapshotPath: TELECOM_SNAPSHOT_PATH });
  const snapshot = JSON.parse(await readFile(TELECOM_SNAPSHOT_PATH, 'utf8'));
  const priceSample = snapshot.sample_data.find(({ table_id }) => table_id === 1014);
  priceSample.data.amount = '12.345';
  await writeFile(invalidSnapshotPath, JSON.stringify(snapshot), 'utf8');

  await assert.rejects(
    () => seedTelecomDatabase({ databasePath, snapshotPath: invalidSnapshotPath }),
    (error) => error instanceof DatabaseSeedError && /scale/.test(error.message),
  );

  database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM roles').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_plans').get().count, 0);
});
