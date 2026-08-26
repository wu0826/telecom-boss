import {
  findInquiryRow,
  listEligibleInquiryAssignees,
  searchInquiryRows,
  updateInquiryWorkflowRow,
} from './inquiry-repository.mjs';

const ALLOWED_QUERY_FIELDS = new Set([
  'assigneeId', 'channel', 'direction', 'from', 'page', 'pageSize', 'planId', 'q', 'sort', 'status', 'to',
]);
const CHANNELS = new Set(['WEB', 'PHONE', 'STORE', 'PARTNER', 'OTHER']);
const STATUSES = new Set(['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'CLOSED']);
const SORTS = new Set(['createdAt', 'inquiryNo', 'status']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UPDATE_FIELDS = new Set(['assignedStaffUserId', 'expectedUpdatedAt', 'status']);
const TERMINAL_STATUSES = new Set(['CONVERTED', 'CLOSED']);
const TRANSITIONS = new Map([
  ['NEW', new Set(['CONTACTED'])],
  ['CONTACTED', new Set(['QUALIFIED', 'CLOSED'])],
  ['QUALIFIED', new Set(['CLOSED'])],
]);

export class AdminInquiryError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminInquiryError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalid(field, message) {
  throw new AdminInquiryError(422, 'INVALID_QUERY', '洽詢查詢條件無效。', [{ field, message }]);
}

function integerValue(params, field, { defaultValue = null, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = params.get(field);
  if (value === null || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) invalid(field, '必須是正整數。');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) invalid(field, `必須介於 1 與 ${max}。`);
  return number;
}

function enumValue(params, field, allowed, defaultValue = null) {
  const value = params.get(field);
  if (value === null || value === '') return defaultValue;
  if (!allowed.has(value)) invalid(field, '不支援此值。');
  return value;
}

function dateValue(params, field) {
  const value = params.get(field);
  if (value === null || value === '') return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !DATE_PATTERN.test(value)
    || Number.isNaN(parsed.valueOf())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    invalid(field, '日期格式必須為 YYYY-MM-DD。');
  }
  return value;
}

function nextUtcDate(value) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000).toISOString();
}

export function parseInquiryQuery(params) {
  for (const field of params.keys()) {
    if (!ALLOWED_QUERY_FIELDS.has(field)) invalid(field, '不支援此查詢欄位。');
  }
  const keyword = (params.get('q') ?? '').trim();
  if (keyword.length > 100) invalid('q', '搜尋字串不可超過 100 字。');
  const from = dateValue(params, 'from');
  const to = dateValue(params, 'to');
  if (from && to && from > to) invalid('to', '結束日期不可早於開始日期。');
  return {
    keyword,
    planId: integerValue(params, 'planId'),
    channel: enumValue(params, 'channel', CHANNELS),
    status: enumValue(params, 'status', STATUSES),
    assigneeId: integerValue(params, 'assigneeId'),
    fromAt: from ? `${from}T00:00:00.000Z` : null,
    toAt: to ? nextUtcDate(to) : null,
    page: integerValue(params, 'page', { defaultValue: 1 }),
    pageSize: integerValue(params, 'pageSize', { defaultValue: 20, max: 100 }),
    sort: enumValue(params, 'sort', SORTS, 'createdAt'),
    direction: enumValue(params, 'direction', new Set(['asc', 'desc']), 'desc'),
  };
}

function maskName(value) {
  if (!value) return null;
  const characters = [...value];
  return `${characters[0]}${'*'.repeat(Math.min(3, Math.max(1, characters.length - 1)))}`;
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

function utcIso(value) {
  if (!value) return null;
  if(value instanceof Date) {
    return value.toISOString();
}
  const text = String(value);
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).toISOString();
}

function sharedDto(row, { revealContact = false } = {}) {
  return {
    id: Number(row.id),
    inquiryNo: row.inquiry_no,
    prospectName: revealContact ? row.prospect_name : maskName(row.prospect_name),
    phone: revealContact ? row.phone : maskPhone(row.phone),
    email: revealContact ? row.email : maskEmail(row.email),
    requestedPlan: row.plan_id === null ? null : {
      id: Number(row.plan_id),
      code: row.plan_code,
      name: row.plan_name,
    },
    channel: row.channel,
    status: row.status,
    assignee: row.assignee_id === null ? null : {
      id: Number(row.assignee_id),
      displayName: row.assignee_name,
    },
    createdAt: utcIso(row.created_at),
    updatedAt: utcIso(row.updated_at),
  };
}

function validateWorkflowPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '洽詢更新內容無效。');
  }
  const unknown = Object.keys(payload).filter((field) => !UPDATE_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '洽詢更新內容無效。', unknown.map(
      (field) => ({ field, message: '不支援此欄位。' }),
    ));
  }
  if (
    typeof payload.expectedUpdatedAt !== 'string'
    || Number.isNaN(Date.parse(payload.expectedUpdatedAt))
    || new Date(payload.expectedUpdatedAt).toISOString() !== payload.expectedUpdatedAt
  ) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '洽詢更新內容無效。', [
      { field: 'expectedUpdatedAt', message: '必須提供目前版本時間。' },
    ]);
  }
  const hasAssignment = Object.hasOwn(payload, 'assignedStaffUserId');
  const hasStatus = Object.hasOwn(payload, 'status');
  if (!hasAssignment && !hasStatus) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '至少必須變更承辦人或狀態。');
  }
  if (
    hasAssignment
    && payload.assignedStaffUserId !== null
    && (!Number.isSafeInteger(payload.assignedStaffUserId) || payload.assignedStaffUserId < 1)
  ) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '洽詢更新內容無效。', [
      { field: 'assignedStaffUserId', message: '承辦人必須是有效帳號。' },
    ]);
  }
  if (hasStatus && !STATUSES.has(payload.status)) {
    throw new AdminInquiryError(422, 'INVALID_BODY', '洽詢更新內容無效。', [
      { field: 'status', message: '不支援此狀態。' },
    ]);
  }
  return { ...payload, hasAssignment, hasStatus };
}

function nextUpdateTime(clock, currentUpdatedAt) {
  const clockValue = new Date(clock()).valueOf();
  if (Number.isNaN(clockValue)) throw new TypeError('Invalid inquiry workflow clock value');
  return new Date(Math.max(clockValue, Date.parse(currentUpdatedAt) + 1)).toISOString();
}

export function createAdminInquiryService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  if (typeof clock !== 'function') throw new TypeError('inquiry workflow clock must be a function');
  return {
    async assignees() {
      return (await listEligibleInquiryAssignees(databasePath)).map((row) => ({
        id: Number(row.id),
        staffNo: row.staff_no,
        displayName: row.display_name,
        department: row.department,
      }));
    },
    async list(params) {
      const query = parseInquiryQuery(params);
      const { rows, total } = (await searchInquiryRows({ databasePath, query }));
      return {
        data: rows.map((row) => sharedDto(row)),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },
    async detail(inquiryId, permissions) {
      if (!Number.isSafeInteger(inquiryId) || inquiryId < 1) {
        throw new AdminInquiryError(404, 'INQUIRY_NOT_FOUND', '找不到指定洽詢。');
      }
      const row = (await findInquiryRow({ databasePath, inquiryId }));
      if (!row) throw new AdminInquiryError(404, 'INQUIRY_NOT_FOUND', '找不到指定洽詢。');
      const revealContact = permissions.includes('customer.write');
      const dto = sharedDto(row, { revealContact });
      if (revealContact) dto.addressText = row.address_text;
      return dto;
    },
    async update(inquiryId, payload, actor, requestAudit = {}) {
      if (!Number.isSafeInteger(inquiryId) || inquiryId < 1) {
        throw new AdminInquiryError(404, 'INQUIRY_NOT_FOUND', '找不到指定洽詢。');
      }
      const update = validateWorkflowPayload(payload);
      const result = (await updateInquiryWorkflowRow({
        databasePath,
        inquiryId,
        expectedUpdatedAt: update.expectedUpdatedAt,
        requestedAssigneeId: update.hasAssignment ? update.assignedStaffUserId : null,
        updatedAt: nextUpdateTime(clock, update.expectedUpdatedAt),
        validate({ current, assigneeEligible }) {
          if (TERMINAL_STATUSES.has(current.status)) {
            throw new AdminInquiryError(422, 'TERMINAL_INQUIRY', '已結束的洽詢不可再修改。');
          }
          const nextStatus = update.hasStatus ? update.status : current.status;
          const nextAssignee = update.hasAssignment
            ? update.assignedStaffUserId
            : current.assigned_staff_user_id;
          if (update.hasStatus && !TRANSITIONS.get(current.status)?.has(nextStatus)) {
            throw new AdminInquiryError(422, 'INVALID_TRANSITION', '不允許此洽詢狀態轉換。');
          }
          if (update.hasAssignment && nextAssignee !== null && !assigneeEligible) {
            throw new AdminInquiryError(422, 'ASSIGNEE_NOT_ELIGIBLE', '承辦人未啟用或缺少客服處理權限。');
          }
          if (nextStatus === current.status && nextAssignee === current.assigned_staff_user_id) {
            throw new AdminInquiryError(422, 'NO_CHANGES', '沒有可套用的變更。');
          }
          return { assignedStaffUserId: nextAssignee, status: nextStatus };
        },
        async afterUpdate(database, before, after) {
          await auditService.record({
            actorStaffUserId: actor.id,
            action: 'INQUIRY_WORKFLOW_UPDATED',
            entityType: 'SERVICE_INQUIRY',
            entityId: String(inquiryId),
            requestId: requestAudit.requestId,
            ipAddress: requestAudit.ipAddress,
            userAgent: requestAudit.userAgent,
            before: {
              assignedStaffUserId: before.assigned_staff_user_id,
              status: before.status,
            },
            after: {
              assignedStaffUserId: after.assignee_id,
              status: after.status,
            },
            allowedFields: ['assignedStaffUserId', 'status'],
          }, { database });
        },
      }));
      if (result.kind === 'not-found') {
        throw new AdminInquiryError(404, 'INQUIRY_NOT_FOUND', '找不到指定洽詢。');
      }
      if (result.kind === 'conflict') {
        throw new AdminInquiryError(409, 'INQUIRY_CONFLICT', '洽詢已被其他人更新，請重新載入。');
      }
      return sharedDto(result.row, { revealContact: true });
    },
  };
}
