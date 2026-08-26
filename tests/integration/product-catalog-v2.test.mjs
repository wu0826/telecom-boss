import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

function formatMinorUnits(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function productRow(database, sourceColumn, sourceId) {
  return database.prepare(`
    SELECT id, slug, product_name, product_type, is_featured
    FROM catalog_products
    WHERE ${sourceColumn} = ?
  `).get(sourceId);
}

function seedStockProduct(database, category) {
  const stockItem = database.prepare(`
    INSERT INTO stock_items (
      sku, item_name, item_type, unit, standard_cost, selling_price, reorder_level, is_active
    ) VALUES ('PUBLIC-ROUTER', '公開展示路由器', 'PRODUCT', 'PCS', 50000, 89900, 0, 1)
    RETURNING id
  `).get();
  const product = database.prepare(`
    INSERT INTO catalog_products (
      product_code, slug, product_name, product_type, stock_item_id, status
    ) VALUES ('PUBLIC-ROUTER', 'public-router', '公開展示路由器', 'STOCK_ITEM', ?, 'PUBLISHED')
    RETURNING id, slug, product_name, product_type, is_featured, stock_item_id AS stockItemId
  `).get(stockItem.id);
  database.prepare(`
    INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
    VALUES (?, (SELECT id FROM catalog_categories WHERE slug = ?), 1, 0)
  `).run(product.id, category.slug);
  return product;
}

function primaryCategory(database, productId) {
  return database.prepare(`
    SELECT categories.slug, categories.category_name
    FROM catalog_product_categories AS links
    JOIN catalog_categories AS categories ON categories.id = links.category_id
    WHERE links.product_id = ? AND links.is_primary = 1
  `).get(productId);
}

function seedPublicDetail(database, productId) {
  database.prepare(`
    UPDATE catalog_product_content
    SET title = ?, summary = ?, body_text = ?, seo_title = ?, seo_description = ?
    WHERE product_id = ? AND locale = 'zh-TW'
  `).run(
    'FTTH 300M 家用光纖',
    '適合家庭影音、遠距工作與多裝置連線的穩定光纖方案。',
    '提供清楚的申裝流程與穩定連線服務。',
    'FTTH 300M 家用光纖｜比奇堡電信',
    '查看 FTTH 300M 的月租、優惠與設備贈品。',
    productId,
  );
  database.prepare(`
    INSERT INTO catalog_product_sections (
      product_id, locale, section_key, section_type, title, body_text, sort_order, is_active
    ) VALUES (?, 'zh-TW', 'overview', 'TEXT', '服務重點', '提供固定頻寬與清楚的啟用資訊。', 1, 1)
  `).run(productId);
  database.prepare(`
    INSERT INTO catalog_product_media (
      product_id, media_usage, url, alt_text, is_primary, sort_order
    ) VALUES (?, 'PRIMARY', '/assets/favicon.svg', 'FTTH 300M 光纖服務圖示', 1, 1)
  `).run(productId);
  database.prepare(`
    INSERT INTO catalog_product_specs (
      product_id, locale, spec_key, group_key, group_label, spec_label, spec_value, unit, sort_order
    ) VALUES (?, 'zh-TW', 'download', 'network', '網路能力', '下載速率', '300', 'Mbps', 1)
  `).run(productId);
  const brand = database.prepare(`
    INSERT INTO catalog_brands (
      brand_code, slug, brand_name, description, website_url, logo_url, sort_order, is_active
    ) VALUES ('PUBLIC_DEMO', 'public-demo', '洋基展示品牌', '公開商品頁的品牌資訊。',
      'https://example.test/', '/assets/favicon.svg', 1, 1)
    RETURNING id
  `).get();
  database.prepare(`
    INSERT INTO catalog_product_brands (product_id, brand_id, is_primary, sort_order)
    VALUES (?, ?, 1, 1)
  `).run(productId, brand.id);
}

test('public Catalog V2 products reconcile details, plan prices, promotions, and stock selling prices', async (t) => {
  const application = await startSeededApplication(t, {
    catalogClock: () => Date.parse('2026-08-17T00:00:00.000Z'),
  });
  const database = new DatabaseSync(application.telecomDatabasePath);
  const planProduct = productRow(database, 'service_plan_id', 2);
  const category = primaryCategory(database, planProduct.id);
  const stockProduct = seedStockProduct(database, category);
  seedPublicDetail(database, planProduct.id);
  const sourcePrices = database.prepare(`
    SELECT price_type, billing_cycle, amount, month_from, month_to
    FROM plan_prices
    WHERE service_plan_id = 2 AND is_active = 1
    ORDER BY priority, month_from, id
  `).all();
  const sourceStock = database.prepare('SELECT selling_price FROM stock_items WHERE id = ?').get(stockProduct.stockItemId);
  database.close();

  const listResponse = await fetch(`${application.origin}/api/v1/catalog/products?locale=zh-TW`);
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(Object.keys(listBody).sort(), ['meta', 'products']);
  assert.deepEqual(listBody.meta, { locale: 'zh-TW', hasMore: false });
  const listedPlan = listBody.products.find((product) => product.slug === planProduct.slug);
  assert.ok(listedPlan);
  assert.deepEqual(listedPlan.category, {
    slug: category.slug,
    name: category.category_name,
  });
  assert.deepEqual(listedPlan.content, {
    title: 'FTTH 300M 家用光纖',
    summary: '適合家庭影音、遠距工作與多裝置連線的穩定光纖方案。',
  });
  assert.deepEqual(listedPlan.inquiry, {
    kind: 'PLAN',
    planCode: 'FTTH-300M',
  });
  assert.deepEqual(listedPlan.media, {
    url: '/assets/favicon.svg',
    altText: 'FTTH 300M 光纖服務圖示',
  });
  assert.equal(listedPlan.pricing.kind, 'PLAN');
  assert.equal(listedPlan.pricing.lowestMonthlyAmount, '396.00');
  assert.equal(listedPlan.pricing.sellingPrice, null);
  assert.deepEqual(listedPlan.pricing.prices.map((price) => ({
    type: price.type,
    billingCycle: price.billingCycle,
    amount: price.amount,
    monthFrom: price.monthFrom,
    monthTo: price.monthTo,
  })), sourcePrices.map((price) => ({
    type: price.price_type,
    billingCycle: price.billing_cycle,
    amount: formatMinorUnits(price.amount),
    monthFrom: price.month_from,
    monthTo: price.month_to,
  })));
  assert.equal(listedPlan.promotions[0].code, 'FTTH-A6-GIFT');
  assert.deepEqual(listedPlan.promotions[0].discount, { type: 'NONE', value: '0.00' });
  assert.equal(listedPlan.promotions[0].gift.modelCode, 'TPLINK-A6');
  const listedStock = listBody.products.find((product) => product.slug === stockProduct.slug);
  assert.ok(listedStock);
  assert.deepEqual(listedStock.pricing, {
    kind: 'STOCK',
    lowestMonthlyAmount: null,
    sellingPrice: formatMinorUnits(sourceStock.selling_price),
    prices: [],
  });

  const detailResponse = await fetch(`${application.origin}/api/v1/catalog/products/${planProduct.slug}?locale=zh-TW`);
  const detailBody = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(Object.keys(detailBody), ['product']);
  assert.equal(detailBody.product.slug, planProduct.slug);
  assert.equal(detailBody.product.name, planProduct.product_name);
  assert.equal(detailBody.product.type, 'SERVICE_PLAN');
  assert.equal(detailBody.product.isFeatured, Boolean(planProduct.is_featured));
  assert.deepEqual(detailBody.product.inquiry, {
    kind: 'PLAN',
    planCode: 'FTTH-300M',
  });
  assert.deepEqual(detailBody.product.content, {
    title: 'FTTH 300M 家用光纖',
    summary: '適合家庭影音、遠距工作與多裝置連線的穩定光纖方案。',
    bodyText: '提供清楚的申裝流程與穩定連線服務。',
    seoTitle: 'FTTH 300M 家用光纖｜比奇堡電信',
    seoDescription: '查看 FTTH 300M 的月租、優惠與設備贈品。',
  });
  assert.deepEqual(detailBody.product.media, [{
    usage: 'PRIMARY', url: '/assets/favicon.svg', altText: 'FTTH 300M 光纖服務圖示', isPrimary: true,
  }]);
  assert.deepEqual(detailBody.product.sections, [{
    key: 'overview', type: 'TEXT', title: '服務重點', bodyText: '提供固定頻寬與清楚的啟用資訊。',
  }]);
  assert.deepEqual(detailBody.product.specifications, [{
    key: 'download', groupKey: 'network', groupLabel: '網路能力', label: '下載速率', value: '300', unit: 'Mbps',
  }]);
  assert.deepEqual(detailBody.product.brands, [{
    slug: 'public-demo', name: '洋基展示品牌', description: '公開商品頁的品牌資訊。',
    websiteUrl: 'https://example.test/', logoUrl: '/assets/favicon.svg', isPrimary: true,
  }]);
  assert.doesNotMatch(JSON.stringify(detailBody), /"id"|cost|audit|createdAt|updatedAt|rowVersion|pricePeriodKey/i);

  const overflowDatabase = new DatabaseSync(application.telecomDatabasePath);
  for (let index = 0; index <= 50; index += 1) {
    const slug = `overflow-product-${String(index).padStart(2, '0')}`;
    const product = overflowDatabase.prepare(`
      INSERT INTO catalog_products (product_code, slug, product_name, product_type, status, sort_order)
      VALUES (?, ?, ?, 'GENERAL', 'PUBLISHED', ?)
      RETURNING id
    `).get(`OVERFLOW_${index}`, slug, `公開列表測試商品 ${index}`, 1_000 + index);
    overflowDatabase.prepare(`
      INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
      VALUES (?, (SELECT id FROM catalog_categories WHERE slug = ?), 1, 0)
    `).run(product.id, category.slug);
  }
  const detailOnlyProduct = overflowDatabase.prepare(`
    INSERT INTO catalog_products (product_code, slug, product_name, product_type, status, sort_order)
    VALUES ('DETAIL_ONLY', 'detail-only-product', '僅詳情可取得商品', 'GENERAL', 'PUBLISHED', 9_999)
    RETURNING id
  `).get();
  overflowDatabase.prepare(`
    INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
    VALUES (?, (SELECT id FROM catalog_categories WHERE slug = ?), 1, 0)
  `).run(detailOnlyProduct.id, category.slug);
  overflowDatabase.close();
  const overflowList = await fetch(`${application.origin}/api/v1/catalog/products?locale=zh-TW`).then((response) => response.json());
  assert.equal(overflowList.meta.hasMore, true);
  assert.equal(overflowList.products.some((product) => product.slug === 'detail-only-product'), false);
  const detailOnlyResponse = await fetch(`${application.origin}/api/v1/catalog/products/detail-only-product?locale=zh-TW`);
  assert.equal(detailOnlyResponse.status, 200);
  assert.equal((await detailOnlyResponse.json()).product.slug, 'detail-only-product');
});

test('public Catalog V2 products exclude unpublished, expired, disabled-category, and invalid-source records', async (t) => {
  const application = await startSeededApplication(t, {
    catalogClock: () => Date.parse('2026-08-17T00:00:00.000Z'),
  });
  const database = new DatabaseSync(application.telecomDatabasePath);
  const draft = productRow(database, 'service_plan_id', 1);
  const invalidSource = productRow(database, 'service_plan_id', 2);
  const future = productRow(database, 'service_plan_id', 3);
  const activeCategory = primaryCategory(database, draft.id);
  const archived = seedStockProduct(database, activeCategory);
  database.prepare("UPDATE catalog_products SET status = 'DRAFT' WHERE id = ?").run(draft.id);
  database.prepare('UPDATE service_plans SET is_active = 0 WHERE id = 2').run();
  database.prepare("UPDATE catalog_products SET status = 'SCHEDULED', publish_from = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(future.id);
  database.prepare("UPDATE catalog_products SET status = 'ARCHIVED' WHERE id = ?").run(archived.id);
  database.prepare(`
    INSERT INTO catalog_products (product_code, slug, product_name, product_type, status, publish_until)
    VALUES ('EXPIRED_PUBLIC', 'expired-public', '已過期商品', 'GENERAL', 'PUBLISHED', '2020-01-01T00:00:00.000Z')
  `).run();
  const expired = database.prepare("SELECT id FROM catalog_products WHERE slug = 'expired-public'").get();
  database.prepare(`
    INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
    VALUES (?, (SELECT id FROM catalog_categories WHERE slug = ?), 1, 0)
  `).run(expired.id, activeCategory.slug);
  database.prepare(`
    INSERT INTO catalog_categories (category_code, slug, category_name, is_active, sort_order)
    VALUES ('PUBLIC_DISABLED', 'public-disabled', '已停用分類', 0, 99)
  `).run();
  database.prepare(`
    INSERT INTO catalog_products (product_code, slug, product_name, product_type, status)
    VALUES ('DISABLED_CATEGORY_PUBLIC', 'disabled-category-public', '停用分類商品', 'GENERAL', 'PUBLISHED')
  `).run();
  const disabledCategoryProduct = database.prepare("SELECT id FROM catalog_products WHERE slug = 'disabled-category-public'").get();
  database.prepare(`
    INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
    VALUES (?, (SELECT id FROM catalog_categories WHERE slug = 'public-disabled'), 1, 0)
  `).run(disabledCategoryProduct.id);
  database.close();

  const response = await fetch(`${application.origin}/api/v1/catalog/products?locale=zh-TW`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.products, []);
  for (const slug of [draft.slug, invalidSource.slug, future.slug, archived.slug, 'expired-public', 'disabled-category-public']) {
    const detail = await fetch(`${application.origin}/api/v1/catalog/products/${slug}?locale=zh-TW`);
    assert.equal(detail.status, 404);
    assert.equal((await detail.json()).error.code, 'PRODUCT_NOT_FOUND');
  }
});
