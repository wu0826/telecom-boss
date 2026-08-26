import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function selectProduct(database, productId) {
  return await database.prepare(`
    SELECT id, row_version, updated_at
    FROM catalog_products
    WHERE id = ?
  `).get(productId) ?? null;
}

async function selectContent(database, productId, locale) {
  return await database.prepare(`
    SELECT id, product_id, locale, title, summary, body_text, seo_title, seo_description,
      created_at, updated_at, row_version
    FROM catalog_product_content
    WHERE product_id = ? AND locale = ?
  `).get(productId, locale) ?? null;
}

async function selectSection(database, productId, sectionId) {
  return await database.prepare(`
    SELECT id, product_id, locale, section_key, section_type, title, body_text,
      sort_order, is_active, created_at, updated_at, row_version
    FROM catalog_product_sections
    WHERE product_id = ? AND id = ?
  `).get(productId, sectionId) ?? null;
}

async function selectSpec(database, productId, specId) {
  return await database.prepare(`
    SELECT id, product_id, locale, spec_key, group_key, group_label, spec_label, spec_value,
      unit, sort_order, created_at, updated_at, row_version
    FROM catalog_product_specs
    WHERE product_id = ? AND id = ?
  `).get(productId, specId) ?? null;
}

async function selectMedia(database, productId, mediaId) {
  return await database.prepare(`
    SELECT id, product_id, media_type, media_usage, url, alt_text, is_primary, sort_order,
      created_at, updated_at, row_version
    FROM catalog_product_media
    WHERE product_id = ? AND id = ?
  `).get(productId, mediaId) ?? null;
}

async function selectBrand(database, brandId) {
  return await database.prepare(`
    SELECT id, brand_code, slug, brand_name, description, website_url, logo_url,
      sort_order, is_active, created_at, updated_at, row_version
    FROM catalog_brands
    WHERE id = ?
  `).get(brandId) ?? null;
}

async function selectProductBrand(database, productId, brandId) {
  return await database.prepare(`
    SELECT
      links.product_id,
      links.brand_id,
      links.is_primary,
      links.sort_order,
      links.created_at,
      brands.brand_code,
      brands.slug,
      brands.brand_name,
      brands.description,
      brands.website_url,
      brands.logo_url,
      brands.is_active,
      brands.row_version AS brand_row_version
    FROM catalog_product_brands AS links
    JOIN catalog_brands AS brands ON brands.id = links.brand_id
    WHERE links.product_id = ? AND links.brand_id = ?
  `).get(productId, brandId) ?? null;
}

async function listSections(database, productId, locale) {
  return await database.prepare(`
    SELECT id, product_id, locale, section_key, section_type, title, body_text,
      sort_order, is_active, created_at, updated_at, row_version
    FROM catalog_product_sections
    WHERE product_id = ? AND locale = ?
    ORDER BY sort_order, id
  `).all(productId, locale);
}

async function listSpecs(database, productId, locale) {
  return await database.prepare(`
    SELECT id, product_id, locale, spec_key, group_key, group_label, spec_label, spec_value,
      unit, sort_order, created_at, updated_at, row_version
    FROM catalog_product_specs
    WHERE product_id = ? AND locale = ?
    ORDER BY group_key, sort_order, id
  `).all(productId, locale);
}

async function listMedia(database, productId) {
  return await database.prepare(`
    SELECT id, product_id, media_type, media_usage, url, alt_text, is_primary, sort_order,
      created_at, updated_at, row_version
    FROM catalog_product_media
    WHERE product_id = ?
    ORDER BY sort_order, id
  `).all(productId);
}

async function listBrands(database) {
  return await database.prepare(`
    SELECT id, brand_code, slug, brand_name, description, website_url, logo_url,
      sort_order, is_active, created_at, updated_at, row_version
    FROM catalog_brands
    ORDER BY is_active DESC, sort_order, id
    LIMIT 500
  `).all();
}

async function listProductBrands(database, productId) {
  return await database.prepare(`
    SELECT
      links.product_id,
      links.brand_id,
      links.is_primary,
      links.sort_order,
      links.created_at,
      brands.brand_code,
      brands.slug,
      brands.brand_name,
      brands.description,
      brands.website_url,
      brands.logo_url,
      brands.is_active,
      brands.row_version AS brand_row_version
    FROM catalog_product_brands AS links
    JOIN catalog_brands AS brands ON brands.id = links.brand_id
    WHERE links.product_id = ?
    ORDER BY links.sort_order, links.brand_id
  `).all(productId);
}

async function clearPrimaryMedia(database, productId, exceptMediaId, updatedAt) {
  await database.prepare(`
    UPDATE catalog_product_media
    SET media_usage = 'GALLERY', is_primary = 0, updated_at = ?, row_version = row_version + 1
    WHERE product_id = ? AND is_primary = 1 AND id <> ?
  `).run(writeDateTime(database, updatedAt), productId, exceptMediaId ?? -1);
}

async function clearPrimaryBrand(database, productId, exceptBrandId) {
  await database.prepare(`
    UPDATE catalog_product_brands
    SET is_primary = 0
    WHERE product_id = ? AND is_primary = 1 AND brand_id <> ?
  `).run(productId, exceptBrandId ?? -1);
}

async function touchProduct(database, productId, expectedVersion, actorId, updatedAt) {
  const update = await database.prepare(`
    UPDATE catalog_products
    SET updated_by_staff_user_id = ?, updated_at = ?, row_version = row_version + 1
    WHERE id = ? AND row_version = ?
  `).run(actorId, writeDateTime(database, updatedAt), productId, expectedVersion);
  return Number(update.changes) === 1;
}

export async function findProductContentRow({ databasePath, productId, locale }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectContent(database, productId, locale);
  } finally {
    database.close();
  }
}

export async function findProductSectionRow({ databasePath, productId, sectionId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectSection(database, productId, sectionId);
  } finally {
    database.close();
  }
}

export async function findProductSpecRow({ databasePath, productId, specId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectSpec(database, productId, specId);
  } finally {
    database.close();
  }
}

export async function findProductMediaRow({ databasePath, productId, mediaId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectMedia(database, productId, mediaId);
  } finally {
    database.close();
  }
}

export async function findBrandRow({ databasePath, brandId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectBrand(database, brandId);
  } finally {
    database.close();
  }
}

export async function listProductContentRows({ databasePath, productId, locale }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const content = await selectContent(database, productId, locale);
    if (!content) return null;
    return {
      content,
      sections: await listSections(database, productId, locale),
      specs: await listSpecs(database, productId, locale),
    };
  } finally {
    database.close();
  }
}

export async function listProductMediaRows({ databasePath, productId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await listMedia(database, productId);
  } finally {
    database.close();
  }
}

export async function listBrandRows({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await listBrands(database);
  } finally {
    database.close();
  }
}

export async function listProductBrandRows({ databasePath, productId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await listProductBrands(database, productId);
  } finally {
    database.close();
  }
}

export async function createProductContentRow({ databasePath, productId, values, createdAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      await database.prepare(`
        INSERT INTO catalog_product_content (
          product_id, locale, title, summary, body_text, seo_title, seo_description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId, values.locale, values.title, values.summary, values.bodyText,
        values.seoTitle, values.seoDescription,
        writeDateTime(database, createdAt), writeDateTime(database, createdAt),
      );
      const row = await selectContent(database, productId, values.locale);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateProductContentRow({
  databasePath, productId, locale, expectedVersion, values, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      const before = await selectContent(database, productId, locale);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE catalog_product_content
        SET title = ?, summary = ?, body_text = ?, seo_title = ?, seo_description = ?,
          updated_at = ?, row_version = row_version + 1
        WHERE product_id = ? AND locale = ? AND row_version = ?
      `).run(
        values.title, values.summary, values.bodyText, values.seoTitle, values.seoDescription,
        writeDateTime(database, updatedAt), productId, locale, expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const row = await selectContent(database, productId, locale);
      await afterWrite(database, before, row);
      return { kind: 'updated', row };
    });
  } finally {
    database.close();
  }
}

export async function createProductSectionRow({
  databasePath, productId, locale, values, createdAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      if (!await selectContent(database, productId, locale)) return { kind: 'content-not-found' };
      const result = await database.prepare(`
        INSERT INTO catalog_product_sections (
          product_id, locale, section_key, section_type, title, body_text,
          sort_order, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId, locale, values.sectionKey, values.sectionType, values.title, values.bodyText,
        values.sortOrder, values.isActive ? 1 : 0,
        writeDateTime(database, createdAt), writeDateTime(database, createdAt),
      );
      const row = await selectSection(database, productId, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateProductSectionRow({
  databasePath, productId, sectionId, expectedVersion, values, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      const before = await selectSection(database, productId, sectionId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE catalog_product_sections
        SET section_key = ?, section_type = ?, title = ?, body_text = ?, sort_order = ?,
          is_active = ?, updated_at = ?, row_version = row_version + 1
        WHERE product_id = ? AND id = ? AND row_version = ?
      `).run(
        values.sectionKey, values.sectionType, values.title, values.bodyText, values.sortOrder,
        values.isActive ? 1 : 0, writeDateTime(database, updatedAt), productId, sectionId, expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const row = await selectSection(database, productId, sectionId);
      await afterWrite(database, before, row);
      return { kind: 'updated', row };
    });
  } finally {
    database.close();
  }
}

export async function createProductSpecRow({
  databasePath, productId, locale, values, createdAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      if (!await selectContent(database, productId, locale)) return { kind: 'content-not-found' };
      const result = await database.prepare(`
        INSERT INTO catalog_product_specs (
          product_id, locale, spec_key, group_key, group_label, spec_label, spec_value,
          unit, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId, locale, values.specKey, values.groupKey, values.groupLabel, values.specLabel,
        values.specValue, values.unit, values.sortOrder,
        writeDateTime(database, createdAt), writeDateTime(database, createdAt),
      );
      const row = await selectSpec(database, productId, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateProductSpecRow({
  databasePath, productId, specId, expectedVersion, values, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      const before = await selectSpec(database, productId, specId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE catalog_product_specs
        SET spec_key = ?, group_key = ?, group_label = ?, spec_label = ?, spec_value = ?,
          unit = ?, sort_order = ?, updated_at = ?, row_version = row_version + 1
        WHERE product_id = ? AND id = ? AND row_version = ?
      `).run(
        values.specKey, values.groupKey, values.groupLabel, values.specLabel, values.specValue,
        values.unit, values.sortOrder, writeDateTime(database, updatedAt), productId, specId, expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const row = await selectSpec(database, productId, specId);
      await afterWrite(database, before, row);
      return { kind: 'updated', row };
    });
  } finally {
    database.close();
  }
}

export async function createProductMediaRow({
  databasePath, productId, values, createdAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      if (values.isPrimary) await clearPrimaryMedia(database, productId, null, createdAt);
      const result = await database.prepare(`
        INSERT INTO catalog_product_media (
          product_id, media_type, media_usage, url, alt_text, is_primary,
          sort_order, created_at, updated_at
        ) VALUES (?, 'IMAGE', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId, values.mediaUsage, values.url, values.altText, values.isPrimary ? 1 : 0,
        values.sortOrder, writeDateTime(database, createdAt), writeDateTime(database, createdAt),
      );
      const row = await selectMedia(database, productId, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateProductMediaRow({
  databasePath, productId, mediaId, expectedVersion, values, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      const before = await selectMedia(database, productId, mediaId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      if (values.isPrimary) await clearPrimaryMedia(database, productId, mediaId, updatedAt);
      const update = await database.prepare(`
        UPDATE catalog_product_media
        SET media_usage = ?, url = ?, alt_text = ?, is_primary = ?, sort_order = ?,
          updated_at = ?, row_version = row_version + 1
        WHERE product_id = ? AND id = ? AND row_version = ?
      `).run(
        values.mediaUsage, values.url, values.altText, values.isPrimary ? 1 : 0, values.sortOrder,
        writeDateTime(database, updatedAt), productId, mediaId, expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const row = await selectMedia(database, productId, mediaId);
      await afterWrite(database, before, row);
      return { kind: 'updated', row };
    });
  } finally {
    database.close();
  }
}

export async function deleteProductMediaRow({
  databasePath, productId, mediaId, expectedVersion, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await selectProduct(database, productId)) return { kind: 'product-not-found' };
      const before = await selectMedia(database, productId, mediaId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const deleted = await database.prepare(`
        DELETE FROM catalog_product_media
        WHERE product_id = ? AND id = ? AND row_version = ?
      `).run(productId, mediaId, expectedVersion);
      if (Number(deleted.changes) !== 1) return { kind: 'conflict' };
      await afterWrite(database, before);
      return { kind: 'deleted', row: before };
    });
  } finally {
    database.close();
  }
}

export async function createBrandRow({ databasePath, values, createdAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const result = await database.prepare(`
        INSERT INTO catalog_brands (
          brand_code, slug, brand_name, description, website_url, logo_url,
          sort_order, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.brandCode, values.slug, values.brandName, values.description, values.websiteUrl,
        values.logoUrl, values.sortOrder, values.isActive ? 1 : 0,
        writeDateTime(database, createdAt), writeDateTime(database, createdAt),
      );
      const row = await selectBrand(database, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateBrandRow({
  databasePath, brandId, expectedVersion, values, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectBrand(database, brandId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE catalog_brands
        SET brand_code = ?, slug = ?, brand_name = ?, description = ?, website_url = ?, logo_url = ?,
          sort_order = ?, is_active = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ? AND row_version = ?
      `).run(
        values.brandCode, values.slug, values.brandName, values.description, values.websiteUrl,
        values.logoUrl, values.sortOrder, values.isActive ? 1 : 0,
        writeDateTime(database, updatedAt), brandId, expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const row = await selectBrand(database, brandId);
      await afterWrite(database, before, row);
      return { kind: 'updated', row };
    });
  } finally {
    database.close();
  }
}

export async function createProductBrandRow({
  databasePath, productId, brandId, expectedProductVersion, values, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const product = await selectProduct(database, productId);
      if (!product) return { kind: 'product-not-found' };
      if (Number(product.row_version) !== expectedProductVersion) return { kind: 'product-conflict' };
      if (!await selectBrand(database, brandId)) return { kind: 'brand-not-found' };
      if (values.isPrimary) await clearPrimaryBrand(database, productId, brandId);
      await database.prepare(`
        INSERT INTO catalog_product_brands (product_id, brand_id, is_primary, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        productId, brandId, values.isPrimary ? 1 : 0, values.sortOrder,
        writeDateTime(database, updatedAt),
      );
      if (!await touchProduct(database, productId, expectedProductVersion, actorId, updatedAt)) {
        return { kind: 'product-conflict' };
      }
      const row = await selectProductBrand(database, productId, brandId);
      const afterProduct = await selectProduct(database, productId);
      await afterWrite(database, null, row, product, afterProduct);
      return { kind: 'created', row, product: afterProduct };
    });
  } finally {
    database.close();
  }
}

export async function updateProductBrandRow({
  databasePath, productId, brandId, expectedProductVersion, values, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const product = await selectProduct(database, productId);
      if (!product) return { kind: 'product-not-found' };
      if (Number(product.row_version) !== expectedProductVersion) return { kind: 'product-conflict' };
      const before = await selectProductBrand(database, productId, brandId);
      if (!before) return { kind: 'not-found' };
      if (values.isPrimary) await clearPrimaryBrand(database, productId, brandId);
      const update = await database.prepare(`
        UPDATE catalog_product_brands
        SET is_primary = ?, sort_order = ?
        WHERE product_id = ? AND brand_id = ?
      `).run(values.isPrimary ? 1 : 0, values.sortOrder, productId, brandId);
      if (Number(update.changes) !== 1) return { kind: 'not-found' };
      if (!await touchProduct(database, productId, expectedProductVersion, actorId, updatedAt)) {
        return { kind: 'product-conflict' };
      }
      const row = await selectProductBrand(database, productId, brandId);
      const afterProduct = await selectProduct(database, productId);
      await afterWrite(database, before, row, product, afterProduct);
      return { kind: 'updated', row, product: afterProduct };
    });
  } finally {
    database.close();
  }
}
