import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { openSqliteDatabase, runInTransaction } from './sqlite.mjs';

const DEFAULT_LOCALE = 'zh-TW';
const MAX_CODE_LENGTH = 50;
const MAX_SLUG_LENGTH = 120;

export class CatalogV2BackfillError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CatalogV2BackfillError';
  }
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function stableCode(prefix, sourceCode) {
  const normalizedSource = String(sourceCode).trim().toUpperCase();
  const candidate = `${prefix}-${normalizedSource}`;
  if (candidate.length <= MAX_CODE_LENGTH) return candidate;
  const hash = shortHash(`${prefix}:${normalizedSource}`);
  const available = MAX_CODE_LENGTH - prefix.length - hash.length - 2;
  return `${prefix}-${normalizedSource.slice(0, available)}-${hash}`;
}

function normalizeSlug(value) {
  return String(value).trim()
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stableSlug(prefix, sourceCode) {
  const source = String(sourceCode).trim();
  const normalized = normalizeSlug(source);
  const hash = shortHash(`${prefix}:${source}`);
  const fallback = normalized || 'product';
  const available = MAX_SLUG_LENGTH - prefix.length - hash.length - 2;
  return `${prefix}-${fallback.slice(0, available).replace(/-+$/g, '')}-${hash}`;
}

function categorySlug(prefix, sourceCategory) {
  const normalized = normalizeSlug(sourceCategory) || shortHash(sourceCategory);
  return `${prefix}-${normalized}`;
}

function readableCategoryName(value, knownNames) {
  return knownNames[value] ?? String(value)
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function assertCatalogMigration(database) {
  let migration;
  try {
    migration = database.prepare(`
      SELECT version
      FROM _schema_migrations
      WHERE name = ?
    `).get('create_catalog_v2_schema');
  } catch (error) {
    throw new CatalogV2BackfillError('Catalog V2 migration registry is unavailable', {
      cause: error,
    });
  }
  if (migration?.version !== 2) {
    throw new CatalogV2BackfillError(
      'Catalog V2 schema must be migrated before backfill',
    );
  }
}

function insertCategory(database, category) {
  return Number(database.prepare(`
    INSERT INTO catalog_categories (
      parent_id, category_code, slug, category_name, sort_order, is_active
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(category_code) DO NOTHING
  `).run(
    category.parentId,
    category.code,
    category.slug,
    category.name,
    category.sortOrder,
    1,
  ).changes);
}

function categoryId(database, code) {
  const category = database.prepare(`
    SELECT id
    FROM catalog_categories
    WHERE category_code = ?
  `).get(code);
  if (!category) {
    throw new CatalogV2BackfillError(`Catalog category was not created: ${code}`);
  }
  return category.id;
}

function insertProduct(database, product) {
  const statement = product.productType === 'SERVICE_PLAN'
    ? database.prepare(`
      INSERT INTO catalog_products (
        product_code, slug, product_name, product_type, service_plan_id, status
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_plan_id) DO NOTHING
    `)
    : database.prepare(`
      INSERT INTO catalog_products (
        product_code, slug, product_name, product_type, stock_item_id, status
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(stock_item_id) DO NOTHING
    `);
  return Number(statement.run(
    product.code,
    product.slug,
    product.name,
    product.productType,
    product.sourceId,
    product.status,
  ).changes);
}

function productId(database, productType, sourceId) {
  const sourceColumn = productType === 'SERVICE_PLAN' ? 'service_plan_id' : 'stock_item_id';
  const product = database.prepare(`
    SELECT id
    FROM catalog_products
    WHERE ${sourceColumn} = ?
  `).get(sourceId);
  if (!product) {
    throw new CatalogV2BackfillError(
      `Catalog product was not created for ${productType} source ${sourceId}`,
    );
  }
  return product.id;
}

function insertProductCategory(database, productIdValue, categoryIdValue) {
  const hasPrimary = Boolean(database.prepare(`
    SELECT 1
    FROM catalog_product_categories
    WHERE product_id = ? AND is_primary = 1
  `).get(productIdValue));
  return Number(database.prepare(`
    INSERT INTO catalog_product_categories (
      product_id, category_id, is_primary, sort_order
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, category_id) DO NOTHING
  `).run(productIdValue, categoryIdValue, hasPrimary ? 0 : 1, 0).changes);
}

function insertProductContent(database, productIdValue, source) {
  return Number(database.prepare(`
    INSERT INTO catalog_product_content (
      product_id, locale, title, summary
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, locale) DO NOTHING
  `).run(
    productIdValue,
    DEFAULT_LOCALE,
    source.name,
    source.description,
  ).changes);
}

function buildPlanProduct(plan) {
  return {
    productType: 'SERVICE_PLAN',
    sourceId: plan.id,
    sourceCategory: plan.service_category,
    code: stableCode('PLAN', plan.plan_code),
    slug: stableSlug('plan', plan.plan_code),
    name: plan.plan_name,
    description: plan.description,
    status: plan.is_active === 1 ? 'PUBLISHED' : 'ARCHIVED',
  };
}

function buildStockProduct(item) {
  return {
    productType: 'STOCK_ITEM',
    sourceId: item.id,
    sourceCategory: item.item_type,
    code: stableCode('ITEM', item.sku),
    slug: stableSlug('item', item.sku),
    name: item.item_name,
    description: null,
    status: 'PUBLISHED',
  };
}

function insertPromotionProducts(database) {
  const links = database.prepare(`
    SELECT
      promotion_plans.promotion_id,
      catalog_products.id AS product_id
    FROM promotion_plans
    JOIN catalog_products
      ON catalog_products.service_plan_id = promotion_plans.service_plan_id
    ORDER BY promotion_plans.promotion_id, catalog_products.id
  `).all();
  const insert = database.prepare(`
    INSERT INTO catalog_promotion_products (promotion_id, product_id)
    VALUES (?, ?)
    ON CONFLICT(promotion_id, product_id) DO NOTHING
  `);
  return links.reduce(
    (count, link) => count + Number(insert.run(link.promotion_id, link.product_id).changes),
    0,
  );
}

export function backfillCatalogV2(database) {
  try {
    assertCatalogMigration(database);
    const plans = database.prepare(`
      SELECT
        id,
        plan_code,
        plan_name,
        service_category,
        description,
        is_active
      FROM service_plans
      ORDER BY id
    `).all();
    const stockItems = database.prepare(`
      SELECT
        id,
        sku,
        item_name,
        item_type
      FROM stock_items
      WHERE is_active = 1
        AND selling_price > 0
      ORDER BY id
    `).all();
    const inserted = {
      categories: 0,
      products: 0,
      productCategories: 0,
      productContent: 0,
      promotionProducts: 0,
    };

    inserted.categories += insertCategory(database, {
      parentId: null,
      code: 'CATALOG_SERVICES',
      slug: 'services',
      name: '電信服務',
      sortOrder: 10,
    });
    inserted.categories += insertCategory(database, {
      parentId: null,
      code: 'CATALOG_PRODUCTS',
      slug: 'products',
      name: '設備商品',
      sortOrder: 20,
    });
    const serviceRootId = categoryId(database, 'CATALOG_SERVICES');
    const productRootId = categoryId(database, 'CATALOG_PRODUCTS');

    const serviceCategoryIds = new Map();
    for (const sourceCategory of [...new Set(plans.map((plan) => plan.service_category))].sort()) {
      const code = stableCode('SERVICE', sourceCategory);
      inserted.categories += insertCategory(database, {
        parentId: serviceRootId,
        code,
        slug: categorySlug('services', sourceCategory),
        name: readableCategoryName(sourceCategory, {
          BROADBAND: '寬頻服務',
          IPTV: '影音服務',
          VOICE: '語音服務',
        }),
        sortOrder: 10,
      });
      serviceCategoryIds.set(sourceCategory, categoryId(database, code));
    }

    const stockCategoryIds = new Map();
    for (const sourceCategory of [...new Set(stockItems.map((item) => item.item_type))].sort()) {
      const code = stableCode('ITEM', sourceCategory);
      inserted.categories += insertCategory(database, {
        parentId: productRootId,
        code,
        slug: categorySlug('products', sourceCategory),
        name: readableCategoryName(sourceCategory, {
          EQUIPMENT: '設備',
          MATERIAL: '材料',
          ACCESSORY: '配件',
        }),
        sortOrder: 10,
      });
      stockCategoryIds.set(sourceCategory, categoryId(database, code));
    }

    for (const plan of plans) {
      const product = buildPlanProduct(plan);
      inserted.products += insertProduct(database, product);
      const id = productId(database, product.productType, product.sourceId);
      inserted.productCategories += insertProductCategory(
        database,
        id,
        serviceCategoryIds.get(product.sourceCategory),
      );
      inserted.productContent += insertProductContent(database, id, product);
    }

    for (const item of stockItems) {
      const product = buildStockProduct(item);
      inserted.products += insertProduct(database, product);
      const id = productId(database, product.productType, product.sourceId);
      inserted.productCategories += insertProductCategory(
        database,
        id,
        stockCategoryIds.get(product.sourceCategory),
      );
      inserted.productContent += insertProductContent(database, id, product);
    }

    inserted.promotionProducts = insertPromotionProducts(database);
    return {
      sourcePlanCount: plans.length,
      eligibleStockItemCount: stockItems.length,
      inserted,
    };
  } catch (error) {
    if (error instanceof CatalogV2BackfillError) throw error;
    throw new CatalogV2BackfillError(`Catalog V2 backfill failed: ${error.message}`, {
      cause: error,
    });
  }
}

export async function backfillCatalogV2Database({ databasePath }) {
  const resolvedDatabasePath = resolve(databasePath);
  const database = openSqliteDatabase(resolvedDatabasePath);
  try {
    return runInTransaction(database, () => backfillCatalogV2(database));
  } finally {
    database.close();
  }
}
