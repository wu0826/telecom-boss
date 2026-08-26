import { openRuntimeDatabase } from '../db/runtime-database.mjs';

const PUBLIC_PRODUCT_LIMIT = 50;

const LIVE_PRODUCTS_SQL = `
  WITH RECURSIVE primary_categories AS (
    SELECT
      links.product_id,
      categories.id AS category_id,
      categories.parent_id,
      categories.slug AS category_slug,
      categories.category_name,
      categories.is_active AS category_active
    FROM catalog_product_categories AS links
    JOIN catalog_categories AS categories ON categories.id = links.category_id
    WHERE links.is_primary = 1
  ), category_paths AS (
    SELECT product_id, category_id, parent_id, category_active
    FROM primary_categories
    UNION ALL
    SELECT category_paths.product_id, categories.id, categories.parent_id, categories.is_active
    FROM catalog_categories AS categories
    JOIN category_paths ON categories.id = category_paths.parent_id
  )
  SELECT
    products.id,
    products.slug,
    products.product_name,
    products.product_type,
    products.is_featured,
    products.service_plan_id,
    products.stock_item_id,
    primary_categories.category_slug,
    primary_categories.category_name,
    content.title AS content_title,
    content.summary AS content_summary,
    content.body_text AS content_body_text,
    content.seo_title AS content_seo_title,
    content.seo_description AS content_seo_description,
    service_plans.plan_code AS service_plan_code,
    stock_items.selling_price AS stock_selling_price
  FROM catalog_products AS products
  JOIN primary_categories ON primary_categories.product_id = products.id
  LEFT JOIN catalog_product_content AS content
    ON content.product_id = products.id AND content.locale = ?
  LEFT JOIN service_plans
    ON service_plans.id = products.service_plan_id
  LEFT JOIN stock_items
    ON stock_items.id = products.stock_item_id
  WHERE products.status = 'PUBLISHED'
    AND (products.publish_from IS NULL OR products.publish_from <= ?)
    AND (products.publish_until IS NULL OR products.publish_until >= ?)
    AND (? IS NULL OR primary_categories.category_slug = ?)
    AND (? IS NULL OR products.slug = ?)
    AND NOT EXISTS (
      SELECT 1
      FROM category_paths
      WHERE category_paths.product_id = products.id
        AND category_paths.category_active <> 1
    )
    AND (
      (products.product_type = 'GENERAL'
        AND products.service_plan_id IS NULL
        AND products.stock_item_id IS NULL)
      OR (products.product_type = 'SERVICE_PLAN'
        AND service_plans.is_active = 1
        AND (service_plans.effective_from IS NULL OR service_plans.effective_from <= ?)
        AND (service_plans.effective_to IS NULL OR service_plans.effective_to >= ?))
      OR (products.product_type = 'STOCK_ITEM'
        AND stock_items.is_active = 1
        AND stock_items.selling_price > 0)
    )
  ORDER BY primary_categories.category_name, products.sort_order, products.id
`;

function formatMinorUnits(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function priceLabel(price) {
  if (price.price_type === 'INTRO' && price.month_from && price.month_to) {
    return `第 ${price.month_from}–${price.month_to} 個月`;
  }
  if (price.price_type === 'RENEWAL' && price.month_from) {
    return `第 ${price.month_from} 個月起`;
  }
  if (price.billing_cycle === 'ONE_TIME') return '一次性費用';
  return '標準月租';
}

function isSafeAssetUrl(value) {
  const url = String(value ?? '');
  return (url.startsWith('/') && !url.startsWith('//')) || /^https:\/\//i.test(url);
}

function safeAssetUrl(value) {
  return isSafeAssetUrl(value) ? value : null;
}

function safeWebsiteUrl(value) {
  const url = String(value ?? '');
  return /^https:\/\//i.test(url) ? url : null;
}

function contentDto(row, { detail }) {
  if (row.content_title === null) return null;
  const content = {
    title: row.content_title,
    summary: row.content_summary,
  };
  if (detail) {
    content.bodyText = row.content_body_text;
    content.seoTitle = row.content_seo_title;
    content.seoDescription = row.content_seo_description;
  }
  return content;
}

async function mediaDtos(database, productId) {
  return (await database.prepare(`
    SELECT media_usage, url, alt_text, is_primary
    FROM catalog_product_media
    WHERE product_id = ?
    ORDER BY sort_order, id
  `).all(productId)).flatMap((media) => {
    const url = safeAssetUrl(media.url);
    return url ? [{
      usage: media.media_usage,
      url,
      altText: media.alt_text,
      isPrimary: Boolean(media.is_primary),
    }] : [];
  });
}

async function sectionDtos(database, productId, locale) {
  return (await database.prepare(`
    SELECT section_key, section_type, title, body_text
    FROM catalog_product_sections
    WHERE product_id = ? AND locale = ? AND is_active = 1
    ORDER BY sort_order, id
  `).all(productId, locale)).map((section) => ({
    key: section.section_key,
    type: section.section_type,
    title: section.title,
    bodyText: section.body_text,
  }));
}

async function specificationDtos(database, productId, locale) {
  return (await database.prepare(`
    SELECT spec_key, group_key, group_label, spec_label, spec_value, unit
    FROM catalog_product_specs
    WHERE product_id = ? AND locale = ?
    ORDER BY group_key, sort_order, id
  `).all(productId, locale)).map((specification) => ({
    key: specification.spec_key,
    groupKey: specification.group_key,
    groupLabel: specification.group_label,
    label: specification.spec_label,
    value: specification.spec_value,
    unit: specification.unit,
  }));
}

async function brandDtos(database, productId) {
  return (await database.prepare(`
    SELECT brands.slug, brands.brand_name, brands.description, brands.website_url, brands.logo_url,
      links.is_primary
    FROM catalog_product_brands AS links
    JOIN catalog_brands AS brands ON brands.id = links.brand_id
    WHERE links.product_id = ? AND brands.is_active = 1
    ORDER BY links.sort_order, brands.sort_order, brands.id
  `).all(productId)).map((brand) => ({
    slug: brand.slug,
    name: brand.brand_name,
    description: brand.description,
    websiteUrl: safeWebsiteUrl(brand.website_url),
    logoUrl: safeAssetUrl(brand.logo_url),
    isPrimary: Boolean(brand.is_primary),
  }));
}

async function priceDtos(database, servicePlanId, nowDate) {
  return (await database.prepare(`
    SELECT price_type, billing_cycle, amount, month_from, month_to
    FROM plan_prices
    WHERE service_plan_id = ?
      AND is_active = 1
      AND (effective_from IS NULL OR effective_from <= ?)
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY priority, month_from, id
  `).all(servicePlanId, nowDate, nowDate)).map((price) => ({
    type: price.price_type,
    billingCycle: price.billing_cycle,
    amount: formatMinorUnits(price.amount),
    monthFrom: price.month_from,
    monthTo: price.month_to,
    label: priceLabel(price),
  }));
}

async function pricingDto(database, row, nowDate) {
  if (row.product_type === 'SERVICE_PLAN') {
    const prices = await priceDtos(database, row.service_plan_id, nowDate);
    const monthlyAmounts = prices
      .filter((price) => price.billingCycle === 'MONTHLY')
      .map((price) => BigInt(price.amount.replace('.', '')));
    const lowestMonthlyAmount = monthlyAmounts.length === 0
      ? null
      : formatMinorUnits(monthlyAmounts.reduce((lowest, amount) => (amount < lowest ? amount : lowest)));
    return {
      kind: 'PLAN',
      lowestMonthlyAmount,
      sellingPrice: null,
      prices,
    };
  }
  if (row.product_type === 'STOCK_ITEM') {
    return {
      kind: 'STOCK',
      lowestMonthlyAmount: null,
      sellingPrice: formatMinorUnits(row.stock_selling_price),
      prices: [],
    };
  }
  return {
    kind: 'NONE',
    lowestMonthlyAmount: null,
    sellingPrice: null,
    prices: [],
  };
}

async function promotionDtos(database, row, nowIso) {
  return (await database.prepare(`
    SELECT promotions.promotion_code, promotions.promotion_name, promotions.description,
      promotions.discount_type, promotions.discount_value, promotions.gift_quantity,
      equipment.model_code, equipment.brand, equipment.model_name
    FROM catalog_promotion_products AS links
    JOIN promotions ON promotions.id = links.promotion_id
    LEFT JOIN equipment_models AS equipment ON equipment.id = promotions.gift_equipment_model_id
    WHERE links.product_id = ?
      AND promotions.is_active = 1
      AND (promotions.starts_at IS NULL OR promotions.starts_at <= ?)
      AND (promotions.ends_at IS NULL OR promotions.ends_at >= ?)
      AND (
        ? <> 'SERVICE_PLAN'
        OR EXISTS (
          SELECT 1
          FROM promotion_plans
          WHERE promotion_plans.promotion_id = promotions.id
            AND promotion_plans.service_plan_id = ?
        )
      )
    ORDER BY promotions.id
  `).all(row.id, nowIso, nowIso, row.product_type, row.service_plan_id)).map((promotion) => ({
    code: promotion.promotion_code,
    name: promotion.promotion_name,
    description: promotion.description,
    discount: {
      type: promotion.discount_type,
      value: formatMinorUnits(promotion.discount_value),
    },
    gift: promotion.model_code ? {
      quantity: promotion.gift_quantity,
      modelCode: promotion.model_code,
      brand: promotion.brand,
      modelName: promotion.model_name,
    } : null,
  }));
}

async function baseDto(database, row, nowDate, nowIso) {
  const media = await mediaDtos(database, row.id);
  const primaryMedia = media.find((item) => item.isPrimary) ?? null;
  return {
    slug: row.slug,
    name: row.product_name,
    type: row.product_type,
    isFeatured: Boolean(row.is_featured),
    category: {
      slug: row.category_slug,
      name: row.category_name,
    },
    content: contentDto(row, { detail: false }),
    media: primaryMedia ? { url: primaryMedia.url, altText: primaryMedia.altText } : null,
    pricing: await pricingDto(database, row, nowDate),
    promotions: await promotionDtos(database, row, nowIso),
    inquiry: {
      kind: row.product_type === 'SERVICE_PLAN' ? 'PLAN' : 'GENERAL',
      planCode: row.product_type === 'SERVICE_PLAN' ? row.service_plan_code : null,
    },
  };
}

async function detailDto(database, row, locale, nowDate, nowIso) {
  const product = await baseDto(database, row, nowDate, nowIso);
  return {
    ...product,
    content: contentDto(row, { detail: true }),
    media: await mediaDtos(database, row.id),
    sections: await sectionDtos(database, row.id, locale),
    specifications: await specificationDtos(database, row.id, locale),
    brands: await brandDtos(database, row.id),
  };
}

function nowValues(clock) {
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new Error('Catalog clock must return a valid timestamp');
  const nowIso = now.toISOString();
  return { nowIso, nowDate: nowIso.slice(0, 10) };
}

async function liveProductRows(database, {
  locale, category, slug = null, nowIso, nowDate, limit = PUBLIC_PRODUCT_LIMIT + 1,
}) {
  const safeLimit = Number(limit);
  if (
    !Number.isSafeInteger(safeLimit)
    || safeLimit < 1
    || safeLimit > PUBLIC_PRODUCT_LIMIT + 1
  ) {
    throw new RangeError('Catalog product limit is out of range');
  }

  return database.prepare(`${LIVE_PRODUCTS_SQL}
LIMIT ${safeLimit}`).all(
    locale,
    nowIso,
    nowIso,
    category,
    category,
    slug,
    slug,
    nowDate,
    nowDate,
  );
}

export async function getPublicCatalogProducts(databasePath, { locale, category = null, clock = Date.now } = {}) {
  const { nowIso, nowDate } = nowValues(clock);
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = database.kind === 'mysql'
    ? nowIso.replace('T', ' ').replace('Z', '')
    : nowIso;
  const rows = await liveProductRows(database, { locale, category, nowIso: databaseNow, nowDate });
  const hasMore = rows.length > PUBLIC_PRODUCT_LIMIT;
  return {
    products: await Promise.all(
      rows.slice(0, PUBLIC_PRODUCT_LIMIT).map((row) => baseDto(database, row, nowDate, databaseNow)),
    ),
    meta: { locale, hasMore },
  };
}

export async function getPublicCatalogProduct(databasePath, slug, { locale, clock = Date.now } = {}) {
  const { nowIso, nowDate } = nowValues(clock);
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = database.kind === 'mysql'
    ? nowIso.replace('T', ' ').replace('Z', '')
    : nowIso;
  const rows = await liveProductRows(database, {
    locale, category: null, slug, nowIso: databaseNow, nowDate, limit: 1,
  });
  const row = rows.at(0) ?? null;
  return row ? detailDto(database, row, locale, nowDate, databaseNow) : null;
}
