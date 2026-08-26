import { convertInquiryRows } from './inquiry-conversion-repository.mjs';

const TOP_FIELDS = new Set(['customer', 'expectedUpdatedAt', 'location']);
const NEW_CUSTOMER_FIELDS = new Set(['customerType', 'displayName', 'legalName', 'mode']);
const EXISTING_CUSTOMER_FIELDS = new Set(['customerId', 'mode']);
const LOCATION_FIELDS = new Set([
  'accessNotes', 'addressLine', 'city', 'create', 'district', 'floorUnit',
  'postalCode', 'serviceAreaId', 'status',
]);
const CUSTOMER_TYPES = new Set(['PERSON', 'BUSINESS']);
const LOCATION_STATUSES = new Set(['PENDING_SURVEY', 'SERVICEABLE', 'UNSERVICEABLE', 'INACTIVE']);

export class InquiryConversionError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'InquiryConversionError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new InquiryConversionError(422, 'INVALID_BODY', '轉換資料驗證失敗。', [{ field, message }]);
}

function objectPayload(value, field, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '必須為物件。');
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length) {
    throw new InquiryConversionError(422, 'INVALID_BODY', '包含不允許的欄位。', unknown.map(
      (key) => ({ field: field ? `${field}.${key}` : key, message: '此欄位不允許。' }),
    ));
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    fail(field, `必須為 1 至 ${maxLength} 個字元。`);
  }
  return value.trim();
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    fail(field, `最多 ${maxLength} 個字元。`);
  }
  return value.trim();
}

function positiveId(value, field) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) fail(field, '必須為正整數。');
  return number;
}

function parsePayload(payload, inquiryId) {
  objectPayload(payload, '', TOP_FIELDS);
  if (
    typeof payload.expectedUpdatedAt !== 'string'
    || Number.isNaN(Date.parse(payload.expectedUpdatedAt))
    || new Date(payload.expectedUpdatedAt).toISOString() !== payload.expectedUpdatedAt
  ) {
    fail('expectedUpdatedAt', '必須為 UTC ISO 8601 時間。');
  }

  if (!payload.customer || !['NEW', 'EXISTING'].includes(payload.customer.mode)) {
    fail('customer.mode', '必須為 NEW 或 EXISTING。');
  }
  const customer = payload.customer.mode === 'NEW'
    ? (() => {
      objectPayload(payload.customer, 'customer', NEW_CUSTOMER_FIELDS);
      if (!CUSTOMER_TYPES.has(payload.customer.customerType)) fail('customer.customerType', '值不允許。');
      return {
        mode: 'NEW',
        customerNo: `C-${String(inquiryId).padStart(8, '0')}`,
        customerType: payload.customer.customerType,
        displayName: requiredText(payload.customer.displayName, 'customer.displayName', 150),
        legalName: optionalText(payload.customer.legalName, 'customer.legalName', 200),
      };
    })()
    : (() => {
      objectPayload(payload.customer, 'customer', EXISTING_CUSTOMER_FIELDS);
      return { mode: 'EXISTING', customerId: positiveId(payload.customer.customerId, 'customer.customerId') };
    })();

  objectPayload(payload.location, 'location', LOCATION_FIELDS);
  if (typeof payload.location.create !== 'boolean') fail('location.create', '必須為布林值。');
  let location = { create: false };
  if (payload.location.create) {
    const serviceAreaId = payload.location.serviceAreaId === null || payload.location.serviceAreaId === undefined
      ? null
      : positiveId(payload.location.serviceAreaId, 'location.serviceAreaId');
    if (!LOCATION_STATUSES.has(payload.location.status)) fail('location.status', '值不允許。');
    location = {
      create: true,
      locationNo: `L-${String(inquiryId).padStart(8, '0')}`,
      serviceAreaId,
      postalCode: optionalText(payload.location.postalCode, 'location.postalCode', 10),
      city: requiredText(payload.location.city, 'location.city', 30),
      district: requiredText(payload.location.district, 'location.district', 30),
      addressLine: requiredText(payload.location.addressLine, 'location.addressLine', 255),
      floorUnit: optionalText(payload.location.floorUnit, 'location.floorUnit', 50),
      accessNotes: optionalText(payload.location.accessNotes, 'location.accessNotes', 2_000),
      status: payload.location.status,
    };
  } else if (Object.keys(payload.location).length !== 1) {
    fail('location', '不建立地址時只能提供 create。');
  }
  return { expectedUpdatedAt: payload.expectedUpdatedAt, customer, location };
}

function timestamp(clock) {
  const date = new Date(clock());
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid inquiry conversion clock value');
  return date.toISOString();
}

export function createInquiryConversionService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  return {
    async convert(inquiryIdValue, payload, actor, requestAudit = {}) {
      const inquiryId = positiveId(inquiryIdValue, 'id');
      const parsed = parsePayload(payload, inquiryId);
      const result = (await convertInquiryRows({
        databasePath,
        inquiryId,
        expectedUpdatedAt: parsed.expectedUpdatedAt,
        conversion: {
          ...parsed,
          orderNo: `O-${String(inquiryId).padStart(8, '0')}`,
          actorStaffUserId: actor.id,
          timestamp: timestamp(clock),
        },
        validate({ inquiry, customer, area }) {
          if (inquiry.status !== 'QUALIFIED') {
            throw new InquiryConversionError(422, 'INQUIRY_NOT_QUALIFIED', '洽詢尚未完成需求確認。');
          }
          if (parsed.customer.mode === 'EXISTING' && (!customer || customer.status === 'CLOSED')) {
            throw new InquiryConversionError(422, 'INVALID_CUSTOMER', '既有客戶不存在或已結束。');
          }
          if (parsed.location.create) {
            if (parsed.location.serviceAreaId !== null && (!area || !area.is_active)) {
              throw new InquiryConversionError(422, 'INVALID_SERVICE_AREA', '服務區不存在或已停用。');
            }
            if (parsed.location.status === 'SERVICEABLE' && !area) {
              throw new InquiryConversionError(422, 'INVALID_SERVICE_AREA', '可供裝地址必須連結有效服務區。');
            }
          }
        },
        async afterWrite(database, inquiry) {
          await auditService.record({
            actorStaffUserId: actor.id,
            action: 'INQUIRY_CONVERTED',
            entityType: 'SERVICE_INQUIRY',
            entityId: String(inquiryId),
            requestId: requestAudit.requestId,
            ipAddress: requestAudit.ipAddress,
            userAgent: requestAudit.userAgent,
            before: { status: inquiry.status },
            after: { status: 'CONVERTED' },
            allowedFields: ['status'],
          }, { database });
        },
      }));
      if (result.kind === 'not-found') throw new InquiryConversionError(404, 'INQUIRY_NOT_FOUND', '找不到洽詢。');
      if (result.kind === 'already-converted') {
        throw new InquiryConversionError(409, 'INQUIRY_ALREADY_CONVERTED', '洽詢已完成轉換。');
      }
      if (result.kind === 'conflict') {
        throw new InquiryConversionError(409, 'INQUIRY_CONFLICT', '洽詢已被其他人更新。');
      }
      return result.result;
    },
  };
}
