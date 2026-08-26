import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  backfillCatalogV2Database,
  CatalogV2BackfillError,
} from '../../src/server/db/catalog-v2-backfill.mjs';
import {
  migrateTelecomTarget,
  runIncrementalMigrations,
  TELECOM_MIGRATIONS,
} from '../../src/server/db/migration-runner.mjs';
import { seedTelecomDatabase } from '../../src/server/db/seed.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';
import {
  getCatalogPlanPreview,
  getPublicCatalog,
} from '../../src/server/services/catalog-service.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');
const LEGACY_TABLES = [
  'service_plans',
  'plan_prices',
  'promotions',
  'promotion_plans',
  'stock_items',
  'warehouses',
  'warehouse_stock',
  'stock_movements',
  'customers',
  'service_locations',
  'sales_orders',
  'order_service_items',
  'order_product_items',
  'service_inquiries',
  'subscriptions',
];

function openDatabase(databasePath, options = {}) {
  const database = new DatabaseSync(databasePath, options);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function fingerprintRows(rows) {
  return createHash('sha256')
    .update(JSON.stringify(rows.map((row) => ({ ...row }))))
    .digest('hex');
}

function captureLegacyState(databasePath) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(LEGACY_TABLES.map((tableName) => {
      const rows = database.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid`).all();
      return [tableName, {
        rowCount: rows.length,
        fingerprint: fingerprintRows(rows),
      }];
    }));
  } finally {
    database.close();
  }
}

function insertOperationalReferences(database) {
  database.prepare(`
    INSERT INTO stock_items (
      id, sku, item_name, item_type, unit, standard_cost, selling_price,
      reorder_level, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'SKU-ARCHER-A6', 'TP-Link Archer A6', 'EQUIPMENT', 'PCS', 100000, 150000, 1, 1);
  database.prepare(`
    INSERT INTO stock_items (
      id, sku, item_name, item_type, unit, standard_cost, selling_price,
      reorder_level, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'SKU-INACTIVE', '停用設備', 'EQUIPMENT', 'PCS', 1000, 2000, 0, 0);
  database.prepare(`
    INSERT INTO stock_items (
      id, sku, item_name, item_type, unit, standard_cost, selling_price,
      reorder_level, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 'SKU-NO-PRICE', '未定價設備', 'EQUIPMENT', 'PCS', 1000, 0, 0, 1);
  database.prepare(`
    INSERT INTO warehouses (
      id, warehouse_code, warehouse_name, is_active
    ) VALUES (?, ?, ?, ?)
  `).run(1, 'MAIN', '主倉庫', 1);
  database.prepare(`
    INSERT INTO warehouse_stock (
      id, balance_key, warehouse_id, stock_item_id, quantity_on_hand,
      quantity_reserved
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, '1:1', 1, 1, 25, 3);
  database.prepare(`
    INSERT INTO stock_movements (
      id, movement_no, warehouse_id, stock_item_id, movement_type, quantity,
      reference_no, performed_by_staff_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'MOV-TEST-001', 1, 1, 'RECEIPT', 25, 'PO-TEST-001', 1);

  database.prepare(`
    INSERT INTO customers (
      id, customer_no, customer_type, display_name, status
    ) VALUES (?, ?, ?, ?, ?)
  `).run(1, 'CUST-TEST-001', 'PERSON', '測試客戶', 'ACTIVE');
  database.prepare(`
    INSERT INTO service_locations (
      id, location_no, customer_id, city, district, address_line, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'LOC-TEST-001', 1, '台中市', '南區', '測試路 1 號', 'PENDING_SURVEY');
  database.prepare(`
    INSERT INTO sales_orders (
      id, order_no, customer_id, service_location_id, order_type, status,
      sales_staff_user_id, subtotal_amount, tax_amount, total_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'ORD-TEST-001', 1, 1, 'NEW_SERVICE', 'APPROVED', 1, 178800, 0, 178800);
  database.prepare(`
    INSERT INTO order_service_items (
      id, sales_order_id, service_plan_id, plan_price_id, promotion_id,
      quantity, unit_price, contract_months, description_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 1, 1, 1, 28800, 12, '100M 方案價格快照');
  database.prepare(`
    INSERT INTO order_product_items (
      id, sales_order_id, stock_item_id, quantity, unit_price, discount_amount
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 1, 150000, 0);
  database.prepare(`
    INSERT INTO service_inquiries (
      id, inquiry_no, customer_id, prospect_name, phone, requested_plan_id,
      address_text, channel, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'WEB-TEST-001',
    1,
    '測試客戶',
    '0900000000',
    1,
    '台中市南區測試路 1 號',
    'WEB',
    'QUALIFIED',
  );
  database.prepare(`
    INSERT INTO subscriptions (
      id, subscription_no, customer_id, service_location_id, service_plan_id,
      order_service_item_id, status, contract_start_date, contract_end_date,
      monthly_fee, billing_day, auto_renew
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'SUB-TEST-001',
    1,
    1,
    1,
    1,
    'ACTIVE',
    '2026-07-01',
    '2027-06-30',
    28800,
    5,
    1,
  );
}

async function createLegacyDatabaseWithReferences(t, prefix) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  await seedTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  const database = openDatabase(databasePath);
  try {
    insertOperationalReferences(database);
  } finally {
    database.close();
  }
  await runIncrementalMigrations({
    databasePath,
    backupPath: join(temporaryDirectory, 'backups', 'before-catalog-v2.sqlite'),
    migrations: TELECOM_MIGRATIONS,
  });
  return { temporaryDirectory, databasePath };
}

test('Catalog V2 backfill maps every plan and sellable stock item without touching operational data', async (t) => {
  const { databasePath } = await createLegacyDatabaseWithReferences(
    t,
    'telecom-catalog-v2-backfill-',
  );
  const legacyStateBefore = captureLegacyState(databasePath);
  const publicCatalogBefore = await getPublicCatalog(databasePath);
  const planPreviewBefore = await getCatalogPlanPreview(databasePath, 1);

  const firstReport = await backfillCatalogV2Database({ databasePath });
  assert.equal(firstReport.sourcePlanCount, 3);
  assert.equal(firstReport.eligibleStockItemCount, 1);
  assert.deepEqual(firstReport.inserted, {
    categories: 4,
    products: 4,
    productCategories: 4,
    productContent: 4,
    promotionProducts: 2,
  });

  const database = openDatabase(databasePath, { readOnly: true });
  assert.deepEqual(
    database.prepare(`
      SELECT product_code, product_type, service_plan_id, stock_item_id, status
      FROM catalog_products
      ORDER BY product_type, product_code
    `).all().map((row) => ({ ...row })),
    [
      {
        product_code: 'PLAN-FTTH-300M',
        product_type: 'SERVICE_PLAN',
        service_plan_id: 2,
        stock_item_id: null,
        status: 'PUBLISHED',
      },
      {
        product_code: 'PLAN-FTTH-500M',
        product_type: 'SERVICE_PLAN',
        service_plan_id: 3,
        stock_item_id: null,
        status: 'PUBLISHED',
      },
      {
        product_code: 'PLAN-VDSL2-100M',
        product_type: 'SERVICE_PLAN',
        service_plan_id: 1,
        stock_item_id: null,
        status: 'PUBLISHED',
      },
      {
        product_code: 'ITEM-SKU-ARCHER-A6',
        product_type: 'STOCK_ITEM',
        service_plan_id: null,
        stock_item_id: 1,
        status: 'PUBLISHED',
      },
    ],
  );
  assert.deepEqual(
    database.prepare(`
      SELECT category_code, parent_id, slug
      FROM catalog_categories
      ORDER BY category_code
    `).all().map((row) => ({ ...row })),
    [
      { category_code: 'CATALOG_PRODUCTS', parent_id: null, slug: 'products' },
      { category_code: 'CATALOG_SERVICES', parent_id: null, slug: 'services' },
      { category_code: 'ITEM-EQUIPMENT', parent_id: 2, slug: 'products-equipment' },
      { category_code: 'SERVICE-BROADBAND', parent_id: 1, slug: 'services-broadband' },
    ],
  );
  const productSlugs = database.prepare(`
    SELECT slug
    FROM catalog_products
    ORDER BY id
  `).all().map(({ slug }) => slug);
  assert.equal(new Set(productSlugs).size, 4);
  assert.ok(productSlugs.every((slug) => /^(plan|item)-[a-z0-9-]+-[0-9a-f]{8}$/.test(slug)));
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM catalog_product_categories WHERE is_primary = 1')
      .get().count,
    4,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM catalog_product_content').get().count, 4);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM catalog_promotion_products').get().count, 2);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE stock_item_id IN (2, 3)')
      .get().count,
    0,
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();

  assert.deepEqual(captureLegacyState(databasePath), legacyStateBefore);
  assert.deepEqual(await getPublicCatalog(databasePath), publicCatalogBefore);
  assert.deepEqual(await getCatalogPlanPreview(databasePath, 1), planPreviewBefore);

  const secondReport = await backfillCatalogV2Database({ databasePath });
  assert.deepEqual(secondReport.inserted, {
    categories: 0,
    products: 0,
    productCategories: 0,
    productContent: 0,
    promotionProducts: 0,
  });
  assert.deepEqual(captureLegacyState(databasePath), legacyStateBefore);
  assert.deepEqual(await getPublicCatalog(databasePath), publicCatalogBefore);
  assert.deepEqual(await getCatalogPlanPreview(databasePath, 1), planPreviewBefore);
});

test('telecom seed backfills Catalog V2 when migration version 2 is present and remains idempotent', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-catalog-v2-seed-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    migrations: TELECOM_MIGRATIONS,
  });

  const firstReport = await seedTelecomDatabase({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
  });
  assert.equal(firstReport.catalogBackfill.sourcePlanCount, 3);
  assert.equal(firstReport.catalogBackfill.eligibleStockItemCount, 0);
  assert.equal(firstReport.catalogBackfill.inserted.products, 3);

  const secondReport = await seedTelecomDatabase({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
  });
  assert.deepEqual(secondReport.catalogBackfill.inserted, {
    categories: 0,
    products: 0,
    productCategories: 0,
    productContent: 0,
    promotionProducts: 0,
  });

  const database = openDatabase(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM catalog_products').get().count, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM catalog_product_content').get().count, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM catalog_promotion_products').get().count, 2);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

test('Catalog V2 backfill fails atomically when deterministic product identity conflicts', async (t) => {
  const { databasePath } = await createLegacyDatabaseWithReferences(
    t,
    'telecom-catalog-v2-backfill-conflict-',
  );
  const legacyStateBefore = captureLegacyState(databasePath);
  const database = openDatabase(databasePath);
  database.prepare(`
    INSERT INTO catalog_products (
      product_code, slug, product_name, product_type, status
    ) VALUES (?, ?, ?, ?, ?)
  `).run('PLAN-VDSL2-100M', 'manual-conflict', '手動衝突商品', 'GENERAL', 'DRAFT');
  database.close();

  await assert.rejects(
    () => backfillCatalogV2Database({ databasePath }),
    (error) => error instanceof CatalogV2BackfillError
      && /UNIQUE constraint failed/.test(error.cause?.message),
  );

  const verifiedDatabase = openDatabase(databasePath, { readOnly: true });
  assert.equal(verifiedDatabase.prepare('SELECT COUNT(*) AS count FROM catalog_categories').get().count, 0);
  assert.equal(
    verifiedDatabase.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE service_plan_id IS NOT NULL')
      .get().count,
    0,
  );
  assert.equal(verifiedDatabase.prepare('SELECT COUNT(*) AS count FROM catalog_product_content').get().count, 0);
  verifiedDatabase.close();
  assert.deepEqual(captureLegacyState(databasePath), legacyStateBefore);
});
