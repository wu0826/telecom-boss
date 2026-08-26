import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CATALOG_V2_MIGRATION } from '../../src/server/db/catalog-v2-migration.mjs';
import {
  migrateTelecomTarget,
  rollbackIncrementalMigrations,
  runIncrementalMigrations,
  TELECOM_MIGRATIONS,
} from '../../src/server/db/migration-runner.mjs';
import { seedTelecomDatabase } from '../../src/server/db/seed.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');
const CATALOG_TABLES = [
  'catalog_brands',
  'catalog_categories',
  'catalog_product_brands',
  'catalog_product_categories',
  'catalog_product_content',
  'catalog_product_media',
  'catalog_product_sections',
  'catalog_product_specs',
  'catalog_products',
  'catalog_promotion_products',
];
const EXPECTED_COLUMNS = {
  catalog_categories: [
    'id', 'parent_id', 'category_code', 'slug', 'category_name', 'description',
    'sort_order', 'is_active', 'created_by_staff_user_id', 'updated_by_staff_user_id',
    'created_at', 'updated_at', 'row_version',
  ],
  catalog_products: [
    'id', 'product_code', 'slug', 'product_name', 'product_type', 'service_plan_id',
    'stock_item_id', 'status', 'sort_order', 'is_featured', 'publish_from',
    'publish_until', 'created_by_staff_user_id', 'updated_by_staff_user_id',
    'created_at', 'updated_at', 'row_version',
  ],
  catalog_product_categories: [
    'product_id', 'category_id', 'is_primary', 'sort_order', 'created_at',
  ],
  catalog_product_content: [
    'id', 'product_id', 'locale', 'title', 'summary', 'body_text', 'seo_title',
    'seo_description', 'created_at', 'updated_at', 'row_version',
  ],
  catalog_product_sections: [
    'id', 'product_id', 'locale', 'section_key', 'section_type', 'title',
    'body_text', 'sort_order', 'is_active', 'created_at', 'updated_at', 'row_version',
  ],
  catalog_product_media: [
    'id', 'product_id', 'media_type', 'media_usage', 'url', 'alt_text',
    'is_primary', 'sort_order', 'created_at', 'updated_at', 'row_version',
  ],
  catalog_product_specs: [
    'id', 'product_id', 'locale', 'spec_key', 'group_key', 'group_label',
    'spec_label', 'spec_value', 'unit', 'sort_order', 'created_at', 'updated_at',
    'row_version',
  ],
  catalog_brands: [
    'id', 'brand_code', 'slug', 'brand_name', 'description', 'website_url',
    'logo_url', 'sort_order', 'is_active', 'created_at', 'updated_at', 'row_version',
  ],
  catalog_product_brands: [
    'product_id', 'brand_id', 'is_primary', 'sort_order', 'created_at',
  ],
  catalog_promotion_products: [
    'promotion_id', 'product_id', 'created_at',
  ],
};

async function createSeededDatabase(prefix) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  await seedTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  return { temporaryDirectory, databasePath };
}

function openDatabase(databasePath, options = {}) {
  const database = new DatabaseSync(databasePath, options);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function applicationTables(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT GLOB 'sqlite_*'
      AND substr(name, 1, 1) <> '_'
    ORDER BY name
  `).all().map(({ name }) => name);
}

function inspectTables(database, tables) {
  return Object.fromEntries(tables.map((tableName) => [
    tableName,
    {
      sql: database.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(tableName).sql,
      rowCount: Number(
        database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
      ),
    },
  ]));
}

function indexNames(database, tableName) {
  return new Set(database.prepare(`PRAGMA index_list('${tableName}')`).all()
    .map(({ name }) => name));
}

function referencedTables(database, tableName) {
  return new Set(database.prepare(`PRAGMA foreign_key_list('${tableName}')`).all()
    .map(({ table }) => table));
}

async function applyCatalogMigration(databasePath, backupPath) {
  return runIncrementalMigrations({
    databasePath,
    backupPath,
    migrations: [
      { version: 1, name: 'create_telecom_schema' },
      CATALOG_V2_MIGRATION,
    ],
  });
}

test('Catalog V2 migration adds exactly ten strict normalized tables without changing legacy data', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    'telecom-catalog-v2-schema-',
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const backupPath = join(temporaryDirectory, 'backups', 'before-catalog-v2.sqlite');
  let database = openDatabase(databasePath, { readOnly: true });
  const legacyTables = applicationTables(database);
  const legacyState = inspectTables(database, legacyTables);
  database.close();

  const report = await applyCatalogMigration(databasePath, backupPath);
  assert.deepEqual(report.appliedVersions, [2]);
  assert.equal(report.previousVersion, 1);
  assert.equal(report.currentVersion, 2);
  assert.equal(report.health.integrity, 'ok');
  assert.equal(report.health.foreignKeyErrorCount, 0);

  database = openDatabase(databasePath, { readOnly: true });
  const migratedTables = applicationTables(database);
  assert.deepEqual(
    migratedTables.filter((tableName) => !legacyTables.includes(tableName)),
    CATALOG_TABLES,
  );
  assert.deepEqual(inspectTables(database, legacyTables), legacyState);

  for (const tableName of CATALOG_TABLES) {
    const tableMetadata = database.prepare('PRAGMA table_list').all()
      .find(({ name }) => name === tableName);
    assert.equal(tableMetadata.strict, 1, `${tableName} must be STRICT`);
    assert.deepEqual(
      database.prepare(`PRAGMA table_info('${tableName}')`).all().map(({ name }) => name),
      EXPECTED_COLUMNS[tableName],
      `${tableName} columns`,
    );
  }

  assert.deepEqual(referencedTables(database, 'catalog_categories'), new Set([
    'catalog_categories',
    'staff_users',
  ]));
  assert.deepEqual(referencedTables(database, 'catalog_products'), new Set([
    'service_plans',
    'staff_users',
    'stock_items',
  ]));
  assert.deepEqual(referencedTables(database, 'catalog_product_categories'), new Set([
    'catalog_categories',
    'catalog_products',
  ]));
  assert.deepEqual(referencedTables(database, 'catalog_product_sections'), new Set([
    'catalog_product_content',
  ]));
  assert.deepEqual(referencedTables(database, 'catalog_product_specs'), new Set([
    'catalog_product_content',
  ]));
  assert.deepEqual(referencedTables(database, 'catalog_promotion_products'), new Set([
    'catalog_products',
    'promotions',
  ]));

  assert.ok(indexNames(database, 'catalog_categories')
    .has('idx_catalog_categories_parent_sort'));
  assert.ok(indexNames(database, 'catalog_products')
    .has('idx_catalog_products_publication'));
  assert.ok(indexNames(database, 'catalog_product_categories')
    .has('uq_catalog_product_categories_primary'));
  assert.ok(indexNames(database, 'catalog_product_media')
    .has('uq_catalog_product_media_primary'));
  assert.ok(indexNames(database, 'catalog_product_specs')
    .has('idx_catalog_product_specs_group_sort'));
  assert.ok(indexNames(database, 'catalog_product_brands')
    .has('idx_catalog_product_brands_brand'));
  assert.ok(indexNames(database, 'catalog_promotion_products')
    .has('idx_catalog_promotion_products_product'));

  assert.deepEqual(
    database.prepare('SELECT version, name FROM _schema_migrations ORDER BY version').all()
      .map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: 'create_telecom_schema' },
      { version: 2, name: 'create_catalog_v2_schema' },
    ],
  );
  assert.deepEqual(
    database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row).at(0)),
    ['ok'],
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

test('Catalog V2 constraints enforce hierarchy, source, publishing, content, media, and primary invariants', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    'telecom-catalog-v2-constraints-',
  );
  await applyCatalogMigration(
    databasePath,
    join(temporaryDirectory, 'backups', 'before-catalog-v2.sqlite'),
  );
  const database = openDatabase(databasePath);
  t.after(async () => {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const insertCategory = database.prepare(`
    INSERT INTO catalog_categories (
      id, parent_id, category_code, slug, category_name, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertCategory.run(1, null, 'SERVICES', 'services', '服務', 10);
  insertCategory.run(2, 1, 'BROADBAND', 'broadband', '寬頻', 10);
  insertCategory.run(3, 2, 'FIBER', 'fiber', '光纖', 10);
  insertCategory.run(4, 3, 'HOME', 'home-fiber', '家用光纖', 10);
  assert.throws(
    () => insertCategory.run(5, 4, 'TOO-DEEP', 'too-deep', '第五層', 10),
    /maximum depth is 4/,
  );
  assert.throws(
    () => database.prepare('UPDATE catalog_categories SET parent_id = ? WHERE id = ?').run(2, 1),
    /category cycle/,
  );
  assert.throws(
    () => insertCategory.run(6, null, 'SERVICES', 'other-services', '重複代碼', 20),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insertCategory.run(7, null, 'UNIQUE-CODE', 'services', '重複網址', 20),
    /UNIQUE constraint failed/,
  );
  insertCategory.run(10, null, 'SECOND-ROOT', 'second-root', '第二根分類', 20);
  insertCategory.run(11, 10, 'SECOND-CHILD', 'second-child', '第二層分類', 10);
  assert.throws(
    () => database.prepare('UPDATE catalog_categories SET parent_id = ? WHERE id = ?').run(11, 2),
    /maximum depth is 4/,
  );

  database.prepare(`
    INSERT OR IGNORE INTO stock_items (
      id, sku, item_name, item_type, unit, standard_cost, selling_price,
      reorder_level, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'CATALOG-TEST-A6', 'Archer A6', 'EQUIPMENT', 'PCS', 100000, 150000, 1, 1);

  const insertProduct = database.prepare(`
    INSERT INTO catalog_products (
      id, product_code, slug, product_name, product_type, service_plan_id,
      stock_item_id, status, publish_from, publish_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProduct.run(
    1, 'PLAN-100M', 'plan-100m', '100M 方案', 'SERVICE_PLAN', 1, null,
    'DRAFT', null, null,
  );
  insertProduct.run(
    2, 'ROUTER-A6', 'router-a6', 'Archer A6', 'STOCK_ITEM', null, 1,
    'PUBLISHED', '2026-07-01T00:00:00.000Z', null,
  );
  insertProduct.run(
    3, 'GENERAL-INFO', 'general-info', '服務說明', 'GENERAL', null, null,
    'SCHEDULED', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
  );
  assert.throws(
    () => insertProduct.run(
      4, 'DUP-PLAN', 'dup-plan', '重複方案', 'SERVICE_PLAN', 1, null,
      'DRAFT', null, null,
    ),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insertProduct.run(
      5, 'MIXED-SOURCE', 'mixed-source', '錯誤來源', 'SERVICE_PLAN', 2, 1,
      'DRAFT', null, null,
    ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertProduct.run(
      6, 'NO-SCHEDULE', 'no-schedule', '缺少時間', 'GENERAL', null, null,
      'SCHEDULED', null, null,
    ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertProduct.run(
      7, 'BAD-WINDOW', 'bad-window', '錯誤期間', 'GENERAL', null, null,
      'PUBLISHED', '2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
    ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertProduct.run(
      8, 'BAD-STATUS', 'bad-status', '錯誤狀態', 'GENERAL', null, null,
      'LIVE', null, null,
    ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertProduct.run(
      9, 'BAD-DATE', 'bad-date', '不存在日期', 'GENERAL', null, null,
      'SCHEDULED', '2026-13-40T00:00:00.000Z', null,
    ),
    /CHECK constraint failed/,
  );

  const insertProductCategory = database.prepare(`
    INSERT INTO catalog_product_categories (
      product_id, category_id, is_primary, sort_order
    ) VALUES (?, ?, ?, ?)
  `);
  insertProductCategory.run(1, 1, 1, 10);
  assert.throws(
    () => insertProductCategory.run(1, 2, 1, 20),
    /UNIQUE constraint failed/,
  );

  const insertContent = database.prepare(`
    INSERT INTO catalog_product_content (
      product_id, locale, title, summary, body_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  insertContent.run(1, 'zh-TW', '100M 方案', '適合一般家庭', '純文字商品說明');
  assert.throws(
    () => insertContent.run(1, 'zh-TW', '重複內容', null, null),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO catalog_product_sections (
        product_id, locale, section_key, section_type, title, body_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 'en-US', 'overview', 'TEXT', 'Overview', 'Missing locale content'),
    /FOREIGN KEY constraint failed/,
  );

  const insertMedia = database.prepare(`
    INSERT INTO catalog_product_media (
      product_id, media_type, media_usage, url, alt_text, is_primary, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertMedia.run(1, 'IMAGE', 'PRIMARY', '/assets/products/100m.webp', '100M 方案', 1, 10);
  assert.throws(
    () => insertMedia.run(1, 'IMAGE', 'GALLERY', 'javascript:alert(1)', '錯誤圖片', 0, 20),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertMedia.run(
      1, 'IMAGE', 'PRIMARY', 'https://cdn.example.test/second.webp', '第二主圖', 1, 30,
    ),
    /UNIQUE constraint failed/,
  );

  const insertSpec = database.prepare(`
    INSERT INTO catalog_product_specs (
      product_id, locale, spec_key, group_key, group_label, spec_label, spec_value, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSpec.run(1, 'zh-TW', 'download-speed', 'network', '網路', '下載速度', '100 Mbps', 10);
  assert.throws(
    () => insertSpec.run(
      1, 'zh-TW', 'download-speed', 'network', '網路', '下載速度', '重複', 20,
    ),
    /UNIQUE constraint failed/,
  );

  database.prepare(`
    INSERT INTO catalog_brands (
      id, brand_code, slug, brand_name, website_url, logo_url
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 'TP-LINK', 'tp-link', 'TP-Link', 'https://www.tp-link.com/', '/assets/tp-link.svg');
  assert.throws(
    () => database.prepare(`
      INSERT INTO catalog_brands (brand_code, slug, brand_name)
      VALUES (?, ?, ?)
    `).run('TP-LINK', 'other-brand', '重複品牌'),
    /UNIQUE constraint failed/,
  );
  database.prepare(`
    INSERT INTO catalog_product_brands (
      product_id, brand_id, is_primary, sort_order
    ) VALUES (?, ?, ?, ?)
  `).run(2, 1, 1, 10);
  database.prepare(`
    INSERT INTO catalog_promotion_products (promotion_id, product_id)
    VALUES (?, ?)
  `).run(1, 1);
  assert.throws(
    () => database.prepare(`
      INSERT INTO catalog_promotion_products (promotion_id, product_id)
      VALUES (?, ?)
    `).run(999, 1),
    /FOREIGN KEY constraint failed/,
  );

  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.deepEqual(
    database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row).at(0)),
    ['ok'],
  );
});

test('Catalog V2 down migration removes only catalog tables and restores version 1 state', async (t) => {
  const { temporaryDirectory, databasePath } = await createSeededDatabase(
    'telecom-catalog-v2-rollback-',
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  let database = openDatabase(databasePath, { readOnly: true });
  const legacyTables = applicationTables(database);
  const legacyState = inspectTables(database, legacyTables);
  database.close();

  await applyCatalogMigration(
    databasePath,
    join(temporaryDirectory, 'backups', 'before-catalog-v2.sqlite'),
  );
  const rollbackReport = await rollbackIncrementalMigrations({
    databasePath,
    backupPath: join(temporaryDirectory, 'backups', 'before-catalog-v2-rollback.sqlite'),
    migrations: [
      { version: 1, name: 'create_telecom_schema' },
      CATALOG_V2_MIGRATION,
    ],
    targetVersion: 1,
  });
  assert.deepEqual(rollbackReport.rolledBackVersions, [2]);

  database = openDatabase(databasePath, { readOnly: true });
  assert.deepEqual(applicationTables(database), legacyTables);
  assert.deepEqual(inspectTables(database, legacyTables), legacyState);
  assert.deepEqual(
    database.prepare('SELECT version, name FROM _schema_migrations ORDER BY version').all()
      .map(({ version, name }) => ({ version, name })),
    [{ version: 1, name: 'create_telecom_schema' }],
  );
  assert.deepEqual(
    database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row).at(0)),
    ['ok'],
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

test('a fresh telecom migration target reaches the current Catalog V2 version in one run', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-catalog-v2-fresh-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const report = await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    migrations: TELECOM_MIGRATIONS,
  });
  assert.equal(report.mode, 'create');
  assert.equal(report.currentVersion, 3);
  assert.deepEqual(report.appliedVersions, [2, 3]);

  const database = openDatabase(databasePath, { readOnly: true });
  assert.deepEqual(
    applicationTables(database).filter((tableName) => CATALOG_TABLES.includes(tableName)),
    CATALOG_TABLES,
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

test('a failed fresh overlay removes only the database created by that setup attempt', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-catalog-v2-fresh-failure-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const failingMigration = {
    version: 2,
    name: 'failing_fresh_overlay',
    up() {
      throw new Error('intentional fresh overlay failure');
    },
    down() {},
  };

  await assert.rejects(
    () => migrateTelecomTarget({
      databasePath,
      snapshotPath: SNAPSHOT_PATH,
      migrations: [
        { version: 1, name: 'create_telecom_schema' },
        failingMigration,
      ],
    }),
    /Incremental migration failed/,
  );
  await assert.rejects(() => stat(databasePath), { code: 'ENOENT' });
  await assert.rejects(() => stat(`${databasePath}-wal`), { code: 'ENOENT' });
  await assert.rejects(() => stat(`${databasePath}-shm`), { code: 'ENOENT' });
});
