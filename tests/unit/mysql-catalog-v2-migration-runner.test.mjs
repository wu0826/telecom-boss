import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyMysqlCatalogV2Migration,
  getMysqlCatalogV2Plan,
  MysqlCatalogMigrationError,
} from '../../src/server/db/mysql-catalog-v2-migration.mjs';

const CORE = ['staff_users', 'service_plans', 'stock_items', 'promotions'];
const TABLES = [
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
];
const TRIGGERS = [
  'trg_catalog_categories_insert_depth',
  'trg_catalog_categories_update_parent',
];

async function backupFile() {
  const dir = await mkdtemp(join(tmpdir(), 'telecom-mysql-migration-'));
  const path = join(dir, 'telecom_boss.sql');
  await writeFile(path, '-- verified test backup\n');
  return path;
}

class FakeMysqlConnection {
  constructor({ alreadyApplied = false, failOnCreate = null } = {}) {
    this.alreadyApplied = alreadyApplied;
    this.failOnCreate = failOnCreate;
    this.createdTables = new Set(alreadyApplied ? TABLES : []);
    this.createdTriggers = new Set(alreadyApplied ? TRIGGERS : []);
    this.history = alreadyApplied
      ? [
          { version: 1, name: 'create_telecom_schema' },
          { version: 2, name: 'create_catalog_v2_schema' },
        ]
      : [{ version: 1, name: 'create_telecom_schema' }];
    this.cleanupDrops = 0;
  }

  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/SELECT GET_LOCK/i.test(normalized)) return [[{ acquired: 1 }], []];
    if (/SELECT RELEASE_LOCK/i.test(normalized)) return [[{ released: 1 }], []];

    if (/information_schema\.tables/i.test(normalized) && /'_schema_migrations'/i.test(normalized)) {
      return [[{ count: 1 }], []];
    }
    if (/SELECT version, name FROM _schema_migrations/i.test(normalized)) {
      return [this.history.map((row) => ({ ...row })), []];
    }

    if (/information_schema\.columns/i.test(normalized)) {
      return [CORE.map((table_name) => ({ table_name, data_type: 'bigint', column_type: 'bigint' })), []];
    }

    if (/information_schema\.tables/i.test(normalized) && /table_name IN/i.test(normalized)) {
      if (values.length === CORE.length && values.every((value) => CORE.includes(value))) {
        return [CORE.map((table_name) => ({ table_name })), []];
      }
      return [[...this.createdTables].sort().map((table_name) => ({ table_name })), []];
    }

    if (/information_schema\.triggers/i.test(normalized)) {
      return [[...this.createdTriggers].sort().map((trigger_name) => ({ trigger_name })), []];
    }

    const createTable = /CREATE TABLE\s+([a-z0-9_]+)/i.exec(normalized);
    if (createTable) {
      if (this.failOnCreate === createTable[1]) throw new Error(`simulated failure ${createTable[1]}`);
      this.createdTables.add(createTable[1]);
      return [{ affectedRows: 0 }, []];
    }
    const createTrigger = /CREATE TRIGGER\s+([a-z0-9_]+)/i.exec(normalized);
    if (createTrigger) {
      this.createdTriggers.add(createTrigger[1]);
      return [{ affectedRows: 0 }, []];
    }
    const dropTable = /DROP TABLE IF EXISTS\s+([a-z0-9_]+)/i.exec(normalized);
    if (dropTable) {
      this.createdTables.delete(dropTable[1]);
      this.cleanupDrops += 1;
      return [{ affectedRows: 0 }, []];
    }
    const dropTrigger = /DROP TRIGGER IF EXISTS\s+([a-z0-9_]+)/i.exec(normalized);
    if (dropTrigger) {
      this.createdTriggers.delete(dropTrigger[1]);
      return [{ affectedRows: 0 }, []];
    }
    if (/CREATE UNIQUE INDEX/i.test(normalized)) return [{ affectedRows: 0 }, []];

    if (/INSERT INTO _schema_migrations/i.test(normalized)) {
      this.history.push({ version: Number(values[0]), name: values[1] });
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`Unexpected fake query: ${normalized.slice(0, 180)}`);
  }
}

test('MySQL Catalog V2 dry plan exposes v2 and all ten tables', async () => {
  const plan = await getMysqlCatalogV2Plan();
  assert.deepEqual(plan.migration, { version: 2, name: 'create_catalog_v2_schema' });
  assert.deepEqual(plan.createsTables, TABLES);
  assert.equal(plan.up.statementCount, 15);
  assert.equal(plan.down.statementCount, 12);
});

test('MySQL Catalog V2 migration is idempotent when v2 is already registered', async () => {
  const connection = new FakeMysqlConnection({ alreadyApplied: true });
  const report = await applyMysqlCatalogV2Migration({
    connection,
    migrationUser: 'intern_migrate',
    backupPath: null,
  });
  assert.equal(report.status, 'already-applied');
  assert.equal(connection.history.length, 2);
});

test('MySQL Catalog V2 migration registers v2 only after all schema objects verify', async () => {
  const connection = new FakeMysqlConnection();
  const report = await applyMysqlCatalogV2Migration({
    connection,
    migrationUser: 'intern_migrate',
    backupPath: await backupFile(),
  });
  assert.equal(report.status, 'applied');
  assert.equal(connection.createdTables.size, 10);
  assert.equal(connection.createdTriggers.size, 2);
  assert.deepEqual(connection.history.at(-1), { version: 2, name: 'create_catalog_v2_schema' });
});

test('MySQL Catalog V2 failed DDL performs compensating cleanup before v2 is registered', async () => {
  const connection = new FakeMysqlConnection({ failOnCreate: 'catalog_product_content' });
  await assert.rejects(
    applyMysqlCatalogV2Migration({
      connection,
      migrationUser: 'intern_migrate',
      backupPath: await backupFile(),
    }),
    (error) => {
      assert.ok(error instanceof MysqlCatalogMigrationError);
      assert.match(error.message, /compensating rollback/);
      return true;
    },
  );
  assert.equal(connection.createdTables.size, 0);
  assert.equal(connection.createdTriggers.size, 0);
  assert.equal(connection.history.length, 1);
  assert.ok(connection.cleanupDrops > 0);
});

test('MySQL Catalog V2 migration refuses the runtime intern account', async () => {
  const connection = new FakeMysqlConnection();
  await assert.rejects(
    applyMysqlCatalogV2Migration({
      connection,
      migrationUser: 'intern',
      backupPath: await backupFile(),
    }),
    /DB_USER is exactly intern_migrate/,
  );
});
