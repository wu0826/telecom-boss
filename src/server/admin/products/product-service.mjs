import {
  createCategoryRow,
  createProductRow,
  deleteProductRow,
  findCategoryRow,
  findProductRow,
  listCategoryRows,
  moveCategoryRow,
  searchProductRows,
  transitionProductPublicationRow,
  updateCategoryRow,
  updateProductRow,
} from './product-repository.mjs';

const CATEGORY_CREATE_FIELDS = new Set([
  'parentId', 'categoryCode', 'slug', 'categoryName', 'description', 'sortOrder', 'isActive',
]);
const CATEGORY_UPDATE_FIELDS = new Set([
  'expectedVersion', 'categoryCode', 'slug', 'categoryName', 'description', 'sortOrder', 'isActive',
]);
const CATEGORY_MOVE_FIELDS = new Set(['expectedVersion', 'parentId']);
const PRODUCT_CREATE_FIELDS = new Set([
  'productCode', 'slug', 'productName', 'productType', 'sourceId',
  'primaryCategoryId', 'sortOrder', 'isFeatured',
]);
const PRODUCT_UPDATE_FIELDS = new Set([...PRODUCT_CREATE_FIELDS, 'expectedVersion']);
const PRODUCT_PUBLISH_FIELDS = new Set(['expectedVersion', 'publishFrom', 'publishUntil']);
const VERSION_FIELDS = new Set(['expectedVersion']);
const PRODUCT_QUERY_FIELDS = new Set([
  'categoryId', 'direction', 'page', 'pageSize', 'q', 'sort', 'status', 'productType',
]);
const PRODUCT_TYPES = new Set(['SERVICE_PLAN', 'STOCK_ITEM', 'GENERAL']);
const PRODUCT_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']);
const PRODUCT_SORTS = new Set(['productCode', 'productName', 'status', 'updatedAt']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,49}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AdminProductError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminProductError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message, code = 'INVALID_BODY') {
  throw new AdminProductError(422, code, '商品資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, allowedFields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminProductError(422, 'INVALID_BODY', '請提供有效的 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw new AdminProductError(422, 'INVALID_BODY', '包含不允許的欄位。', unknown.map(
      (field) => ({ field, message: '此欄位不允許寫入。' }),
    ));
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(field, '必須為文字或 null。');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(field, `最多 ${maxLength} 個字元。`);
  return normalized;
}

function requiredCode(value, field) {
  const code = requiredText(value, field, 50);
  if (!CODE_PATTERN.test(code)) fail(field, '必須為大寫英數字、底線或連字號，且需以英文字母開頭。');
  return code;
}

function requiredSlug(value, field, maxLength) {
  const slug = requiredText(value, field, maxLength);
  if (!SLUG_PATTERN.test(slug)) fail(field, '必須為小寫英數字與連字號。');
  return slug;
}

function nonNegativeInteger(value, field, { max = 100_000, required = true } = {}) {
  if (!required && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(field, `必須為 0 至 ${max} 的整數。`);
  }
  return value;
}

function positiveId(value, field, notFoundCode, notFoundMessage) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AdminProductError(404, notFoundCode, notFoundMessage);
  }
  return normalized;
}

function requiredPositiveId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須為正整數。');
  return value;
}

function expectedVersion(payload) {
  if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1) {
    fail('expectedVersion', '必須為正整數。');
  }
  return payload.expectedVersion;
}

function isoTimestamp(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(field, '必須為 UTC ISO 8601 時間。');
  }
  if (new Date(value).toISOString() !== value) fail(field, '必須為 UTC ISO 8601 時間。');
  return value;
}

function currentIsoTimestamp(clock) {
  const timestamp = new Date(clock()).valueOf();
  if (Number.isNaN(timestamp)) throw new TypeError('Invalid product clock value');
  return new Date(timestamp).toISOString();
}

function mysqlUtcDatetime(isoValue) {
  return isoValue.slice(0, -1).replace('T', ' ');
}

function storedUtcTimestamp(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid stored product timestamp');
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) throw new TypeError('Invalid stored product timestamp');
  return timestamp;
}

function currentTimestamp(clock) {
  return mysqlUtcDatetime(currentIsoTimestamp(clock));
}

function nextTimestamp(clock, current = null) {
  const now = new Date(clock()).valueOf();
  if (Number.isNaN(now)) throw new TypeError('Invalid product clock value');
  const minimum = current === null ? now : storedUtcTimestamp(current) + 1;
  return mysqlUtcDatetime(new Date(Math.max(now, minimum)).toISOString());
}

function utcIso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function categoryValues(payload) {
  const parentId = payload.parentId;
  if (parentId !== null && parentId !== undefined) requiredPositiveId(parentId, 'parentId');
  if (typeof payload.isActive !== 'boolean') fail('isActive', '必須為布林值。');
  return {
    parentId: parentId ?? null,
    categoryCode: requiredCode(payload.categoryCode, 'categoryCode'),
    slug: requiredSlug(payload.slug, 'slug', 100),
    categoryName: requiredText(payload.categoryName, 'categoryName', 120),
    description: optionalText(payload.description, 'description', 1_000),
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
    isActive: payload.isActive,
  };
}

function sourceIdFor(row) {
  if (row.product_type === 'SERVICE_PLAN') return Number(row.service_plan_id);
  if (row.product_type === 'STOCK_ITEM') return Number(row.stock_item_id);
  return null;
}

function productValues(payload) {
  if (!PRODUCT_TYPES.has(payload.productType)) fail('productType', '值不允許。');
  const sourceId = payload.sourceId;
  if (payload.productType === 'GENERAL') {
    if (sourceId !== null && sourceId !== undefined) fail('sourceId', '一般商品不可連結營運來源。');
  } else {
    requiredPositiveId(sourceId, 'sourceId');
  }
  if (typeof payload.isFeatured !== 'boolean') fail('isFeatured', '必須為布林值。');
  return {
    productCode: requiredCode(payload.productCode, 'productCode'),
    slug: requiredSlug(payload.slug, 'slug', 120),
    productName: requiredText(payload.productName, 'productName', 200),
    productType: payload.productType,
    sourceId: payload.productType === 'GENERAL' ? null : sourceId,
    primaryCategoryId: requiredPositiveId(payload.primaryCategoryId, 'primaryCategoryId'),
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
    isFeatured: payload.isFeatured,
  };
}

function categoryValuesFromRow(row) {
  return {
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    categoryCode: row.category_code,
    slug: row.slug,
    categoryName: row.category_name,
    description: row.description,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function productValuesFromRow(row) {
  return {
    productCode: row.product_code,
    slug: row.slug,
    productName: row.product_name,
    productType: row.product_type,
    sourceId: sourceIdFor(row),
    primaryCategoryId: Number(row.primary_category_id),
    sortOrder: Number(row.sort_order),
    isFeatured: Boolean(row.is_featured),
  };
}

function categoryDto(row) {
  return {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    categoryCode: row.category_code,
    slug: row.slug,
    categoryName: row.category_name,
    description: row.description,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function sourceDto(row) {
  if (row.product_type === 'SERVICE_PLAN') {
    return {
      type: 'SERVICE_PLAN',
      id: Number(row.service_plan_id),
      code: row.source_plan_code,
      name: row.source_plan_name,
      isActive: Boolean(row.source_plan_is_active),
    };
  }
  if (row.product_type === 'STOCK_ITEM') {
    return {
      type: 'STOCK_ITEM',
      id: Number(row.stock_item_id),
      code: row.source_stock_sku,
      name: row.source_stock_name,
      isActive: Boolean(row.source_stock_is_active),
    };
  }
  return null;
}

function productDto(row) {
  return {
    id: Number(row.id),
    productCode: row.product_code,
    slug: row.slug,
    productName: row.product_name,
    productType: row.product_type,
    source: sourceDto(row),
    status: row.status,
    sortOrder: Number(row.sort_order),
    isFeatured: Boolean(row.is_featured),
    publishFrom: utcIso(row.publish_from),
    publishUntil: utcIso(row.publish_until),
    primaryCategory: row.primary_category_id === null ? null : {
      id: Number(row.primary_category_id),
      categoryCode: row.primary_category_code,
      slug: row.primary_category_slug,
      categoryName: row.primary_category_name,
      isActive: Boolean(row.primary_category_is_active),
    },
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function categoryTree(rows) {
  const nodes = new Map(rows.map((row) => {
    const node = { ...categoryDto(row), children: [] };
    return [node.id, node];
  }));
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(node.parentId);
    if (parent) parent.children.push(node);
  }
  return roots;
}

function parseProductQuery(params) {
  for (const field of params.keys()) {
    if (!PRODUCT_QUERY_FIELDS.has(field)) fail(field, '此查詢欄位不允許。', 'INVALID_QUERY');
  }
  const keyword = (params.get('q') ?? '').trim();
  if (keyword.length > 100) fail('q', '最多 100 個字元。', 'INVALID_QUERY');
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 20);
  if (!Number.isSafeInteger(page) || page < 1) fail('page', '必須為正整數。', 'INVALID_QUERY');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    fail('pageSize', '必須為 1 至 100。', 'INVALID_QUERY');
  }
  const status = params.get('status');
  if (status !== null && !PRODUCT_STATUSES.has(status)) fail('status', '值不允許。', 'INVALID_QUERY');
  const productType = params.get('productType');
  if (productType !== null && !PRODUCT_TYPES.has(productType)) {
    fail('productType', '值不允許。', 'INVALID_QUERY');
  }
  const categoryParam = params.get('categoryId');
  const categoryId = categoryParam === null ? null : Number(categoryParam);
  if (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId < 1)) {
    fail('categoryId', '必須為正整數。', 'INVALID_QUERY');
  }
  const sort = params.get('sort') || 'updatedAt';
  if (!PRODUCT_SORTS.has(sort)) fail('sort', '值不允許。', 'INVALID_QUERY');
  const direction = params.get('direction') || 'desc';
  if (!['asc', 'desc'].includes(direction)) fail('direction', '值不允許。', 'INVALID_QUERY');
  return { keyword, page, pageSize, status, productType, categoryId, sort, direction };
}

function mapCategoryResult(result) {
  if (result.kind === 'not-found' || result.kind === 'parent-not-found') {
    throw new AdminProductError(404, 'CATEGORY_NOT_FOUND', '找不到分類。');
  }
  if (result.kind === 'conflict') throw new AdminProductError(409, 'CATEGORY_CONFLICT', '分類已被其他人更新。');
  if (result.kind === 'parent-inactive') {
    throw new AdminProductError(422, 'CATEGORY_PARENT_INACTIVE', '無法放入停用的上層分類。', [
      { field: 'parentId', message: '請選擇啟用中的上層分類。' },
    ]);
  }
  return result;
}

function mapProductResult(result) {
  if (result.kind === 'not-found') throw new AdminProductError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
  if (result.kind === 'conflict') throw new AdminProductError(409, 'PRODUCT_CONFLICT', '商品已被其他人更新。');
  if (result.kind === 'delete-not-allowed') {
    throw new AdminProductError(422, 'PRODUCT_DELETE_NOT_ALLOWED', '只有草稿或已封存商品可以永久刪除。', [
      { field: 'status', message: '請先封存已發布或已排程商品。' },
    ]);
  }
  if (result.kind === 'category-not-found') {
    throw new AdminProductError(422, 'INVALID_CATEGORY', '商品分類不存在。', [
      { field: 'primaryCategoryId', message: '請選擇存在的分類。' },
    ]);
  }
  if (result.kind === 'invalid-source') {
    throw new AdminProductError(422, 'INVALID_SOURCE', '商品來源不存在或類型不符。', [
      { field: 'sourceId', message: '請選擇存在的服務方案或庫存品項。' },
    ]);
  }
  if (result.kind === 'category-not-publishable') {
    throw new AdminProductError(422, 'CATEGORY_NOT_PUBLISHABLE', '商品分類或上層分類未啟用。', [
      { field: 'primaryCategoryId', message: '請先啟用商品分類與所有上層分類。' },
    ]);
  }
  if (result.kind === 'source-not-publishable') {
    throw new AdminProductError(422, 'SOURCE_NOT_PUBLISHABLE', '商品來源目前不可公開。', [
      { field: 'sourceId', message: '請先啟用來源方案或可售庫存品項。' },
    ]);
  }
  return result;
}

function mapDatabaseError(error, type) {
  const message = error?.message ?? '';
  if (/catalog category cycle is not allowed/i.test(message)) {
    throw new AdminProductError(422, 'CATEGORY_CYCLE', '分類不可移動到自己的子分類。', [
      { field: 'parentId', message: '請選擇非子分類的上層分類。' },
    ]);
  }
  if (/catalog category maximum depth is 4/i.test(message)) {
    throw new AdminProductError(422, 'CATEGORY_MAX_DEPTH', '分類最多只能有四層。', [
      { field: 'parentId', message: '請選擇較上層的分類。' },
    ]);
  }
  if (/UNIQUE constraint failed: catalog_categories\.category_code/i.test(message)) {
    throw new AdminProductError(409, 'CATEGORY_CODE_CONFLICT', '分類代碼已存在。', [
      { field: 'categoryCode', message: '分類代碼不可重複。' },
    ]);
  }
  if (/UNIQUE constraint failed: catalog_categories\.slug/i.test(message)) {
    throw new AdminProductError(409, 'CATEGORY_SLUG_CONFLICT', '分類網址代稱已存在。', [
      { field: 'slug', message: '網址代稱不可重複。' },
    ]);
  }
  if (/UNIQUE constraint failed: catalog_products\.product_code/i.test(message)) {
    throw new AdminProductError(409, 'PRODUCT_CODE_CONFLICT', '商品代碼已存在。', [
      { field: 'productCode', message: '商品代碼不可重複。' },
    ]);
  }
  if (/UNIQUE constraint failed: catalog_products\.slug/i.test(message)) {
    throw new AdminProductError(409, 'PRODUCT_SLUG_CONFLICT', '商品網址代稱已存在。', [
      { field: 'slug', message: '網址代稱不可重複。' },
    ]);
  }
  if (/UNIQUE constraint failed: catalog_products\.(service_plan_id|stock_item_id)/i.test(message)) {
    throw new AdminProductError(409, 'PRODUCT_SOURCE_CONFLICT', '此營運來源已連結其他商品。', [
      { field: 'sourceId', message: '每個來源只能連結一個商品。' },
    ]);
  }
  if (type === 'category') throw error;
  throw error;
}

function categoryAudit(row) {
  return {
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    categoryCode: row.category_code,
    slug: row.slug,
    categoryName: row.category_name,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function productAudit(row) {
  return {
    productCode: row.product_code,
    slug: row.slug,
    productName: row.product_name,
    productType: row.product_type,
    sourceId: sourceIdFor(row),
    status: row.status,
    sortOrder: Number(row.sort_order),
    isFeatured: Boolean(row.is_featured),
    publishFrom: utcIso(row.publish_from),
    publishUntil: utcIso(row.publish_until),
  };
}

export function createAdminProductService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    ...event,
  }, { database });
  const writeTimestamp = (row) => nextTimestamp(clock, row?.updated_at ?? null);

  return {
    async listCategories() {
      return categoryTree((await listCategoryRows({ databasePath })));
    },
    async categoryDetail(categoryIdValue) {
      const categoryId = positiveId(categoryIdValue, 'id', 'CATEGORY_NOT_FOUND', '找不到分類。');
      const row = (await findCategoryRow({ databasePath, categoryId }));
      if (!row) throw new AdminProductError(404, 'CATEGORY_NOT_FOUND', '找不到分類。');
      return categoryDto(row);
    },
    async createCategory(payload, actor, requestAudit = {}) {
      objectPayload(payload, CATEGORY_CREATE_FIELDS);
      const values = categoryValues(payload);
      try {
        const result = mapCategoryResult((await createCategoryRow({
          databasePath,
          values,
          actorId: actor.id,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'CATEGORY_CREATED', entityType: 'CATALOG_CATEGORY', entityId: String(row.id),
              after: categoryAudit(row),
              allowedFields: ['parentId', 'categoryCode', 'slug', 'categoryName', 'sortOrder', 'isActive'],
            }, database);
          },
        })));
        return categoryDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'category');
      }
    },
    async updateCategory(categoryIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, CATEGORY_UPDATE_FIELDS);
      const categoryId = positiveId(categoryIdValue, 'id', 'CATEGORY_NOT_FOUND', '找不到分類。');
      const before = (await findCategoryRow({ databasePath, categoryId }));
      if (!before) throw new AdminProductError(404, 'CATEGORY_NOT_FOUND', '找不到分類。');
      const expected = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個分類欄位。');
      const values = categoryValues({ ...categoryValuesFromRow(before), ...payload });
      try {
        const result = mapCategoryResult((await updateCategoryRow({
          databasePath,
          categoryId,
          expectedVersion: expected,
          values,
          actorId: actor.id,
          updatedAt: writeTimestamp(before),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'CATEGORY_UPDATED', entityType: 'CATALOG_CATEGORY', entityId: String(categoryId),
              before: categoryAudit(previous), after: categoryAudit(after),
              allowedFields: ['parentId', 'categoryCode', 'slug', 'categoryName', 'sortOrder', 'isActive'],
            }, database);
          },
        })));
        return categoryDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'category');
      }
    },
    async moveCategory(categoryIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, CATEGORY_MOVE_FIELDS);
      const categoryId = positiveId(categoryIdValue, 'id', 'CATEGORY_NOT_FOUND', '找不到分類。');
      const before = (await findCategoryRow({ databasePath, categoryId }));
      if (!before) throw new AdminProductError(404, 'CATEGORY_NOT_FOUND', '找不到分類。');
      const expected = expectedVersion(payload);
      const parentId = payload.parentId;
      if (parentId !== null && parentId !== undefined) requiredPositiveId(parentId, 'parentId');
      try {
        const result = mapCategoryResult((await moveCategoryRow({
          databasePath,
          categoryId,
          parentId: parentId ?? null,
          expectedVersion: expected,
          actorId: actor.id,
          updatedAt: writeTimestamp(before),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'CATEGORY_MOVED', entityType: 'CATALOG_CATEGORY', entityId: String(categoryId),
              before: categoryAudit(previous), after: categoryAudit(after),
              allowedFields: ['parentId', 'categoryCode', 'slug', 'categoryName', 'sortOrder', 'isActive'],
            }, database);
          },
        })));
        return categoryDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'category');
      }
    },
    async listProducts(params) {
      const query = parseProductQuery(params);
      const { rows, total } = (await searchProductRows({ databasePath, query }));
      return { data: rows.map(productDto), page: query.page, pageSize: query.pageSize, total };
    },
    async productDetail(productIdValue) {
      const productId = positiveId(productIdValue, 'id', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const row = (await findProductRow({ databasePath, productId }));
      if (!row) throw new AdminProductError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
      return productDto(row);
    },
    async createProduct(payload, actor, requestAudit = {}) {
      objectPayload(payload, PRODUCT_CREATE_FIELDS);
      const values = productValues(payload);
      try {
        const result = mapProductResult((await createProductRow({
          databasePath,
          values,
          actorId: actor.id,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_CREATED', entityType: 'CATALOG_PRODUCT', entityId: String(row.id),
              after: productAudit(row),
              allowedFields: [
                'productCode', 'slug', 'productName', 'productType', 'sourceId', 'status',
                'sortOrder', 'isFeatured', 'publishFrom', 'publishUntil',
              ],
            }, database);
          },
        })));
        return productDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'product');
      }
    },
    async updateProduct(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, PRODUCT_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'id', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const before = (await findProductRow({ databasePath, productId }));
      if (!before) throw new AdminProductError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
      const expected = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個商品欄位。');
      const values = productValues({ ...productValuesFromRow(before), ...payload });
      try {
        const result = mapProductResult((await updateProductRow({
          databasePath,
          productId,
          expectedVersion: expected,
          values,
          actorId: actor.id,
          updatedAt: writeTimestamp(before),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_UPDATED', entityType: 'CATALOG_PRODUCT', entityId: String(productId),
              before: productAudit(previous), after: productAudit(after),
              allowedFields: [
                'productCode', 'slug', 'productName', 'productType', 'sourceId', 'status',
                'sortOrder', 'isFeatured', 'publishFrom', 'publishUntil',
              ],
            }, database);
          },
        })));
        return productDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'product');
      }
    },
    async deleteProduct(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const productId = positiveId(productIdValue, 'id', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const expected = expectedVersion(payload);
      try {
        const result = mapProductResult((await deleteProductRow({
          databasePath,
          productId,
          expectedVersion: expected,
          async afterWrite(database, previous) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_DELETED', entityType: 'CATALOG_PRODUCT', entityId: String(productId),
              before: productAudit(previous),
              allowedFields: [
                'productCode', 'slug', 'productName', 'productType', 'sourceId', 'status',
                'sortOrder', 'isFeatured', 'publishFrom', 'publishUntil',
              ],
            }, database);
          },
        })));
        return { deleted: true, id: Number(result.row.id) };
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'product');
      }
    },
    async publishProduct(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, PRODUCT_PUBLISH_FIELDS);
      const productId = positiveId(productIdValue, 'id', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const before = (await findProductRow({ databasePath, productId }));
      if (!before) throw new AdminProductError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
      const expected = expectedVersion(payload);
      const now = currentIsoTimestamp(clock);
      const publishFrom = isoTimestamp(payload.publishFrom, 'publishFrom');
      const publishUntil = isoTimestamp(payload.publishUntil, 'publishUntil');
      const effectiveFrom = publishFrom ?? now;
      if (publishUntil !== null && publishUntil <= effectiveFrom) {
        fail('publishUntil', '必須晚於發布時間。');
      }
      const status = publishFrom !== null && publishFrom > now ? 'SCHEDULED' : 'PUBLISHED';
      const storedPublishFrom = publishFrom === null ? null : mysqlUtcDatetime(publishFrom);
      const storedPublishUntil = publishUntil === null ? null : mysqlUtcDatetime(publishUntil);
      try {
        const result = mapProductResult((await transitionProductPublicationRow({
          databasePath,
          productId,
          expectedVersion: expected,
          status,
          publishFrom: storedPublishFrom,
          publishUntil: storedPublishUntil,
          actorId: actor.id,
          updatedAt: writeTimestamp(before),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: status === 'SCHEDULED' ? 'PRODUCT_SCHEDULED' : 'PRODUCT_PUBLISHED',
              entityType: 'CATALOG_PRODUCT', entityId: String(productId),
              before: productAudit(previous), after: productAudit(after),
              allowedFields: [
                'productCode', 'slug', 'productName', 'productType', 'sourceId', 'status',
                'sortOrder', 'isFeatured', 'publishFrom', 'publishUntil',
              ],
            }, database);
          },
        })));
        return productDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'product');
      }
    },
    async archiveProduct(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const productId = positiveId(productIdValue, 'id', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const before = (await findProductRow({ databasePath, productId }));
      if (!before) throw new AdminProductError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
      const expected = expectedVersion(payload);
      try {
        const result = mapProductResult((await transitionProductPublicationRow({
          databasePath,
          productId,
          expectedVersion: expected,
          status: 'ARCHIVED',
          publishFrom: before.publish_from,
          publishUntil: before.publish_until,
          actorId: actor.id,
          updatedAt: writeTimestamp(before),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_ARCHIVED', entityType: 'CATALOG_PRODUCT', entityId: String(productId),
              before: productAudit(previous), after: productAudit(after),
              allowedFields: [
                'productCode', 'slug', 'productName', 'productType', 'sourceId', 'status',
                'sortOrder', 'isFeatured', 'publishFrom', 'publishUntil',
              ],
            }, database);
          },
        })));
        return productDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductError) throw error;
        mapDatabaseError(error, 'product');
      }
    },
  };
}
