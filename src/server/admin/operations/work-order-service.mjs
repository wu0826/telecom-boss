import {
  createWorkOrder, findWorkOrderDetail, listWorkOrderRows, transitionWorkOrder,
} from './work-order-repository.mjs';
import { provisionSubscriptionFromCompletedInstall } from '../subscriptions/subscription-repository.mjs';

const CREATE_FIELDS = new Set([
  'priority', 'problemDescription', 'salesOrderId', 'serviceLocationId',
  'subscriptionId', 'workType',
]);
const ACTION_FIELDS = new Map([
  ['assign', new Set(['assignedStaffUserId', 'expectedUpdatedAt'])],
  ['schedule', new Set(['expectedUpdatedAt', 'scheduledAt'])],
  ['start', new Set(['expectedUpdatedAt'])],
  ['complete', new Set(['expectedUpdatedAt', 'installationVerified', 'resolutionNotes'])],
  ['cancel', new Set(['expectedUpdatedAt', 'reason'])],
]);
const WORK_TYPES = new Set(['SURVEY', 'INSTALL', 'REPAIR', 'MAINTENANCE', 'RELOCATION', 'REMOVAL']);
const PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const STATUSES = new Set(['OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const QUERY_FIELDS = new Set(['assignedStaffUserId', 'from', 'q', 'status', 'to']);

export class AdminWorkOrderError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminWorkOrderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new AdminWorkOrderError(422, 'INVALID_BODY', '工單資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((key) => !fields.has(key));
  if (unknown) fail(unknown, '不支援此欄位。');
}

function positiveId(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須是正整數。');
  return value;
}

function textValue(value, field, maxLength, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string') fail(field, '必須是文字。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) fail(field, `必須是 1 到 ${maxLength} 個字元。`);
  return cleaned;
}

function isoTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function parsePathId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return positiveId(id, 'workOrderId');
}

function createPayload(payload) {
  objectPayload(payload, CREATE_FIELDS);
  if (!WORK_TYPES.has(payload.workType)) fail('workType', '不支援此工單類型。');
  if (!PRIORITIES.has(payload.priority)) fail('priority', '不支援此優先等級。');
  return {
    subscriptionId: positiveId(payload.subscriptionId, 'subscriptionId', { nullable: true }),
    serviceLocationId: positiveId(payload.serviceLocationId, 'serviceLocationId'),
    salesOrderId: positiveId(payload.salesOrderId, 'salesOrderId', { nullable: true }),
    workType: payload.workType,
    priority: payload.priority,
    problemDescription: textValue(payload.problemDescription, 'problemDescription', 2_000, { nullable: true }),
  };
}

function actionPayload(action, payload, workType, now) {
  const fields = ACTION_FIELDS.get(action);
  if (!fields) throw new AdminWorkOrderError(404, 'NOT_FOUND', '找不到此工單操作。');
  objectPayload(payload, fields);
  const result = { expectedUpdatedAt: isoTimestamp(payload.expectedUpdatedAt, 'expectedUpdatedAt') };
  if (action === 'assign') result.assignedStaffUserId = positiveId(payload.assignedStaffUserId, 'assignedStaffUserId');
  if (action === 'schedule') {
    result.scheduledAt = isoTimestamp(payload.scheduledAt, 'scheduledAt');
    if (Date.parse(result.scheduledAt) <= now) fail('scheduledAt', '排程時間必須晚於目前時間。');
  }
  if (action === 'complete') {
    result.resolutionNotes = textValue(payload.resolutionNotes, 'resolutionNotes', 2_000);
    if (workType === 'INSTALL' && payload.installationVerified !== true) {
      fail('installationVerified', '裝機工單完工前必須確認安裝驗證。');
    }
    if (workType !== 'INSTALL' && payload.installationVerified !== undefined) {
      fail('installationVerified', '此工單類型不接受安裝驗證欄位。');
    }
  }
  if (action === 'cancel') result.reason = textValue(payload.reason, 'reason', 500);
  return result;
}

function listFilters(searchParams) {
  const unknown = [...searchParams.keys()].find((key) => !QUERY_FIELDS.has(key));
  if (unknown) throw new AdminWorkOrderError(422, 'INVALID_QUERY', '查詢條件驗證失敗。', [{ field: unknown, message: '不支援此條件。' }]);
  const status = searchParams.get('status') || null;
  if (status && !STATUSES.has(status)) {
    throw new AdminWorkOrderError(422, 'INVALID_QUERY', '查詢條件驗證失敗。', [{ field: 'status', message: '狀態無效。' }]);
  }
  const assigned = searchParams.get('assignedStaffUserId');
  const assignedStaffUserId = assigned === null || assigned === '' ? null : Number(assigned);
  if (assignedStaffUserId !== null && (!Number.isSafeInteger(assignedStaffUserId) || assignedStaffUserId < 1)) {
    throw new AdminWorkOrderError(422, 'INVALID_QUERY', '查詢條件驗證失敗。', [{ field: 'assignedStaffUserId', message: '必須是正整數。' }]);
  }
  const q = searchParams.get('q')?.trim() || null;
  if (q && q.length > 100) throw new AdminWorkOrderError(422, 'INVALID_QUERY', '查詢條件驗證失敗。');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  for (const [field, value] of [['from', from], ['to', to]]) {
    if (value && (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)) {
      throw new AdminWorkOrderError(422, 'INVALID_QUERY', '查詢條件驗證失敗。', [{ field, message: '必須是 UTC ISO 8601 時間。' }]);
    }
  }
  return { status, assignedStaffUserId, q, from: from || null, to: to || null };
}

function historyDto(row) {
  return {
    id: Number(row.id),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedBy: row.changed_by_staff_user_id === null ? null : {
      id: Number(row.changed_by_staff_user_id),
      staffNo: row.changed_by_staff_no,
      name: row.changed_by_staff_name,
    },
    changedAt: new Date(row.changed_at).toISOString(),
  };
}

function workOrderDto(detail, { includeDescriptions = true } = {}) {
  const row = detail.row ?? detail;
  const dto = {
    id: Number(row.id),
    workOrderNo: row.work_order_no,
    subscriptionId: row.subscription_id === null ? null : Number(row.subscription_id),
    salesOrderId: row.sales_order_id === null ? null : Number(row.sales_order_id),
    workType: row.work_type,
    priority: row.priority,
    status: row.status,
    customer: { id: Number(row.customer_id), no: row.customer_no, name: row.display_name },
    serviceLocation: {
      id: Number(row.service_location_id),
      no: row.location_no,
      address: `${row.city}${row.district}${row.address_line}`,
    },
    assignedStaff: row.assigned_staff_user_id === null ? null : {
      id: Number(row.assigned_staff_user_id),
      staffNo: row.assigned_staff_no,
      name: row.assigned_staff_name,
    },
    scheduledAt: row.scheduled_at === null ? null : new Date(row.scheduled_at).toISOString(),
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (includeDescriptions) {
    dto.problemDescription = row.problem_description;
    dto.resolutionNotes = row.resolution_notes;
    dto.history = detail.history.map(historyDto);
  }
  return dto;
}

function timestampAfter(clock, expected = null) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid work-order clock value');
  return new Date(expected ? Math.max(now, Date.parse(expected) + 1) : now).toISOString();
}

function mappedResult(result) {
  const errors = new Map([
    ['invalid-location', [409, 'INVALID_REFERENCE', '服務地址不存在或目前不可供裝。']],
    ['invalid-subscription', [409, 'INVALID_REFERENCE', '服務合約與服務地址不一致。']],
    ['invalid-order', [409, 'INVALID_REFERENCE', '訂單不存在、尚未核准或服務地址不一致。']],
    ['not-found', [404, 'WORK_ORDER_NOT_FOUND', '找不到工單。']],
    ['invalid-transition', [409, 'INVALID_WORK_ORDER_TRANSITION', '目前狀態不允許此操作。']],
    ['conflict', [409, 'WORK_ORDER_CONFLICT', '工單已由其他人更新，請重新載入。']],
    ['ineligible-assignee', [409, 'INELIGIBLE_ASSIGNEE', '指派對象不是有效的維運人員。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminWorkOrderError(...error);
  return result;
}

export function createAdminWorkOrderService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    entityType: 'WORK_ORDER',
    ...event,
  }, { database });
  return {
    async list(searchParams) {
      return (await listWorkOrderRows({ databasePath, filters: listFilters(searchParams) }))
        .map((row) => workOrderDto(row, { includeDescriptions: false }));
    },
    async detail(value) {
      const detail = (await findWorkOrderDetail({ databasePath, workOrderId: parsePathId(value) }));
      if (!detail) throw new AdminWorkOrderError(404, 'WORK_ORDER_NOT_FOUND', '找不到工單。');
      return workOrderDto(detail);
    },
    async create(payload, actor, requestAudit = {}) {
      const input = createPayload(payload);
      const now = timestampAfter(clock);
      const result = mappedResult((await createWorkOrder({
        databasePath, input, actorId: actor.id, now,
        async afterWrite(database, detail) {
          await audit(actor, requestAudit, {
            action: 'WORK_ORDER_CREATED', entityId: String(detail.row.id),
            after: { status: 'OPEN', priority: input.priority },
            allowedFields: ['status', 'priority'],
          }, database);
        },
      })));
      return workOrderDto(result.detail);
    },
    async transition(value, action, payload, actor, requestAudit = {}) {
      const workOrderId = parsePathId(value);
      const existing = (await findWorkOrderDetail({ databasePath, workOrderId }));
      if (!existing) throw new AdminWorkOrderError(404, 'WORK_ORDER_NOT_FOUND', '找不到工單。');
      const nowValue = Number(clock());
      if (!Number.isFinite(nowValue)) throw new TypeError('Invalid work-order clock value');
      const input = actionPayload(action, payload, existing.row.work_type, nowValue);
      const result = mappedResult((await transitionWorkOrder({
        databasePath, workOrderId, action, input, actorId: actor.id,
        updatedAt: timestampAfter(clock, input.expectedUpdatedAt),
        async afterWrite(database, before, after) {
          const actions = {
            assign: 'WORK_ORDER_ASSIGNED', schedule: 'WORK_ORDER_SCHEDULED',
            start: 'WORK_ORDER_STARTED', complete: 'WORK_ORDER_COMPLETED',
            cancel: 'WORK_ORDER_CANCELLED',
          };
          if (action === 'complete') {
            await provisionSubscriptionFromCompletedInstall({
              database, workOrderId, actorId: actor.id, now: after.updated_at,
            });
          }
          await audit(actor, requestAudit, {
            action: actions[action], entityId: String(workOrderId),
            before: {
              status: before.status,
              assignedStaffUserId: before.assigned_staff_user_id === null
                ? null : Number(before.assigned_staff_user_id),
            },
            after: {
              status: after.status,
              assignedStaffUserId: after.assigned_staff_user_id === null
                ? null : Number(after.assigned_staff_user_id),
            },
            allowedFields: ['status', 'assignedStaffUserId'],
          }, database);
        },
      })));
      return workOrderDto(result.detail);
    },
  };
}
