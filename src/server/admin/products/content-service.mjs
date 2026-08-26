import { findProductRow } from './product-repository.mjs';
import {
  createBrandRow,
  createProductBrandRow,
  createProductContentRow,
  createProductMediaRow,
  createProductSectionRow,
  createProductSpecRow,
  deleteProductMediaRow,
  findBrandRow,
  findProductContentRow,
  findProductMediaRow,
  findProductSectionRow,
  findProductSpecRow,
  listBrandRows,
  listProductBrandRows,
  listProductContentRows,
  listProductMediaRows,
  updateBrandRow,
  updateProductBrandRow,
  updateProductContentRow,
  updateProductMediaRow,
  updateProductSectionRow,
  updateProductSpecRow,
} from './content-repository.mjs';

const CONTENT_CREATE_FIELDS = new Set([
  'locale', 'title', 'summary', 'bodyText', 'seoTitle', 'seoDescription',
]);
const CONTENT_UPDATE_FIELDS = new Set([
  'expectedVersion', 'title', 'summary', 'bodyText', 'seoTitle', 'seoDescription',
]);
const SECTION_CREATE_FIELDS = new Set([
  'sectionKey', 'sectionType', 'title', 'bodyText', 'sortOrder', 'isActive',
]);
const SECTION_UPDATE_FIELDS = new Set([
  'expectedVersion', 'sectionKey', 'sectionType', 'title', 'bodyText', 'sortOrder', 'isActive',
]);
const SPEC_CREATE_FIELDS = new Set([
  'specKey', 'groupKey', 'groupLabel', 'specLabel', 'specValue', 'unit', 'sortOrder',
]);
const SPEC_UPDATE_FIELDS = new Set([
  'expectedVersion', 'specKey', 'groupKey', 'groupLabel', 'specLabel', 'specValue', 'unit', 'sortOrder',
]);
const MEDIA_CREATE_FIELDS = new Set(['mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder']);
const MEDIA_UPDATE_FIELDS = new Set([
  'expectedVersion', 'mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder',
]);
const MEDIA_DELETE_FIELDS = new Set(['expectedVersion']);
const BRAND_CREATE_FIELDS = new Set([
  'brandCode', 'slug', 'brandName', 'description', 'websiteUrl', 'logoUrl', 'sortOrder', 'isActive',
]);
const BRAND_UPDATE_FIELDS = new Set([
  'expectedVersion', 'brandCode', 'slug', 'brandName', 'description', 'websiteUrl', 'logoUrl', 'sortOrder', 'isActive',
]);
const BRAND_LINK_CREATE_FIELDS = new Set(['brandId', 'isPrimary', 'sortOrder', 'expectedProductVersion']);
const BRAND_LINK_UPDATE_FIELDS = new Set(['isPrimary', 'sortOrder', 'expectedProductVersion']);
const SECTION_TYPES = new Set(['TEXT', 'FEATURE_LIST', 'NOTICE']);
const MEDIA_USAGES = new Set(['PRIMARY', 'GALLERY', 'ICON', 'BANNER']);
const HTML_TAG_PATTERN = /<\s*\/?\s*[a-z][^>]*>/i;
const LOCALE_PATTERN = /^[A-Za-z0-9-]{2,10}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,49}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AdminProductContentError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminProductContentError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message, code = 'INVALID_BODY') {
  throw new AdminProductContentError(422, code, '商品展示資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, allowedFields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminProductContentError(422, 'INVALID_BODY', '請提供有效的 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw new AdminProductContentError(422, 'INVALID_BODY', '包含不允許的欄位。', unknown.map(
      (field) => ({ field, message: '此欄位不允許寫入。' }),
    ));
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  if (HTML_TAG_PATTERN.test(normalized)) {
    fail(field, '僅能輸入純文字，不可包含 HTML 標籤。', 'UNSAFE_CONTENT');
  }
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, field, maxLength);
}

function requiredLocale(value) {
  const locale = requiredText(value, 'locale', 10);
  if (!LOCALE_PATTERN.test(locale)) fail('locale', '請使用 2 至 10 碼的語系代碼，例如 zh-TW。');
  return locale;
}

function requiredIdentifier(value, field, maxLength = 80) {
  const identifier = requiredText(value, field, maxLength);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    fail(field, '必須為小寫英數字、底線或連字號，且需以英文字母開頭。');
  }
  return identifier;
}

function requiredCode(value, field) {
  const code = requiredText(value, field, 50);
  if (!CODE_PATTERN.test(code)) {
    fail(field, '必須為大寫英數字、底線或連字號，且需以英文字母開頭。');
  }
  return code;
}

function requiredSlug(value, field) {
  const slug = requiredText(value, field, 100);
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

function positiveId(value, field, code, message) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AdminProductContentError(404, code, message);
  }
  return normalized;
}

function requiredPositiveId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須為正整數。');
  return value;
}

function expectedVersion(payload, field = 'expectedVersion') {
  if (!Number.isSafeInteger(payload[field]) || payload[field] < 1) {
    fail(field, '必須為正整數。');
  }
  return payload[field];
}

function requiredUrl(value, field, errorCode, { localPathAllowed = true } = {}) {
  const url = requiredText(value, field, 500);
  if (localPathAllowed && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) throw new TypeError('Invalid URL');
    return parsed.toString();
  } catch {
    fail(field, '請輸入本站相對路徑或 HTTPS 網址。', errorCode);
  }
}

function optionalUrl(value, field, errorCode, options) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUrl(value, field, errorCode, options);
}

function currentTimestamp(clock) {
  const timestamp = new Date(clock()).valueOf();
  if (Number.isNaN(timestamp)) throw new TypeError('Invalid product content clock value');
  return new Date(timestamp).toISOString();
}

function nextTimestamp(clock, current) {
  const timestamp = new Date(clock()).valueOf();
  if (Number.isNaN(timestamp)) throw new TypeError('Invalid product content clock value');
  return new Date(Math.max(timestamp, Date.parse(current) + 1)).toISOString();
}

function utcIso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function contentDto(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    bodyText: row.body_text,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function sectionDto(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    locale: row.locale,
    sectionKey: row.section_key,
    sectionType: row.section_type,
    title: row.title,
    bodyText: row.body_text,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function specDto(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    locale: row.locale,
    specKey: row.spec_key,
    groupKey: row.group_key,
    groupLabel: row.group_label,
    specLabel: row.spec_label,
    specValue: row.spec_value,
    unit: row.unit,
    sortOrder: Number(row.sort_order),
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function mediaDto(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    mediaType: row.media_type,
    mediaUsage: row.media_usage,
    url: row.url,
    altText: row.alt_text,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order),
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function brandDto(row) {
  return {
    id: Number(row.id),
    brandCode: row.brand_code,
    slug: row.slug,
    brandName: row.brand_name,
    description: row.description,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    rowVersion: Number(row.row_version),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function productBrandDto(row, productRowVersion) {
  return {
    productId: Number(row.product_id),
    brandId: Number(row.brand_id),
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order),
    createdAt: utcIso(row.created_at),
    productRowVersion: Number(productRowVersion),
    brand: {
      id: Number(row.brand_id),
      brandCode: row.brand_code,
      slug: row.slug,
      brandName: row.brand_name,
      description: row.description,
      websiteUrl: row.website_url,
      logoUrl: row.logo_url,
      isActive: Boolean(row.is_active),
      rowVersion: Number(row.brand_row_version),
    },
  };
}

function contentValues(payload) {
  return {
    locale: requiredLocale(payload.locale),
    title: requiredText(payload.title, 'title', 200),
    summary: optionalText(payload.summary, 'summary', 500),
    bodyText: optionalText(payload.bodyText, 'bodyText', 20_000),
    seoTitle: optionalText(payload.seoTitle, 'seoTitle', 70),
    seoDescription: optionalText(payload.seoDescription, 'seoDescription', 160),
  };
}

function contentValuesFromRow(row) {
  return {
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    bodyText: row.body_text,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
  };
}

function sectionValues(payload) {
  if (!SECTION_TYPES.has(payload.sectionType)) fail('sectionType', '值不允許。');
  if (typeof payload.isActive !== 'boolean') fail('isActive', '必須為布林值。');
  return {
    sectionKey: requiredIdentifier(payload.sectionKey, 'sectionKey'),
    sectionType: payload.sectionType,
    title: optionalText(payload.title, 'title', 200),
    bodyText: requiredText(payload.bodyText, 'bodyText', 10_000),
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
    isActive: payload.isActive,
  };
}

function sectionValuesFromRow(row) {
  return {
    sectionKey: row.section_key,
    sectionType: row.section_type,
    title: row.title,
    bodyText: row.body_text,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function specValues(payload) {
  return {
    specKey: requiredIdentifier(payload.specKey, 'specKey'),
    groupKey: requiredIdentifier(payload.groupKey, 'groupKey'),
    groupLabel: requiredText(payload.groupLabel, 'groupLabel', 120),
    specLabel: requiredText(payload.specLabel, 'specLabel', 120),
    specValue: requiredText(payload.specValue, 'specValue', 500),
    unit: optionalText(payload.unit, 'unit', 30),
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
  };
}

function specValuesFromRow(row) {
  return {
    specKey: row.spec_key,
    groupKey: row.group_key,
    groupLabel: row.group_label,
    specLabel: row.spec_label,
    specValue: row.spec_value,
    unit: row.unit,
    sortOrder: Number(row.sort_order),
  };
}

function mediaValues(payload) {
  if (!MEDIA_USAGES.has(payload.mediaUsage)) fail('mediaUsage', '值不允許。');
  if (typeof payload.isPrimary !== 'boolean') fail('isPrimary', '必須為布林值。');
  if (payload.isPrimary !== (payload.mediaUsage === 'PRIMARY')) {
    fail('isPrimary', '主圖必須使用 PRIMARY，用途為 PRIMARY 時也必須設為主圖。');
  }
  return {
    mediaUsage: payload.mediaUsage,
    url: requiredUrl(payload.url, 'url', 'INVALID_MEDIA_URL'),
    altText: requiredText(payload.altText, 'altText', 250),
    isPrimary: payload.isPrimary,
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
  };
}

function mediaValuesFromRow(row) {
  return {
    mediaUsage: row.media_usage,
    url: row.url,
    altText: row.alt_text,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order),
  };
}

function brandValues(payload) {
  if (typeof payload.isActive !== 'boolean') fail('isActive', '必須為布林值。');
  return {
    brandCode: requiredCode(payload.brandCode, 'brandCode'),
    slug: requiredSlug(payload.slug, 'slug'),
    brandName: requiredText(payload.brandName, 'brandName', 120),
    description: optionalText(payload.description, 'description', 1_000),
    websiteUrl: optionalUrl(payload.websiteUrl, 'websiteUrl', 'INVALID_WEBSITE_URL', { localPathAllowed: false }),
    logoUrl: optionalUrl(payload.logoUrl, 'logoUrl', 'INVALID_LOGO_URL', { localPathAllowed: true }),
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
    isActive: payload.isActive,
  };
}

function brandValuesFromRow(row) {
  return {
    brandCode: row.brand_code,
    slug: row.slug,
    brandName: row.brand_name,
    description: row.description,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function brandLinkValues(payload) {
  if (typeof payload.isPrimary !== 'boolean') fail('isPrimary', '必須為布林值。');
  return {
    isPrimary: payload.isPrimary,
    sortOrder: nonNegativeInteger(payload.sortOrder, 'sortOrder'),
  };
}

function brandLinkValuesFromRow(row) {
  return { isPrimary: Boolean(row.is_primary), sortOrder: Number(row.sort_order) };
}

function mapResult(result, resource) {
  if (result.kind === 'product-not-found') {
    throw new AdminProductContentError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
  }
  if (result.kind === 'content-not-found') {
    throw new AdminProductContentError(404, 'CONTENT_NOT_FOUND', '找不到商品內容。');
  }
  if (result.kind === 'brand-not-found') {
    throw new AdminProductContentError(404, 'BRAND_NOT_FOUND', '找不到品牌。');
  }
  if (result.kind === 'product-conflict') {
    throw new AdminProductContentError(409, 'PRODUCT_CONFLICT', '商品已被其他人更新，請重新整理後再試。');
  }
  if (result.kind === 'conflict') {
    throw new AdminProductContentError(409, `${resource}_CONFLICT`, '資料已被其他人更新，請重新整理後再試。');
  }
  if (result.kind === 'not-found') {
    throw new AdminProductContentError(404, `${resource}_NOT_FOUND`, '找不到要求的資料。');
  }
  return result;
}

function mapDatabaseError(error) {
  const message = error?.message ?? '';
  if (/catalog_product_content\.product_id.*catalog_product_content\.locale/i.test(message)) {
    throw new AdminProductContentError(409, 'CONTENT_LOCALE_CONFLICT', '此商品的語系內容已存在。', [
      { field: 'locale', message: '請改用另一個語系，或更新既有內容。' },
    ]);
  }
  if (/catalog_product_sections\.product_id.*catalog_product_sections\.locale.*catalog_product_sections\.section_key/i.test(message)) {
    throw new AdminProductContentError(409, 'SECTION_KEY_CONFLICT', '此語系的區塊代碼已存在。', [
      { field: 'sectionKey', message: '區塊代碼不可重複。' },
    ]);
  }
  if (/catalog_product_specs\.product_id.*catalog_product_specs\.spec_key.*catalog_product_specs\.locale/i.test(message)) {
    throw new AdminProductContentError(409, 'SPEC_CONFLICT', '此語系的規格代碼已存在。', [
      { field: 'specKey', message: '規格代碼不可重複。' },
    ]);
  }
  if (/catalog_brands\.brand_code/i.test(message)) {
    throw new AdminProductContentError(409, 'BRAND_CODE_CONFLICT', '品牌代碼已存在。', [
      { field: 'brandCode', message: '品牌代碼不可重複。' },
    ]);
  }
  if (/catalog_brands\.slug/i.test(message)) {
    throw new AdminProductContentError(409, 'BRAND_SLUG_CONFLICT', '品牌網址代稱已存在。', [
      { field: 'slug', message: '網址代稱不可重複。' },
    ]);
  }
  if (/catalog_product_brands\.product_id/i.test(message)) {
    throw new AdminProductContentError(409, 'PRODUCT_BRAND_CONFLICT', '此品牌已連結至商品。', [
      { field: 'brandId', message: '請改為更新現有品牌連結。' },
    ]);
  }
  throw error;
}

function contentAudit(row) {
  return { locale: row.locale, title: row.title };
}

function sectionAudit(row) {
  return {
    locale: row.locale,
    sectionKey: row.section_key,
    sectionType: row.section_type,
    title: row.title,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function specAudit(row) {
  return {
    locale: row.locale,
    specKey: row.spec_key,
    groupKey: row.group_key,
    specLabel: row.spec_label,
    unit: row.unit,
    sortOrder: Number(row.sort_order),
  };
}

function mediaAudit(row) {
  return {
    mediaUsage: row.media_usage,
    url: row.url,
    altText: row.alt_text,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order),
  };
}

function brandAudit(row) {
  return {
    brandCode: row.brand_code,
    brandName: row.brand_name,
    slug: row.slug,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  };
}

function productBrandAudit(row) {
  return {
    brandCode: row.brand_code,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order),
  };
}

export function createAdminProductContentService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    ...event,
  }, { database });

  const requireProduct = async (productIdValue) => {
    const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
    if (!(await findProductRow({ databasePath, productId }))) {
      throw new AdminProductContentError(404, 'PRODUCT_NOT_FOUND', '找不到商品。');
    }
    return productId;
  };

  return {
    async contentDetail(productIdValue, localeValue) {
      const productId = await requireProduct(productIdValue);
      const locale = requiredLocale(localeValue);
      const result = (await listProductContentRows({ databasePath, productId, locale }));
      if (!result) throw new AdminProductContentError(404, 'CONTENT_NOT_FOUND', '找不到商品內容。');
      return {
        content: contentDto(result.content),
        sections: result.sections.map(sectionDto),
        specs: result.specs.map(specDto),
      };
    },
    async createContent(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, CONTENT_CREATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const values = contentValues(payload);
      try {
        const result = mapResult((await createProductContentRow({
          databasePath,
          productId,
          values,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_CONTENT_CREATED',
              entityType: 'CATALOG_PRODUCT_CONTENT',
              entityId: String(row.id),
              after: contentAudit(row),
              allowedFields: ['locale', 'title'],
            }, database);
          },
        })), 'CONTENT');
        return contentDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateContent(productIdValue, localeValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, CONTENT_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const locale = requiredLocale(localeValue);
      const before = (await findProductContentRow({ databasePath, productId, locale }));
      if (!before) throw new AdminProductContentError(404, 'CONTENT_NOT_FOUND', '找不到商品內容。');
      const version = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個內容欄位。');
      const values = contentValues({ ...contentValuesFromRow(before), ...payload });
      try {
        const result = mapResult((await updateProductContentRow({
          databasePath,
          productId,
          locale,
          expectedVersion: version,
          values,
          updatedAt: nextTimestamp(clock, before.updated_at),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_CONTENT_UPDATED',
              entityType: 'CATALOG_PRODUCT_CONTENT',
              entityId: String(after.id),
              before: contentAudit(previous),
              after: contentAudit(after),
              allowedFields: ['locale', 'title'],
            }, database);
          },
        })), 'CONTENT');
        return contentDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async createSection(productIdValue, localeValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, SECTION_CREATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const locale = requiredLocale(localeValue);
      const values = sectionValues(payload);
      try {
        const result = mapResult((await createProductSectionRow({
          databasePath,
          productId,
          locale,
          values,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_SECTION_CREATED',
              entityType: 'CATALOG_PRODUCT_SECTION',
              entityId: String(row.id),
              after: sectionAudit(row),
              allowedFields: ['locale', 'sectionKey', 'sectionType', 'title', 'sortOrder', 'isActive'],
            }, database);
          },
        })), 'SECTION');
        return sectionDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateSection(productIdValue, sectionIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, SECTION_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const sectionId = positiveId(sectionIdValue, 'sectionId', 'SECTION_NOT_FOUND', '找不到商品區塊。');
      const before = (await findProductSectionRow({ databasePath, productId, sectionId }));
      if (!before) throw new AdminProductContentError(404, 'SECTION_NOT_FOUND', '找不到商品區塊。');
      const version = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個區塊欄位。');
      const values = sectionValues({ ...sectionValuesFromRow(before), ...payload });
      try {
        const result = mapResult((await updateProductSectionRow({
          databasePath,
          productId,
          sectionId,
          expectedVersion: version,
          values,
          updatedAt: nextTimestamp(clock, before.updated_at),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_SECTION_UPDATED',
              entityType: 'CATALOG_PRODUCT_SECTION',
              entityId: String(after.id),
              before: sectionAudit(previous),
              after: sectionAudit(after),
              allowedFields: ['locale', 'sectionKey', 'sectionType', 'title', 'sortOrder', 'isActive'],
            }, database);
          },
        })), 'SECTION');
        return sectionDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async createSpec(productIdValue, localeValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, SPEC_CREATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const locale = requiredLocale(localeValue);
      const values = specValues(payload);
      try {
        const result = mapResult((await createProductSpecRow({
          databasePath,
          productId,
          locale,
          values,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_SPEC_CREATED',
              entityType: 'CATALOG_PRODUCT_SPEC',
              entityId: String(row.id),
              after: specAudit(row),
              allowedFields: ['locale', 'specKey', 'groupKey', 'specLabel', 'unit', 'sortOrder'],
            }, database);
          },
        })), 'SPEC');
        return specDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateSpec(productIdValue, specIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, SPEC_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const specId = positiveId(specIdValue, 'specId', 'SPEC_NOT_FOUND', '找不到商品規格。');
      const before = (await findProductSpecRow({ databasePath, productId, specId }));
      if (!before) throw new AdminProductContentError(404, 'SPEC_NOT_FOUND', '找不到商品規格。');
      const version = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個規格欄位。');
      const values = specValues({ ...specValuesFromRow(before), ...payload });
      try {
        const result = mapResult((await updateProductSpecRow({
          databasePath,
          productId,
          specId,
          expectedVersion: version,
          values,
          updatedAt: nextTimestamp(clock, before.updated_at),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_SPEC_UPDATED',
              entityType: 'CATALOG_PRODUCT_SPEC',
              entityId: String(after.id),
              before: specAudit(previous),
              after: specAudit(after),
              allowedFields: ['locale', 'specKey', 'groupKey', 'specLabel', 'unit', 'sortOrder'],
            }, database);
          },
        })), 'SPEC');
        return specDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async listMedia(productIdValue) {
      const productId = await requireProduct(productIdValue);
      return (await listProductMediaRows({ databasePath, productId })).map(mediaDto);
    },
    async createMedia(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, MEDIA_CREATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const values = mediaValues(payload);
      try {
        const result = mapResult((await createProductMediaRow({
          databasePath,
          productId,
          values,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_MEDIA_CREATED',
              entityType: 'CATALOG_PRODUCT_MEDIA',
              entityId: String(row.id),
              after: mediaAudit(row),
              allowedFields: ['mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder'],
            }, database);
          },
        })), 'MEDIA');
        return mediaDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateMedia(productIdValue, mediaIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, MEDIA_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const mediaId = positiveId(mediaIdValue, 'mediaId', 'MEDIA_NOT_FOUND', '找不到商品媒體。');
      const before = (await findProductMediaRow({ databasePath, productId, mediaId }));
      if (!before) throw new AdminProductContentError(404, 'MEDIA_NOT_FOUND', '找不到商品媒體。');
      const version = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個媒體欄位。');
      const values = mediaValues({ ...mediaValuesFromRow(before), ...payload });
      try {
        const result = mapResult((await updateProductMediaRow({
          databasePath,
          productId,
          mediaId,
          expectedVersion: version,
          values,
          updatedAt: nextTimestamp(clock, before.updated_at),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_MEDIA_UPDATED',
              entityType: 'CATALOG_PRODUCT_MEDIA',
              entityId: String(after.id),
              before: mediaAudit(previous),
              after: mediaAudit(after),
              allowedFields: ['mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder'],
            }, database);
          },
        })), 'MEDIA');
        return mediaDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async deleteMedia(productIdValue, mediaIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, MEDIA_DELETE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const mediaId = positiveId(mediaIdValue, 'mediaId', 'MEDIA_NOT_FOUND', '找不到商品媒體。');
      const version = expectedVersion(payload);
      try {
        const result = mapResult((await deleteProductMediaRow({
          databasePath,
          productId,
          mediaId,
          expectedVersion: version,
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_MEDIA_DELETED',
              entityType: 'CATALOG_PRODUCT_MEDIA',
              entityId: String(row.id),
              before: mediaAudit(row),
              allowedFields: ['mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder'],
            }, database);
          },
        })), 'MEDIA');
        return mediaDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async listBrands() {
      return (await listBrandRows({ databasePath })).map(brandDto);
    },
    async createBrand(payload, actor, requestAudit = {}) {
      objectPayload(payload, BRAND_CREATE_FIELDS);
      const values = brandValues(payload);
      try {
        const result = mapResult((await createBrandRow({
          databasePath,
          values,
          createdAt: currentTimestamp(clock),
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'BRAND_CREATED',
              entityType: 'CATALOG_BRAND',
              entityId: String(row.id),
              after: brandAudit(row),
              allowedFields: ['brandCode', 'brandName', 'slug', 'websiteUrl', 'logoUrl', 'sortOrder', 'isActive'],
            }, database);
          },
        })), 'BRAND');
        return brandDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateBrand(brandIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, BRAND_UPDATE_FIELDS);
      const brandId = positiveId(brandIdValue, 'brandId', 'BRAND_NOT_FOUND', '找不到品牌。');
      const before = (await findBrandRow({ databasePath, brandId }));
      if (!before) throw new AdminProductContentError(404, 'BRAND_NOT_FOUND', '找不到品牌。');
      const version = expectedVersion(payload);
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedVersion');
      if (changedFields.length === 0) fail('expectedVersion', '至少要修改一個品牌欄位。');
      const values = brandValues({ ...brandValuesFromRow(before), ...payload });
      try {
        const result = mapResult((await updateBrandRow({
          databasePath,
          brandId,
          expectedVersion: version,
          values,
          updatedAt: nextTimestamp(clock, before.updated_at),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'BRAND_UPDATED',
              entityType: 'CATALOG_BRAND',
              entityId: String(after.id),
              before: brandAudit(previous),
              after: brandAudit(after),
              allowedFields: ['brandCode', 'brandName', 'slug', 'websiteUrl', 'logoUrl', 'sortOrder', 'isActive'],
            }, database);
          },
        })), 'BRAND');
        return brandDto(result.row);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async listProductBrands(productIdValue) {
      const productId = await requireProduct(productIdValue);
      const product = (await findProductRow({ databasePath, productId }));
      return (await listProductBrandRows({ databasePath, productId })).map((row) => productBrandDto(
        row, product.row_version,
      ));
    },
    async createProductBrand(productIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, BRAND_LINK_CREATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const brandId = requiredPositiveId(payload.brandId, 'brandId');
      const expectedProductVersion = expectedVersion(payload, 'expectedProductVersion');
      const values = brandLinkValues(payload);
      try {
        const result = mapResult((await createProductBrandRow({
          databasePath,
          productId,
          brandId,
          expectedProductVersion,
          values,
          actorId: actor.id,
          updatedAt: currentTimestamp(clock),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_BRAND_LINKED',
              entityType: 'CATALOG_PRODUCT_BRAND',
              entityId: `${productId}:${brandId}`,
              before: previous ? productBrandAudit(previous) : null,
              after: productBrandAudit(after),
              allowedFields: ['brandCode', 'isPrimary', 'sortOrder'],
            }, database);
          },
        })), 'PRODUCT_BRAND');
        return productBrandDto(result.row, result.product.row_version);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
    async updateProductBrand(productIdValue, brandIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, BRAND_LINK_UPDATE_FIELDS);
      const productId = positiveId(productIdValue, 'productId', 'PRODUCT_NOT_FOUND', '找不到商品。');
      const brandId = positiveId(brandIdValue, 'brandId', 'BRAND_NOT_FOUND', '找不到品牌。');
      const expectedProductVersion = expectedVersion(payload, 'expectedProductVersion');
      const existing = (await listProductBrandRows({ databasePath, productId })).find((row) => Number(row.brand_id) === brandId);
      if (!existing) throw new AdminProductContentError(404, 'PRODUCT_BRAND_NOT_FOUND', '找不到商品品牌連結。');
      const changedFields = Object.keys(payload).filter((field) => field !== 'expectedProductVersion');
      if (changedFields.length === 0) fail('expectedProductVersion', '至少要修改一個品牌連結欄位。');
      const values = brandLinkValues({ ...brandLinkValuesFromRow(existing), ...payload });
      try {
        const result = mapResult((await updateProductBrandRow({
          databasePath,
          productId,
          brandId,
          expectedProductVersion,
          values,
          actorId: actor.id,
          updatedAt: currentTimestamp(clock),
          async afterWrite(database, previous, after) {
            await audit(actor, requestAudit, {
              action: 'PRODUCT_BRAND_UPDATED',
              entityType: 'CATALOG_PRODUCT_BRAND',
              entityId: `${productId}:${brandId}`,
              before: productBrandAudit(previous),
              after: productBrandAudit(after),
              allowedFields: ['brandCode', 'isPrimary', 'sortOrder'],
            }, database);
          },
        })), 'PRODUCT_BRAND');
        return productBrandDto(result.row, result.product.row_version);
      } catch (error) {
        if (error instanceof AdminProductContentError) throw error;
        mapDatabaseError(error);
      }
    },
  };
}
