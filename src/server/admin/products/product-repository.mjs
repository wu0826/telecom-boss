import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const PRODUCT_SORT_COLUMNS = Object.freeze({
  productCode: 'products.product_code',
  productName: 'products.product_name',
  status: 'products.status',
  updatedAt: 'products.updated_at',
});

function escapeLike(value) {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

async function selectCategory(database, categoryId) {
  return await database.prepare(`
    SELECT id, parent_id, category_code, slug, category_name, description,
      sort_order, is_active, created_at, updated_at, row_version
    FROM catalog_categories
    WHERE id = ?
  `).get(categoryId) ?? null;
}

async function selectProduct(database, productId) {
  return await database.prepare(`
    SELECT
      products.id,
      products.product_code,
      products.slug,
      products.product_name,
      products.product_type,
      products.service_plan_id,
      products.stock_item_id,
      products.status,
      products.sort_order,
      products.is_featured,
      products.publish_from,
      products.publish_until,
      products.created_at,
      products.updated_at,
      products.row_version,
      categories.id AS primary_category_id,
      categories.category_code AS primary_category_code,
      categories.slug AS primary_category_slug,
      categories.category_name AS primary_category_name,
      categories.is_active AS primary_category_is_active,
      service_plans.plan_code AS source_plan_code,
      service_plans.plan_name AS source_plan_name,
      service_plans.is_active AS source_plan_is_active,
      stock_items.sku AS source_stock_sku,
      stock_items.item_name AS source_stock_name,
      stock_items.is_active AS source_stock_is_active,
      stock_items.selling_price AS source_stock_selling_price
    FROM catalog_products AS products
    LEFT JOIN catalog_product_categories AS product_categories
      ON product_categories.product_id = products.id
      AND product_categories.is_primary = 1
    LEFT JOIN catalog_categories AS categories
      ON categories.id = product_categories.category_id
    LEFT JOIN service_plans ON service_plans.id = products.service_plan_id
    LEFT JOIN stock_items ON stock_items.id = products.stock_item_id
    WHERE products.id = ?
  `).get(productId) ?? null;
}

async function sourceExists(database, productType, sourceId) {
  if (productType === 'GENERAL') return true;
  const table = productType === 'SERVICE_PLAN' ? 'service_plans' : 'stock_items';
  return Boolean(await database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(sourceId));
}

async function parentIsActive(database, parentId) {
  if (parentId === null) return true;
  const parent = await selectCategory(database, parentId);
  if (!parent) return null;
  return Boolean(parent.is_active);
}

async function primaryCategoryIsLive(database, productId) {
  const rows = await database.prepare(`
    WITH RECURSIVE category_path(id, parent_id, is_active) AS (
      SELECT categories.id, categories.parent_id, categories.is_active
      FROM catalog_product_categories AS product_categories
      JOIN catalog_categories AS categories ON categories.id = product_categories.category_id
      WHERE product_categories.product_id = ?
        AND product_categories.is_primary = 1
      UNION ALL
      SELECT categories.id, categories.parent_id, categories.is_active
      FROM catalog_categories AS categories
      JOIN category_path ON category_path.parent_id = categories.id
    )
    SELECT id, is_active FROM category_path
  `).all(productId);
  return rows.length > 0 && rows.every((row) => Boolean(row.is_active));
}

async function sourceIsPublishable(database, product) {
  if (product.product_type === 'GENERAL') return true;
  if (product.product_type === 'SERVICE_PLAN') {
    const row = await database.prepare('SELECT is_active FROM service_plans WHERE id = ?').get(product.service_plan_id);
    return Boolean(row?.is_active);
  }
  const row = await database.prepare(`
    SELECT is_active, selling_price
    FROM stock_items
    WHERE id = ?
  `).get(product.stock_item_id);
  return Boolean(row?.is_active) && Number(row.selling_price) > 0;
}

async function writeCategory(database, values, actorId, createdAt, updatedAt) {
  const result = await database.prepare(`
    INSERT INTO catalog_categories (
      parent_id, category_code, slug, category_name, description,
      sort_order, is_active, created_by_staff_user_id, updated_by_staff_user_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.parentId,
    values.categoryCode,
    values.slug,
    values.categoryName,
    values.description,
    values.sortOrder,
    values.isActive ? 1 : 0,
    actorId,
    actorId,
    createdAt,
    updatedAt,
  );
  return await selectCategory(database, Number(result.lastInsertRowid));
}

export async function listCategoryRows({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      SELECT id, parent_id, category_code, slug, category_name, description,
        sort_order, is_active, created_at, updated_at, row_version
      FROM catalog_categories
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
      LIMIT 500
    `).all();
  } finally {
    database.close();
  }
}

export async function findCategoryRow({ databasePath, categoryId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectCategory(database, categoryId);
  } finally {
    database.close();
  }
}

export async function createCategoryRow({ databasePath, values, actorId, createdAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const parentActive = await parentIsActive(database, values.parentId);
      if (parentActive === null) return { kind: 'parent-not-found' };
      if (!parentActive) return { kind: 'parent-inactive' };
      const row = await writeCategory(database, values, actorId, createdAt, createdAt);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateCategoryRow({
  databasePath,
  categoryId,
  expectedVersion,
  values,
  actorId,
  updatedAt,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectCategory(database, categoryId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE catalog_categories
        SET category_code = ?, slug = ?, category_name = ?, description = ?,
          sort_order = ?, is_active = ?, updated_by_staff_user_id = ?, updated_at = ?,
          row_version = row_version + 1
        WHERE id = ? AND row_version = ?
      `).run(
        values.categoryCode,
        values.slug,
        values.categoryName,
        values.description,
        values.sortOrder,
        values.isActive ? 1 : 0,
        actorId,
        updatedAt,
        categoryId,
        expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectCategory(database, categoryId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function moveCategoryRow({
  databasePath,
  categoryId,
  parentId,
  expectedVersion,
  actorId,
  updatedAt,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectCategory(database, categoryId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const parentActive = await parentIsActive(database, parentId);
      if (parentActive === null) return { kind: 'parent-not-found' };
      if (!parentActive) return { kind: 'parent-inactive' };
      const update = await database.prepare(`
        UPDATE catalog_categories
        SET parent_id = ?, updated_by_staff_user_id = ?, updated_at = ?,
          row_version = row_version + 1
        WHERE id = ? AND row_version = ?
      `).run(parentId, actorId, updatedAt, categoryId, expectedVersion);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectCategory(database, categoryId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function searchProductRows({ databasePath, query }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const clauses = [];
    const values = [];
    if (query.keyword) {
      const keyword = `%${await escapeLike(query.keyword)}%`;
      clauses.push(`(
        products.product_code LIKE ? ESCAPE '!'
        OR products.product_name LIKE ? ESCAPE '!'
        OR products.slug LIKE ? ESCAPE '!'
      )`);
      values.push(keyword, keyword, keyword);
    }
    if (query.status !== null) {
      clauses.push('products.status = ?');
      values.push(query.status);
    }
    if (query.productType !== null) {
      clauses.push('products.product_type = ?');
      values.push(query.productType);
    }
    if (query.categoryId !== null) {
      clauses.push('product_categories.category_id = ?');
      values.push(query.categoryId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((await database.prepare(`
      SELECT COUNT(*) AS count
      FROM catalog_products AS products
      LEFT JOIN catalog_product_categories AS product_categories
        ON product_categories.product_id = products.id
        AND product_categories.is_primary = 1
      ${where}
    `).get(...values)).count);
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.pageSize;
    const rows = await database.prepare(`
      SELECT
        products.id,
        products.product_code,
        products.slug,
        products.product_name,
        products.product_type,
        products.service_plan_id,
        products.stock_item_id,
        products.status,
        products.sort_order,
        products.is_featured,
        products.publish_from,
        products.publish_until,
        products.created_at,
        products.updated_at,
        products.row_version,
        categories.id AS primary_category_id,
        categories.category_code AS primary_category_code,
        categories.slug AS primary_category_slug,
        categories.category_name AS primary_category_name,
        categories.is_active AS primary_category_is_active,
        service_plans.plan_code AS source_plan_code,
        service_plans.plan_name AS source_plan_name,
        service_plans.is_active AS source_plan_is_active,
        stock_items.sku AS source_stock_sku,
        stock_items.item_name AS source_stock_name,
        stock_items.is_active AS source_stock_is_active,
        stock_items.selling_price AS source_stock_selling_price
      FROM catalog_products AS products
      LEFT JOIN catalog_product_categories AS product_categories
        ON product_categories.product_id = products.id
        AND product_categories.is_primary = 1
      LEFT JOIN catalog_categories AS categories ON categories.id = product_categories.category_id
      LEFT JOIN service_plans ON service_plans.id = products.service_plan_id
      LEFT JOIN stock_items ON stock_items.id = products.stock_item_id
      ${where}
      ORDER BY ${PRODUCT_SORT_COLUMNS[query.sort]} ${direction}, products.id ${direction}
      LIMIT ? OFFSET ?
    `).all(...values, query.pageSize, offset);
    return { rows, total };
  } finally {
    database.close();
  }
}

export async function findProductRow({ databasePath, productId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectProduct(database, productId);
  } finally {
    database.close();
  }
}

async function writePrimaryCategory(database, productId, categoryId) {
  const category = await selectCategory(database, categoryId);
  if (!category) return { kind: 'category-not-found' };
  await database.prepare(`
    UPDATE catalog_product_categories
    SET is_primary = 0
    WHERE product_id = ? AND is_primary = 1
  `).run(productId);
  const existing = await database.prepare(`
    UPDATE catalog_product_categories
    SET is_primary = 1
    WHERE product_id = ? AND category_id = ?
  `).run(productId, categoryId);
  if (Number(existing.changes) === 0) {
    await database.prepare(`
      INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
      VALUES (?, ?, 1, 0)
    `).run(productId, categoryId);
  }
  return { kind: 'updated' };
}

async function writeProductDefinition(database, productId, values, actorId, updatedAt, expectedVersion) {
  const sourceExistsForType = await sourceExists(database, values.productType, values.sourceId);
  if (!sourceExistsForType) return { kind: 'invalid-source' };
  const update = await database.prepare(`
    UPDATE catalog_products
    SET product_code = ?, slug = ?, product_name = ?, product_type = ?,
      service_plan_id = ?, stock_item_id = ?, sort_order = ?, is_featured = ?,
      updated_by_staff_user_id = ?, updated_at = ?, row_version = row_version + 1
    WHERE id = ? AND row_version = ?
  `).run(
    values.productCode,
    values.slug,
    values.productName,
    values.productType,
    values.productType === 'SERVICE_PLAN' ? values.sourceId : null,
    values.productType === 'STOCK_ITEM' ? values.sourceId : null,
    values.sortOrder,
    values.isFeatured ? 1 : 0,
    actorId,
    updatedAt,
    productId,
    expectedVersion,
  );
  if (Number(update.changes) !== 1) return { kind: 'conflict' };
  const categoryResult = await writePrimaryCategory(database, productId, values.primaryCategoryId);
  if (categoryResult.kind !== 'updated') return categoryResult;
  return { kind: 'updated' };
}

export async function createProductRow({ databasePath, values, actorId, createdAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await sourceExists(database, values.productType, values.sourceId)) return { kind: 'invalid-source' };
      const category = await selectCategory(database, values.primaryCategoryId);
      if (!category) return { kind: 'category-not-found' };
      const result = await database.prepare(`
        INSERT INTO catalog_products (
          product_code, slug, product_name, product_type, service_plan_id, stock_item_id,
          status, sort_order, is_featured, created_by_staff_user_id, updated_by_staff_user_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
      `).run(
        values.productCode,
        values.slug,
        values.productName,
        values.productType,
        values.productType === 'SERVICE_PLAN' ? values.sourceId : null,
        values.productType === 'STOCK_ITEM' ? values.sourceId : null,
        values.sortOrder,
        values.isFeatured ? 1 : 0,
        actorId,
        actorId,
        createdAt,
        createdAt,
      );
      const productId = Number(result.lastInsertRowid);
      await database.prepare(`
        INSERT INTO catalog_product_categories (product_id, category_id, is_primary, sort_order)
        VALUES (?, ?, 1, 0)
      `).run(productId, values.primaryCategoryId);
      const row = await selectProduct(database, productId);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateProductRow({
  databasePath,
  productId,
  expectedVersion,
  values,
  actorId,
  updatedAt,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectProduct(database, productId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      const update = await writeProductDefinition(
        database, productId, values, actorId, updatedAt, expectedVersion,
      );
      if (update.kind !== 'updated') return update;
      const after = await selectProduct(database, productId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function deleteProductRow({
  databasePath,
  productId,
  expectedVersion,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectProduct(database, productId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      if (!['DRAFT', 'ARCHIVED'].includes(before.status)) return { kind: 'delete-not-allowed' };
      const deletion = await database.prepare(`
        DELETE FROM catalog_products
        WHERE id = ? AND row_version = ? AND status IN ('DRAFT', 'ARCHIVED')
      `).run(productId, expectedVersion);
      if (Number(deletion.changes) !== 1) return { kind: 'conflict' };
      await afterWrite(database, before);
      return { kind: 'deleted', row: before };
    });
  } finally {
    database.close();
  }
}

export async function transitionProductPublicationRow({
  databasePath,
  productId,
  expectedVersion,
  status,
  publishFrom,
  publishUntil,
  actorId,
  updatedAt,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectProduct(database, productId);
      if (!before) return { kind: 'not-found' };
      if (Number(before.row_version) !== expectedVersion) return { kind: 'conflict' };
      if (status !== 'ARCHIVED' && !await primaryCategoryIsLive(database, productId)) {
        return { kind: 'category-not-publishable' };
      }
      if (status !== 'ARCHIVED' && !await sourceIsPublishable(database, before)) {
        return { kind: 'source-not-publishable' };
      }
      const update = await database.prepare(`
        UPDATE catalog_products
        SET status = ?, publish_from = ?, publish_until = ?,
          updated_by_staff_user_id = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ? AND row_version = ?
      `).run(
        status,
        publishFrom,
        publishUntil,
        actorId,
        updatedAt,
        productId,
        expectedVersion,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectProduct(database, productId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}
