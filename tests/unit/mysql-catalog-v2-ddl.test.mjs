import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UP_PATH = join(PROJECT_ROOT, 'database', 'migrations', 'mysql', '002_catalog_v2_up.sql');
const DOWN_PATH = join(PROJECT_ROOT, 'database', 'migrations', 'mysql', '002_catalog_v2_down.sql');

const CATALOG_TABLES = [
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

const SOURCE_FOREIGN_KEYS = [
  ['catalog_categories', 'created_by_staff_user_id', 'staff_users'],
  ['catalog_categories', 'updated_by_staff_user_id', 'staff_users'],
  ['catalog_products', 'service_plan_id', 'service_plans'],
  ['catalog_products', 'stock_item_id', 'stock_items'],
  ['catalog_products', 'created_by_staff_user_id', 'staff_users'],
  ['catalog_products', 'updated_by_staff_user_id', 'staff_users'],
  ['catalog_promotion_products', 'promotion_id', 'promotions'],
];

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

test('MySQL Catalog V2 migration defines the same ten additive tables', async () => {
  const sql = await readFile(UP_PATH, 'utf8');
  const createdTables = [...sql.matchAll(/CREATE TABLE\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1]);

  assert.deepEqual(createdTables, CATALOG_TABLES);
  assert.equal((sql.match(/ENGINE=InnoDB/g) ?? []).length, CATALOG_TABLES.length);
  assert.equal((sql.match(/DEFAULT CHARSET=utf8mb4/g) ?? []).length, CATALOG_TABLES.length);

  assert.doesNotMatch(sql, /\bAUTOINCREMENT\b/i);
  assert.doesNotMatch(sql, /\bSTRICT\b/i);
  assert.doesNotMatch(sql, /strftime\s*\(/i);
  assert.doesNotMatch(sql, /julianday\s*\(/i);
  assert.doesNotMatch(sql, /RAISE\s*\(/i);
});

test('MySQL Catalog V2 migration keeps source FKs compatible with signed BIGINT IDs', async () => {
  const sql = normalizeSql(await readFile(UP_PATH, 'utf8'));

  for (const [tableName, columnName, referencedTable] of SOURCE_FOREIGN_KEYS) {
    const tableStart = sql.indexOf(`CREATE TABLE ${tableName} (`);
    const tableEnd = sql.indexOf(' ENGINE=InnoDB', tableStart);
    assert.notEqual(tableStart, -1, `${tableName} exists`);
    const tableSql = sql.slice(tableStart, tableEnd);

    assert.match(tableSql, new RegExp(`\\b${columnName} BIGINT (?:NULL|NOT NULL)\\b`));
    assert.match(
      tableSql,
      new RegExp(`FOREIGN KEY \\(${columnName}\\) REFERENCES ${referencedTable}\\(id\\)`),
    );
    assert.doesNotMatch(
      tableSql,
      new RegExp(`\\b${columnName} BIGINT UNSIGNED\\b`),
      `${tableName}.${columnName} must remain signed to match the existing schema`,
    );
  }
});

test('MySQL Catalog V2 migration preserves one-primary and category hierarchy invariants', async () => {
  const sql = normalizeSql(await readFile(UP_PATH, 'utf8'));

  assert.match(sql, /CREATE UNIQUE INDEX uq_catalog_product_categories_primary/);
  assert.match(sql, /CASE WHEN is_primary = 1 THEN product_id ELSE NULL END/);
  assert.match(sql, /CREATE UNIQUE INDEX uq_catalog_product_media_primary/);
  assert.match(sql, /CREATE UNIQUE INDEX uq_catalog_product_brands_primary/);

  assert.match(sql, /CREATE TRIGGER trg_catalog_categories_insert_depth/);
  assert.match(sql, /CREATE TRIGGER trg_catalog_categories_update_parent/);
  assert.match(sql, /WITH RECURSIVE ancestors/);
  assert.match(sql, /WITH RECURSIVE descendants/);
  assert.match(sql, /WITH RECURSIVE subtree/);
  assert.match(sql, /catalog category maximum depth is 4/);
  assert.match(sql, /catalog category cycle is not allowed/);
});

test('MySQL Catalog V2 rollback removes only Catalog V2 objects in dependency-safe order', async () => {
  const sql = await readFile(DOWN_PATH, 'utf8');
  const droppedTables = [...sql.matchAll(/DROP TABLE IF EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1]);

  assert.deepEqual(droppedTables, [
    'catalog_promotion_products',
    'catalog_product_brands',
    'catalog_product_categories',
    'catalog_product_specs',
    'catalog_product_media',
    'catalog_product_sections',
    'catalog_product_content',
    'catalog_products',
    'catalog_brands',
    'catalog_categories',
  ]);

  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS\s+(staff_users|service_plans|stock_items|promotions)/i);
});
