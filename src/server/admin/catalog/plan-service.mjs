import { getCatalogPlanPreview } from '../../services/catalog-service.mjs';
import {
  createPlanRow,
  deletePlanRow,
  findPlanRow,
  searchPlanRows,
  setPlanPublicationRow,
  updatePlanRow,
} from './plan-repository.mjs';

const PLAN_FIELDS = new Set([
  'bandwidthLabel', 'contractMonths', 'description', 'downloadMbps', 'effectiveFrom',
  'effectiveTo', 'planCode', 'planName', 'serviceCategory', 'technology',
  'uploadMbps', 'wifiIncluded',
]);
const UPDATE_FIELDS = new Set([...PLAN_FIELDS, 'expectedUpdatedAt']);
const VERSION_FIELDS = new Set(['expectedUpdatedAt']);
const QUERY_FIELDS = new Set(['direction', 'isPublished', 'page', 'pageSize', 'q', 'sort']);
const CATEGORIES = new Set(['BROADBAND', 'ENTERPRISE_LEASE', 'LOW_VOLTAGE', 'OTHER']);
const TECHNOLOGIES = new Set(['VDSL2', 'FTTH', 'LEASED_LINE', 'PROJECT', 'OTHER']);
const SORTS = new Set(['planCode', 'planName', 'downloadMbps', 'updatedAt']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AdminPlanError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminPlanError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message, code = 'INVALID_BODY') {
  throw new AdminPlanError(422, code, '方案資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, allowedFields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminPlanError(422, 'INVALID_BODY', '請提供有效的 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unknown.length) {
    throw new AdminPlanError(422, 'INVALID_BODY', '包含不允許的欄位。', unknown.map(
      (field) => ({ field, message: '此欄位不允許寫入。' }),
    ));
  }
}

function requiredText(payload, field, maxLength) {
  const value = typeof payload[field] === 'string' ? payload[field].trim() : '';
  if (!value || value.length > maxLength) fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  return value;
}

function optionalText(payload, field, maxLength) {
  if (payload[field] === null || payload[field] === undefined || payload[field] === '') return null;
  if (typeof payload[field] !== 'string') fail(field, '必須為文字或 null。');
  const value = payload[field].trim();
  if (!value || value.length > maxLength) fail(field, `最多 ${maxLength} 個字元。`);
  return value;
}

function optionalPositiveInteger(payload, field, { required = false, max = 1_000_000 } = {}) {
  const value = payload[field];
  if (!required && (value === null || value === undefined || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(field, `必須為 1 至 ${max} 的整數。`);
  }
  return value;
}

function dateField(payload, field) {
  const value = payload[field];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail(field, '必須為 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(field, '日期不存在。');
  }
  return value;
}

function expectedUpdatedAt(payload) {
  const value = payload.expectedUpdatedAt;
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail('expectedUpdatedAt', '必須為 UTC ISO 8601 時間。');
  }
  return value;
}

function planValues(payload, allowedFields) {
  objectPayload(payload, allowedFields);
  if (!CATEGORIES.has(payload.serviceCategory)) fail('serviceCategory', '值不允許。');
  if (!TECHNOLOGIES.has(payload.technology)) fail('technology', '值不允許。');
  if (typeof payload.wifiIncluded !== 'boolean') fail('wifiIncluded', '必須為布林值。');
  const effectiveFrom = dateField(payload, 'effectiveFrom');
  const effectiveTo = dateField(payload, 'effectiveTo');
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    fail('effectiveTo', '不得早於生效日期。');
  }
  return {
    planCode: requiredText(payload, 'planCode', 32),
    planName: requiredText(payload, 'planName', 150),
    serviceCategory: payload.serviceCategory,
    technology: payload.technology,
    downloadMbps: optionalPositiveInteger(payload, 'downloadMbps'),
    uploadMbps: optionalPositiveInteger(payload, 'uploadMbps'),
    bandwidthLabel: optionalText(payload, 'bandwidthLabel', 50),
    contractMonths: optionalPositiveInteger(payload, 'contractMonths', { required: true, max: 120 }),
    wifiIncluded: payload.wifiIncluded,
    description: optionalText(payload, 'description', 2_000),
    effectiveFrom,
    effectiveTo,
  };
}

function positiveId(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AdminPlanError(404, 'PLAN_NOT_FOUND', '找不到方案。');
  }
  return number;
}

function utcIso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function currentDate(clock) {
  const date = new Date(clock());
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid plan clock value');
  return date.toISOString().slice(0, 10);
}

function nextTimestamp(clock, current = null) {
  const now = new Date(clock()).valueOf();
  if (Number.isNaN(now)) throw new TypeError('Invalid plan clock value');
  const minimum = current ? Date.parse(current) + 1 : now;
  return new Date(Math.max(now, minimum)).toISOString();
}

function planDto(row, today) {
  return {
    id: Number(row.id),
    planCode: row.plan_code,
    planName: row.plan_name,
    serviceCategory: row.service_category,
    technology: row.technology,
    downloadMbps: row.download_mbps === null ? null : Number(row.download_mbps),
    uploadMbps: row.upload_mbps === null ? null : Number(row.upload_mbps),
    bandwidthLabel: row.bandwidth_label,
    contractMonths: Number(row.contract_months),
    wifiIncluded: Boolean(row.wifi_included),
    description: row.description,
    isPublished: Boolean(row.is_active),
    isCurrentlyVisible: Boolean(row.is_active)
      && (row.effective_from === null || row.effective_from <= today)
      && (row.effective_to === null || row.effective_to >= today),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function parseQuery(params) {
  for (const field of params.keys()) {
    if (!QUERY_FIELDS.has(field)) fail(field, '此查詢欄位不允許。', 'INVALID_QUERY');
  }
  const keyword = (params.get('q') ?? '').trim();
  if (keyword.length > 100) fail('q', '最多 100 個字元。', 'INVALID_QUERY');
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 20);
  if (!Number.isSafeInteger(page) || page < 1) fail('page', '必須為正整數。', 'INVALID_QUERY');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    fail('pageSize', '必須為 1 至 100。', 'INVALID_QUERY');
  }
  const publishedParam = params.get('isPublished');
  if (publishedParam !== null && !['true', 'false'].includes(publishedParam)) {
    fail('isPublished', '必須為 true 或 false。', 'INVALID_QUERY');
  }
  const sort = params.get('sort') || 'updatedAt';
  if (!SORTS.has(sort)) fail('sort', '值不允許。', 'INVALID_QUERY');
  const direction = params.get('direction') || 'desc';
  if (!['asc', 'desc'].includes(direction)) fail('direction', '值不允許。', 'INVALID_QUERY');
  return {
    keyword,
    isPublished: publishedParam === null ? null : publishedParam === 'true',
    page,
    pageSize,
    sort,
    direction,
  };
}

function mapWriteResult(result) {
  if (result.kind === 'not-found') throw new AdminPlanError(404, 'PLAN_NOT_FOUND', '找不到方案。');
  if (result.kind === 'conflict') throw new AdminPlanError(409, 'PLAN_CONFLICT', '方案已被其他人更新。');
  return result;
}

function mapUnique(error) {
  if (/UNIQUE constraint failed: service_plans\.plan_code/i.test(error?.message ?? '')) {
    throw new AdminPlanError(409, 'PLAN_CODE_CONFLICT', '方案代碼已存在。', [
      { field: 'planCode', message: '方案代碼不可重複。' },
    ]);
  }
  throw error;
}

export function createAdminPlanService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    ...event,
  }, { database });
  const dto = (row) => planDto(row, currentDate(clock));

  return {
    async list(params) {
      const query = parseQuery(params);
      const { rows, total } = (await searchPlanRows({ databasePath, query }));
      return { data: rows.map(dto), page: query.page, pageSize: query.pageSize, total };
    },
    async detail(planIdValue) {
      const planId = positiveId(planIdValue);
      const row = (await findPlanRow({ databasePath, planId }));
      if (!row) throw new AdminPlanError(404, 'PLAN_NOT_FOUND', '找不到方案。');
      return dto(row);
    },
    async preview(planIdValue) {
      const planId = positiveId(planIdValue);
      if (!(await findPlanRow({ databasePath, planId }))) {
        throw new AdminPlanError(404, 'PLAN_NOT_FOUND', '找不到方案。');
      }
      return { plan: await getCatalogPlanPreview(databasePath, planId, { clock }) };
    },
    async create(payload, actor, requestAudit = {}) {
      const values = planValues(payload, PLAN_FIELDS);
      const createdAt = nextTimestamp(clock);
      try {
        return dto((await createPlanRow({
          databasePath,
          values: { ...values, createdAt, updatedAt: createdAt },
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PLAN_CREATED', entityType: 'SERVICE_PLAN', entityId: String(row.id),
              after: { isActive: false }, allowedFields: ['isActive'],
            }, database);
          },
        })));
      } catch (error) {
        mapUnique(error);
      }
    },
    async update(planIdValue, payload, actor, requestAudit = {}) {
      const planId = positiveId(planIdValue);
      const values = planValues(payload, UPDATE_FIELDS);
      const expected = expectedUpdatedAt(payload);
      try {
        const result = mapWriteResult((await updatePlanRow({
          databasePath,
          planId,
          expectedUpdatedAt: expected,
          updatedAt: nextTimestamp(clock, expected),
          values,
          async afterWrite(database, before, after) {
            await audit(actor, requestAudit, {
              action: 'PLAN_UPDATED', entityType: 'SERVICE_PLAN', entityId: String(planId),
              before: { isActive: Boolean(before.is_active) },
              after: { isActive: Boolean(after.is_active) }, allowedFields: ['isActive'],
            }, database);
          },
        })));
        return dto(result.row);
      } catch (error) {
        if (error instanceof AdminPlanError) throw error;
        mapUnique(error);
      }
    },
    async setPublication(planIdValue, payload, isPublished, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const planId = positiveId(planIdValue);
      const expected = expectedUpdatedAt(payload);
      const result = mapWriteResult((await setPlanPublicationRow({
        databasePath,
        planId,
        expectedUpdatedAt: expected,
        isPublished,
        updatedAt: nextTimestamp(clock, expected),
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: isPublished ? 'PLAN_PUBLISHED' : 'PLAN_UNPUBLISHED',
            entityType: 'SERVICE_PLAN', entityId: String(planId),
            before: { isActive: Boolean(before.is_active) },
            after: { isActive: Boolean(after.is_active) }, allowedFields: ['isActive'],
          }, database);
        },
      })));
      return dto(result.row);
    },
    async delete(planIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const planId = positiveId(planIdValue);
      const result = mapWriteResult((await deletePlanRow({
        databasePath,
        planId,
        expectedUpdatedAt: expectedUpdatedAt(payload),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, {
            action: 'PLAN_DELETED', entityType: 'SERVICE_PLAN', entityId: String(planId),
            before: { isActive: Boolean(row.is_active) }, allowedFields: ['isActive'],
          }, database);
        },
      })));
      if (result.kind === 'referenced') {
        throw new AdminPlanError(409, 'PLAN_REFERENCED', '方案已有關聯資料，無法刪除。');
      }
      return { deleted: true, id: planId };
    },
  };
}
