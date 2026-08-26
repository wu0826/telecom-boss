import {
  createPriceRow,
  deletePriceRow,
  listPriceRows,
  updatePriceRow,
} from './price-repository.mjs';

const PRICE_FIELDS = new Set([
  'amount', 'billingCycle', 'effectiveFrom', 'effectiveTo', 'isActive',
  'monthFrom', 'monthTo', 'priceType', 'priority',
]);
const UPDATE_FIELDS = new Set([...PRICE_FIELDS, 'expectedUpdatedAt']);
const VERSION_FIELDS = new Set(['expectedUpdatedAt']);
const PRICE_TYPES = new Set(['INTRO', 'RENEWAL', 'STANDARD', 'INSTALLATION', 'DEPOSIT']);
const BILLING_CYCLES = new Set(['MONTHLY', 'ONE_TIME']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const MAX_AMOUNT_MINOR = 999_999_999_999;

export class AdminPriceError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminPriceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new AdminPriceError(422, 'INVALID_BODY', '價格資料格式不正確。', [{ field, message }]);
}

function objectPayload(payload, allowedFields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminPriceError(422, 'INVALID_BODY', '請提供 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unknown.length) {
    throw new AdminPriceError(422, 'INVALID_BODY', '包含未允許的價格欄位。', unknown.map(
      (field) => ({ field, message: '此欄位不允許由用戶端寫入。' }),
    ));
  }
}

function positiveId(value, code, message) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new AdminPriceError(404, code, message);
  return number;
}

function dateField(payload, field) {
  const value = payload[field];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail(field, '必須是 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(field, '日期不存在。');
  }
  return value;
}

function nullablePositiveInteger(payload, field, { required = false, max = 1200 } = {}) {
  const value = payload[field];
  if (!required && (value === null || value === undefined || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(field, `必須是 1 到 ${max} 的整數。`);
  }
  return value;
}

function amountMinor(amount) {
  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
    fail('amount', '必須是最多 10 位整數及 2 位小數的字串。');
  }
  const [whole, fraction = ''] = amount.split('.');
  const minor = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_AMOUNT_MINOR) {
    fail('amount', '金額必須大於零且不得超過 DECIMAL(12,2)。');
  }
  return minor;
}

function expectedUpdatedAt(payload) {
  const value = payload.expectedUpdatedAt;
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail('expectedUpdatedAt', '必須是有效的 UTC ISO 8601 時間。');
  return value;
}

function periodKey(planId, values) {
  return [
    planId,
    values.priceType,
    values.billingCycle,
    values.monthFrom ?? 'OPEN',
    values.monthTo ?? 'OPEN',
    values.effectiveFrom ?? 'OPEN',
  ].join(':');
}

function priceValues(planId, payload, allowedFields) {
  objectPayload(payload, allowedFields);
  if (!PRICE_TYPES.has(payload.priceType)) fail('priceType', '價格類型不在允許清單。');
  if (!BILLING_CYCLES.has(payload.billingCycle)) fail('billingCycle', '計費週期不在允許清單。');
  if (typeof payload.isActive !== 'boolean') fail('isActive', '必須是布林值。');
  const monthFrom = nullablePositiveInteger(payload, 'monthFrom');
  const monthTo = nullablePositiveInteger(payload, 'monthTo');
  if (payload.billingCycle === 'MONTHLY' && monthFrom === null) {
    fail('monthFrom', '月租價格必須指定起始月。');
  }
  if (payload.billingCycle === 'ONE_TIME' && (monthFrom !== null || monthTo !== null)) {
    fail('monthFrom', '一次性價格不可設定月份區間。');
  }
  if (monthFrom !== null && monthTo !== null && monthFrom > monthTo) {
    fail('monthTo', '結束月不可早於起始月。');
  }
  const effectiveFrom = dateField(payload, 'effectiveFrom');
  const effectiveTo = dateField(payload, 'effectiveTo');
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    fail('effectiveTo', '失效日不可早於生效日。');
  }
  const values = {
    priceType: payload.priceType,
    billingCycle: payload.billingCycle,
    amountMinor: amountMinor(payload.amount),
    monthFrom,
    monthTo,
    effectiveFrom,
    effectiveTo,
    priority: nullablePositiveInteger(payload, 'priority', { required: true, max: 10_000 }),
    isActive: payload.isActive,
  };
  return { ...values, pricePeriodKey: periodKey(planId, values) };
}

function utcIso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function formatMinorUnits(value) {
  const digits = BigInt(value).toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function priceDto(row) {
  return {
    id: Number(row.id),
    planId: Number(row.service_plan_id),
    priceType: row.price_type,
    billingCycle: row.billing_cycle,
    amount: formatMinorUnits(row.amount),
    monthFrom: row.month_from === null ? null : Number(row.month_from),
    monthTo: row.month_to === null ? null : Number(row.month_to),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    priority: Number(row.priority),
    isActive: Boolean(row.is_active),
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function nextTimestamp(clock, current = null) {
  const now = new Date(clock()).valueOf();
  if (Number.isNaN(now)) throw new TypeError('Invalid price clock value');
  const minimum = current ? Date.parse(current) + 1 : now;
  return new Date(Math.max(now, minimum)).toISOString();
}

function mapResult(result) {
  if (result.kind === 'plan-not-found') {
    throw new AdminPriceError(404, 'PLAN_NOT_FOUND', '找不到方案。');
  }
  if (result.kind === 'not-found') {
    throw new AdminPriceError(404, 'PRICE_NOT_FOUND', '找不到價格期間。');
  }
  if (result.kind === 'conflict') {
    throw new AdminPriceError(409, 'PRICE_CONFLICT', '價格期間已被其他人更新。');
  }
  if (result.kind === 'overlap') {
    throw new AdminPriceError(409, 'PRICE_PERIOD_OVERLAP', '啟用中的價格期間不可重疊。');
  }
  if (result.kind === 'referenced') {
    throw new AdminPriceError(409, 'PRICE_REFERENCED', '價格已有成交訂單引用，無法刪除。');
  }
  return result;
}

function mapConstraint(error) {
  if (/UNIQUE constraint failed: plan_prices\.price_period_key/i.test(error?.message ?? '')) {
    throw new AdminPriceError(409, 'PRICE_PERIOD_OVERLAP', '價格期間已存在或重疊。');
  }
  throw error;
}

export function createAdminPriceService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    ...event,
  }, { database });

  return {
    async list(planIdValue) {
      const planId = positiveId(planIdValue, 'PLAN_NOT_FOUND', '找不到方案。');
      const result = mapResult((await listPriceRows({ databasePath, planId })));
      return result.rows.map(priceDto);
    },
    async create(planIdValue, payload, actor, requestAudit = {}) {
      const planId = positiveId(planIdValue, 'PLAN_NOT_FOUND', '找不到方案。');
      const createdAt = nextTimestamp(clock);
      const values = {
        ...priceValues(planId, payload, PRICE_FIELDS),
        createdAt,
        updatedAt: createdAt,
      };
      try {
        const result = mapResult((await createPriceRow({
          databasePath,
          planId,
          values,
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'PLAN_PRICE_CREATED', entityType: 'PLAN_PRICE', entityId: String(row.id),
              after: { isActive: Boolean(row.is_active), priority: Number(row.priority) },
              allowedFields: ['isActive', 'priority'],
            }, database);
          },
        })));
        return priceDto(result.row);
      } catch (error) {
        if (error instanceof AdminPriceError) throw error;
        mapConstraint(error);
      }
    },
    async update(planIdValue, priceIdValue, payload, actor, requestAudit = {}) {
      const planId = positiveId(planIdValue, 'PLAN_NOT_FOUND', '找不到方案。');
      const priceId = positiveId(priceIdValue, 'PRICE_NOT_FOUND', '找不到價格期間。');
      const expected = expectedUpdatedAt(payload);
      const values = priceValues(planId, payload, UPDATE_FIELDS);
      try {
        const result = mapResult((await updatePriceRow({
          databasePath,
          planId,
          priceId,
          expectedUpdatedAt: expected,
          updatedAt: nextTimestamp(clock, expected),
          values,
          async afterWrite(database, before, after) {
            await audit(actor, requestAudit, {
              action: 'PLAN_PRICE_UPDATED', entityType: 'PLAN_PRICE', entityId: String(priceId),
              before: { isActive: Boolean(before.is_active), priority: Number(before.priority) },
              after: { isActive: Boolean(after.is_active), priority: Number(after.priority) },
              allowedFields: ['isActive', 'priority'],
            }, database);
          },
        })));
        return priceDto(result.row);
      } catch (error) {
        if (error instanceof AdminPriceError) throw error;
        mapConstraint(error);
      }
    },
    async delete(planIdValue, priceIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const planId = positiveId(planIdValue, 'PLAN_NOT_FOUND', '找不到方案。');
      const priceId = positiveId(priceIdValue, 'PRICE_NOT_FOUND', '找不到價格期間。');
      const result = mapResult((await deletePriceRow({
        databasePath,
        planId,
        priceId,
        expectedUpdatedAt: expectedUpdatedAt(payload),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, {
            action: 'PLAN_PRICE_DELETED', entityType: 'PLAN_PRICE', entityId: String(priceId),
            before: { isActive: Boolean(row.is_active), priority: Number(row.priority) },
            allowedFields: ['isActive', 'priority'],
          }, database);
        },
      })));
      return { deleted: true, id: priceId };
    },
  };
}
