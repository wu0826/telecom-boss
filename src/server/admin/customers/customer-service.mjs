import {
  createContactRow,
  createCustomerRow,
  createLocationRow,
  exportCustomerRows,
  findCustomerRecord,
  listActiveServiceAreaRows,
  searchCustomerRows,
  updateContactRow,
  updateCustomerRow,
  updateLocationRow,
} from './customer-repository.mjs';

const CUSTOMER_TYPES = new Set(['PERSON', 'BUSINESS']);
const CUSTOMER_STATUSES = new Set(['LEAD', 'ACTIVE', 'SUSPENDED', 'CLOSED']);
const CONTACT_TYPES = new Set(['PRIMARY', 'BILLING', 'TECHNICAL', 'OTHER']);
const LOCATION_STATUSES = new Set(['PENDING_SURVEY', 'SERVICEABLE', 'UNSERVICEABLE', 'INACTIVE']);
const CUSTOMER_FIELDS = new Set(['customerNo', 'customerType', 'displayName', 'legalName', 'status']);
const CUSTOMER_UPDATE_FIELDS = new Set(['customerType', 'displayName', 'legalName', 'status']);
const CONTACT_FIELDS = new Set(['contactName', 'contactType', 'email', 'isActive', 'isPrimary', 'phone']);
const LOCATION_FIELDS = new Set([
  'accessNotes', 'addressLine', 'city', 'district', 'floorUnit', 'locationNo',
  'postalCode', 'serviceAreaId', 'status',
]);
const LOCATION_UPDATE_FIELDS = new Set([...LOCATION_FIELDS].filter((field) => field !== 'locationNo'));
const QUERY_FIELDS = new Set(['customerType', 'direction', 'page', 'pageSize', 'q', 'sort', 'status']);
const EXPORT_QUERY_FIELDS = new Set(['customerType', 'direction', 'q', 'sort', 'status']);
const SORTS = new Set(['createdAt', 'customerNo', 'displayName', 'status']);
const EXPORT_LIMIT = 500;
const EXPORT_BASE_COLUMNS = Object.freeze(['customerNo', 'displayName', 'customerType', 'status']);
const EXPORT_SENSITIVE_COLUMNS = Object.freeze([
  'primaryContactName', 'maskedPhone', 'maskedEmail', 'maskedAddress',
]);
const TECHNOLOGIES = Object.freeze({
  VDSL2: ['VDSL2'], FTTH: ['FTTH'], LEASED_LINE: ['LEASED_LINE'], MIXED: ['VDSL2', 'FTTH'],
});

export class AdminCustomerError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminCustomerError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message, code = 'INVALID_BODY') {
  throw new AdminCustomerError(422, code, '客戶資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, allowedFields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminCustomerError(422, 'INVALID_BODY', '請提供有效的 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unknown.length) {
    throw new AdminCustomerError(422, 'INVALID_BODY', '包含不允許的欄位。', unknown.map(
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

function enumField(payload, field, allowed) {
  if (!allowed.has(payload[field])) fail(field, '值不在允許範圍內。');
  return payload[field];
}

function booleanField(payload, field) {
  if (typeof payload[field] !== 'boolean') fail(field, '必須為布林值。');
  return payload[field];
}

function positiveId(value, field = 'id', { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) fail(field, '必須為正整數。');
  return number;
}

function nowIso(clock) {
  const value = new Date(clock());
  if (Number.isNaN(value.valueOf())) throw new TypeError('Invalid customer clock value');
  return value.toISOString();
}

function utcIso(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function maskPhone(value) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
}

function maskEmail(value) {
  if (!value) return null;
  const [local, domain] = value.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

function maskAddress(row) {
  const locality = [row.city, row.district].filter(Boolean).join('');
  if (locality) return `${locality}***`;
  return row.address_line || row.floor_unit ? '***' : null;
}

function escapeSpreadsheetCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${escapeSpreadsheetCell(value).replaceAll('"', '""')}"`;
}

function createCsv(columns, rows) {
  return [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n');
}

function customerDto(row) {
  return {
    id: Number(row.id), customerNo: row.customer_no, customerType: row.customer_type,
    displayName: row.display_name, legalName: row.legal_name, status: row.status,
    createdAt: utcIso(row.created_at), updatedAt: utcIso(row.updated_at),
  };
}

function contactDto(row, { revealSensitive = false } = {}) {
  return {
    id: Number(row.id), contactName: row.contact_name, contactType: row.contact_type,
    phone: revealSensitive ? row.phone : maskPhone(row.phone),
    email: revealSensitive ? row.email : maskEmail(row.email),
    isPrimary: Boolean(row.is_primary), isActive: Boolean(row.is_active),
    createdAt: utcIso(row.created_at), updatedAt: utcIso(row.updated_at),
  };
}

function locationDto(row, { revealSensitive = false } = {}) {
  const result = {
    id: Number(row.id), locationNo: row.location_no,
    serviceArea: row.service_area_id === null ? null : {
      id: Number(row.service_area_id), code: row.area_code, name: row.area_name,
    },
    postalCode: row.postal_code, city: row.city, district: row.district,
    addressLine: row.address_line, floorUnit: row.floor_unit, status: row.status,
    allowedTechnologies: row.service_area_active ? [...(TECHNOLOGIES[row.access_technology] ?? [])] : [],
    createdAt: utcIso(row.created_at), updatedAt: utcIso(row.updated_at),
  };
  if (revealSensitive) result.accessNotes = row.access_notes;
  return result;
}

function recordDto(record, options) {
  return {
    ...customerDto(record.customer),
    contacts: record.contacts.map((row) => contactDto(row, options)),
    locations: record.locations.map((row) => locationDto(row, options)),
  };
}

function parseQuery(params) {
  for (const field of params.keys()) {
    if (!QUERY_FIELDS.has(field)) fail(field, '此查詢欄位不允許。', 'INVALID_QUERY');
  }
  const keyword = (params.get('q') ?? '').trim();
  if (keyword.length > 100) fail('q', '最多 100 個字元。', 'INVALID_QUERY');
  const page = positiveId(params.get('page') || 1, 'page');
  const pageSize = positiveId(params.get('pageSize') || 20, 'pageSize');
  if (pageSize > 100) fail('pageSize', '最多 100 筆。', 'INVALID_QUERY');
  const customerType = params.get('customerType') || null;
  if (customerType !== null && !CUSTOMER_TYPES.has(customerType)) fail('customerType', '值不在允許範圍內。', 'INVALID_QUERY');
  const status = params.get('status') || null;
  if (status !== null && !CUSTOMER_STATUSES.has(status)) fail('status', '值不在允許範圍內。', 'INVALID_QUERY');
  const sort = params.get('sort') || 'createdAt';
  if (!SORTS.has(sort)) fail('sort', '值不在允許範圍內。', 'INVALID_QUERY');
  const direction = params.get('direction') || 'desc';
  if (!['asc', 'desc'].includes(direction)) fail('direction', '值不在允許範圍內。', 'INVALID_QUERY');
  return { keyword, customerType, status, page, pageSize, sort, direction };
}

function parseExportQuery(params) {
  for (const field of params.keys()) {
    if (!EXPORT_QUERY_FIELDS.has(field)) fail(field, '此查詢欄位不允許。', 'INVALID_QUERY');
    if (params.getAll(field).length > 1) fail(field, '不可重複提供查詢欄位。', 'INVALID_QUERY');
  }
  const keyword = (params.get('q') ?? '').trim();
  if (keyword.length > 100) fail('q', '最多 100 個字元。', 'INVALID_QUERY');
  const customerType = params.get('customerType') || null;
  if (customerType !== null && !CUSTOMER_TYPES.has(customerType)) fail('customerType', '值不在允許範圍內。', 'INVALID_QUERY');
  const status = params.get('status') || null;
  if (status !== null && !CUSTOMER_STATUSES.has(status)) fail('status', '值不在允許範圍內。', 'INVALID_QUERY');
  const sort = params.get('sort') || 'createdAt';
  if (!SORTS.has(sort)) fail('sort', '值不在允許範圍內。', 'INVALID_QUERY');
  const direction = params.get('direction') || 'desc';
  if (!['asc', 'desc'].includes(direction)) fail('direction', '值不在允許範圍內。', 'INVALID_QUERY');
  return {
    keyword,
    customerType,
    status,
    sort,
    direction,
    filterFields: [...new Set(params.keys())],
  };
}

function customerValues(payload, allowedFields, { includeCustomerNo }) {
  objectPayload(payload, allowedFields);
  const result = {
    customerType: enumField(payload, 'customerType', CUSTOMER_TYPES),
    displayName: requiredText(payload, 'displayName', 150),
    legalName: optionalText(payload, 'legalName', 200),
    status: enumField(payload, 'status', CUSTOMER_STATUSES),
  };
  if (includeCustomerNo) result.customerNo = requiredText(payload, 'customerNo', 32);
  return result;
}

function contactValues(payload) {
  objectPayload(payload, CONTACT_FIELDS);
  const values = {
    contactName: requiredText(payload, 'contactName', 100),
    contactType: enumField(payload, 'contactType', CONTACT_TYPES),
    phone: optionalText(payload, 'phone', 30),
    email: optionalText(payload, 'email', 191),
    isPrimary: booleanField(payload, 'isPrimary'),
    isActive: booleanField(payload, 'isActive'),
  };
  if (!values.phone && !values.email) fail('phone', '電話與 Email 至少需提供一項。');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fail('email', 'Email 格式不正確。');
  if (values.isPrimary && !values.isActive) fail('isPrimary', '主要聯絡人必須啟用。');
  return values;
}

function locationValues(payload, allowedFields, { includeLocationNo }) {
  objectPayload(payload, allowedFields);
  const result = {
    serviceAreaId: positiveId(payload.serviceAreaId, 'serviceAreaId', { nullable: true }),
    postalCode: optionalText(payload, 'postalCode', 10),
    city: requiredText(payload, 'city', 30),
    district: requiredText(payload, 'district', 30),
    addressLine: requiredText(payload, 'addressLine', 255),
    floorUnit: optionalText(payload, 'floorUnit', 50),
    accessNotes: optionalText(payload, 'accessNotes', 2_000),
    status: enumField(payload, 'status', LOCATION_STATUSES),
  };
  if (includeLocationNo) result.locationNo = requiredText(payload, 'locationNo', 32);
  return result;
}

function validatePrimary(values, primaryExists) {
  if (values.isPrimary && values.isActive && primaryExists) {
    throw new AdminCustomerError(409, 'PRIMARY_CONTACT_CONFLICT', '每位客戶只能有一位啟用中的主要聯絡人。');
  }
}

function validateArea(values, area) {
  if (values.serviceAreaId !== null && (!area || !area.is_active)) {
    throw new AdminCustomerError(422, 'INVALID_SERVICE_AREA', '服務區不存在或已停用。', [
      { field: 'serviceAreaId', message: '請選擇啟用中的服務區。' },
    ]);
  }
  if (values.status === 'SERVICEABLE' && !area) {
    throw new AdminCustomerError(422, 'INVALID_SERVICE_AREA', '可供裝地址必須連結啟用中的服務區。', [
      { field: 'serviceAreaId', message: '可供裝地址需要有效服務區。' },
    ]);
  }
}

function mapConstraint(error, field, code) {
  if (error?.constraintKind === 'unique' || /UNIQUE constraint failed/i.test(error?.message ?? '')) {
    throw new AdminCustomerError(409, code, `${field} 已存在。`, [{ field, message: '值不可重複。' }]);
  }
  throw error;
}

export function createAdminCustomerService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    ...event,
  }, { database });

  return {
    async list(params) {
      const query = parseQuery(params);
      const { rows, total } = (await searchCustomerRows({ databasePath, query }));
      return { data: rows.map(customerDto), total, page: query.page, pageSize: query.pageSize };
    },
    async exportCsv(params, actor, permissions, requestAudit = {}) {
      const query = parseExportQuery(params);
      const includeSensitiveColumns = permissions.includes('customer.sensitive.read');
      const columns = includeSensitiveColumns
        ? [...EXPORT_BASE_COLUMNS, ...EXPORT_SENSITIVE_COLUMNS]
        : [...EXPORT_BASE_COLUMNS];
      const rows = (await exportCustomerRows({ databasePath, query, limit: EXPORT_LIMIT })).map((row) => ({
        customerNo: row.customer_no,
        displayName: row.display_name,
        customerType: row.customer_type,
        status: row.status,
        primaryContactName: row.contact_name,
        maskedPhone: maskPhone(row.phone),
        maskedEmail: maskEmail(row.email),
        maskedAddress: maskAddress(row),
      }));
      await audit(actor, requestAudit, {
        action: 'CUSTOMER_EXPORT_CREATED', entityType: 'CUSTOMER_EXPORT', entityId: 'CUSTOMERS',
        after: { filterFields: query.filterFields, columnSet: columns, rowCount: rows.length },
        allowedFields: ['filterFields', 'columnSet', 'rowCount'],
      });
      return { csv: createCsv(columns, rows), rowCount: rows.length };
    },
    async detail(customerId, { revealSensitive = false } = {}) {
      const id = positiveId(customerId);
      const record = (await findCustomerRecord({ databasePath, customerId: id }));
      if (!record) throw new AdminCustomerError(404, 'CUSTOMER_NOT_FOUND', '找不到客戶。');
      return recordDto(record, { revealSensitive });
    },
    async serviceAreas() {
      return (await listActiveServiceAreaRows(databasePath)).map((row) => ({
        id: Number(row.id), code: row.area_code, name: row.area_name,
        postalCode: row.postal_code, city: row.city, district: row.district,
        allowedTechnologies: [...(TECHNOLOGIES[row.access_technology] ?? [])],
      }));
    },
    async create(payload, actor, requestAudit = {}) {
      const values = customerValues(payload, CUSTOMER_FIELDS, { includeCustomerNo: true });
      const timestamp = nowIso(clock);
      try {
        return customerDto((await createCustomerRow({
          databasePath,
          values: { ...values, createdAt: timestamp, updatedAt: timestamp },
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'CUSTOMER_CREATED', entityType: 'CUSTOMER', entityId: String(row.id),
              after: { status: row.status }, allowedFields: ['status'],
            }, database);
          },
        })));
      } catch (error) {
        mapConstraint(error, 'customerNo', 'CUSTOMER_NO_CONFLICT');
      }
    },
    async update(customerId, payload, actor, requestAudit = {}) {
      const id = positiveId(customerId);
      const values = customerValues(payload, CUSTOMER_UPDATE_FIELDS, { includeCustomerNo: false });
      const row = (await updateCustomerRow({
        databasePath, customerId: id, values: { ...values, updatedAt: nowIso(clock) },
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: 'CUSTOMER_UPDATED', entityType: 'CUSTOMER', entityId: String(id),
            before: { status: before.status }, after: { status: after.status }, allowedFields: ['status'],
          }, database);
        },
      }));
      if (!row) throw new AdminCustomerError(404, 'CUSTOMER_NOT_FOUND', '找不到客戶。');
      return customerDto(row);
    },
    async createContact(customerId, payload, actor, requestAudit = {}) {
      const id = positiveId(customerId);
      const values = contactValues(payload);
      const timestamp = nowIso(clock);
      const result = (await createContactRow({
        databasePath, customerId: id, values: { ...values, createdAt: timestamp, updatedAt: timestamp },
        validate({ primaryExists }) { validatePrimary(values, primaryExists); },
        async afterWrite(database, row) {
          await audit(actor, requestAudit, {
            action: 'CUSTOMER_CONTACT_CREATED', entityType: 'CUSTOMER_CONTACT', entityId: String(row.id),
            after: { isActive: Boolean(row.is_active) }, allowedFields: ['isActive'],
          }, database);
        },
      }));
      if (result.kind === 'customer-not-found') throw new AdminCustomerError(404, 'CUSTOMER_NOT_FOUND', '找不到客戶。');
      return contactDto(result.row, { revealSensitive: true });
    },
    async updateContact(customerId, contactId, payload, actor, requestAudit = {}) {
      const customer = positiveId(customerId, 'customerId');
      const contact = positiveId(contactId, 'contactId');
      const values = contactValues(payload);
      const row = (await updateContactRow({
        databasePath, customerId: customer, contactId: contact,
        values: { ...values, updatedAt: nowIso(clock) },
        validate({ primaryExists }) { validatePrimary(values, primaryExists); },
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: 'CUSTOMER_CONTACT_UPDATED', entityType: 'CUSTOMER_CONTACT', entityId: String(contact),
            before: { isActive: Boolean(before.is_active) }, after: { isActive: Boolean(after.is_active) },
            allowedFields: ['isActive'],
          }, database);
        },
      }));
      if (!row) throw new AdminCustomerError(404, 'CONTACT_NOT_FOUND', '找不到聯絡人。');
      return contactDto(row, { revealSensitive: true });
    },
    async createLocation(customerId, payload, actor, requestAudit = {}) {
      const id = positiveId(customerId);
      const values = locationValues(payload, LOCATION_FIELDS, { includeLocationNo: true });
      const timestamp = nowIso(clock);
      try {
        const result = (await createLocationRow({
          databasePath, customerId: id,
          values: { ...values, createdAt: timestamp, updatedAt: timestamp },
          validate({ area }) { validateArea(values, area); },
          async afterWrite(database, row) {
            await audit(actor, requestAudit, {
              action: 'SERVICE_LOCATION_CREATED', entityType: 'SERVICE_LOCATION', entityId: String(row.id),
              after: { status: row.status }, allowedFields: ['status'],
            }, database);
          },
        }));
        if (result.kind === 'customer-not-found') throw new AdminCustomerError(404, 'CUSTOMER_NOT_FOUND', '找不到客戶。');
        return locationDto(result.row, { revealSensitive: true });
      } catch (error) {
        if (error instanceof AdminCustomerError) throw error;
        mapConstraint(error, 'locationNo', 'LOCATION_NO_CONFLICT');
      }
    },
    async updateLocation(customerId, locationId, payload, actor, requestAudit = {}) {
      const customer = positiveId(customerId, 'customerId');
      const location = positiveId(locationId, 'locationId');
      const values = locationValues(payload, LOCATION_UPDATE_FIELDS, { includeLocationNo: false });
      const row = (await updateLocationRow({
        databasePath, customerId: customer, locationId: location,
        values: { ...values, updatedAt: nowIso(clock) },
        validate({ area }) { validateArea(values, area); },
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: 'SERVICE_LOCATION_UPDATED', entityType: 'SERVICE_LOCATION', entityId: String(location),
            before: { status: before.status }, after: { status: after.status }, allowedFields: ['status'],
          }, database);
        },
      }));
      if (!row) throw new AdminCustomerError(404, 'LOCATION_NOT_FOUND', '找不到服務地址。');
      return locationDto(row, { revealSensitive: true });
    },
  };
}
