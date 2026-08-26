import {
  changeOutageSubscription, createOutage, findOutageDetail, listOutageRows, transitionOutage,
} from './outage-repository.mjs';

const CREATE_FIELDS = new Set(['detectedAt', 'serviceAreaId', 'severity', 'title']);
const MEMBERSHIP_FIELDS = new Set(['expectedUpdatedAt', 'notes', 'subscriptionId']);
const TRANSITION_FIELDS = new Set(['expectedUpdatedAt', 'resolutionNotes', 'rootCause']);
const SEVERITIES = new Set(['MINOR', 'MAJOR', 'CRITICAL']);
const STATUSES = new Set(['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED']);

export class AdminOutageError extends Error {
  constructor(status, code, message, details = []) {
    super(message); this.name = 'AdminOutageError';
    this.status = status; this.code = code; this.details = details;
  }
}

function fail(field, message) {
  throw new AdminOutageError(422, 'INVALID_BODY', '障礙事件資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((key) => !fields.has(key));
  if (unknown) fail(unknown, '不支援此欄位。');
}

function text(value, field, max, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) fail(field, '此欄位為必填。');
    return null;
  }
  if (typeof value !== 'string') fail(field, '必須是文字。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) fail(field, `最多 ${max} 個字元。`);
  return cleaned;
}

function positiveId(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須是正整數。');
  return value;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function pathId(value) {
  return positiveId(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, 'incidentId');
}

function createPayload(payload) {
  objectPayload(payload, CREATE_FIELDS);
  if (!SEVERITIES.has(payload.severity)) fail('severity', '嚴重度無效。');
  return {
    title: text(payload.title, 'title', 200, true), severity: payload.severity,
    serviceAreaId: positiveId(payload.serviceAreaId, 'serviceAreaId', true),
    detectedAt: iso(payload.detectedAt, 'detectedAt'),
  };
}

function membershipPayload(payload) {
  objectPayload(payload, MEMBERSHIP_FIELDS);
  return {
    expectedUpdatedAt: iso(payload.expectedUpdatedAt, 'expectedUpdatedAt'),
    subscriptionId: positiveId(payload.subscriptionId, 'subscriptionId'),
    notes: text(payload.notes, 'notes', 500),
  };
}

function transitionPayload(action, payload) {
  objectPayload(payload, TRANSITION_FIELDS);
  const result = { expectedUpdatedAt: iso(payload.expectedUpdatedAt, 'expectedUpdatedAt') };
  if (action === 'identify') result.rootCause = text(payload.rootCause, 'rootCause', 2_000, true);
  if (['monitor', 'resolve'].includes(action)) {
    result.resolutionNotes = text(payload.resolutionNotes, 'resolutionNotes', 2_000, true);
  }
  return result;
}

function filters(searchParams) {
  const allowed = new Set(['q', 'severity', 'status']);
  const unknown = [...searchParams.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new AdminOutageError(422, 'INVALID_QUERY', '查詢條件無效。');
  const status = searchParams.get('status') || null;
  const severity = searchParams.get('severity') || null;
  if (status && !STATUSES.has(status)) throw new AdminOutageError(422, 'INVALID_QUERY', '狀態無效。');
  if (severity && !SEVERITIES.has(severity)) throw new AdminOutageError(422, 'INVALID_QUERY', '嚴重度無效。');
  const q = searchParams.get('q')?.trim() || null;
  if (q && q.length > 100) throw new AdminOutageError(422, 'INVALID_QUERY', '關鍵字過長。');
  return { status, severity, q };
}

function announcement(row) {
  const impact = Number(row.impacted_subscriptions);
  const statusText = row.status === 'RESOLVED'
    ? '目前服務已恢復，系統持續觀察。'
    : '技術團隊正在處理，將於確認後更新進度。';
  return `${row.severity} 服務異常：${row.title}。目前影響 ${impact} 項服務。${statusText}`;
}

function dto(detail, full = true) {
  const row = detail.row ?? detail;
  const result = {
    id: Number(row.id), incidentNo: row.incident_no, title: row.title,
    severity: row.severity, status: row.status,
    serviceArea: row.service_area_id === null ? null : {
      id: Number(row.service_area_id), code: row.area_code, name: row.area_name,
    },
    detectedAt: new Date(row.detected_at).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
    impact: {
      subscriptions: Number(row.impacted_subscriptions), customers: Number(row.impacted_customers),
    },
    publicAnnouncementDraft: announcement(row),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (full) {
    result.rootCause = row.root_cause;
    result.resolutionNotes = row.resolution_notes;
    result.subscriptions = detail.subscriptions.map((item) => ({
      id: Number(item.subscription_id), subscriptionNo: item.subscription_no,
      status: item.status, plan: { code: item.plan_code, name: item.plan_name },
      customer: { no: item.customer_no, name: item.display_name },
      impactStartedAt: item.impact_started_at === null ? null : new Date(item.impact_started_at).toISOString(),
      impactEndedAt: item.impact_ended_at === null ? null : new Date(item.impact_ended_at).toISOString(),
      notes: item.notes,
    }));
  }
  return result;
}

function mapped(result) {
  const errors = new Map([
    ['invalid-area', [409, 'INVALID_SERVICE_AREA', '服務區域不存在。']],
    ['not-found', [404, 'OUTAGE_NOT_FOUND', '找不到障礙事件。']],
    ['conflict', [409, 'OUTAGE_CONFLICT', '障礙事件已由其他人更新，請重新載入。']],
    ['invalid-transition', [409, 'INVALID_OUTAGE_TRANSITION', '目前狀態不允許此操作。']],
    ['inactive-subscription', [409, 'INACTIVE_SUBSCRIPTION', '只能加入使用中的服務合約。']],
    ['duplicate-membership', [409, 'DUPLICATE_OUTAGE_SUBSCRIPTION', '此合約已在影響清單。']],
    ['membership-not-found', [404, 'OUTAGE_SUBSCRIPTION_NOT_FOUND', '找不到影響合約。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminOutageError(...error);
  return result;
}

function nextTimestamp(clock, expected = null) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid outage clock value');
  return new Date(expected ? Math.max(now, Date.parse(expected) + 1) : now).toISOString();
}

export function createAdminOutageService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent,
    entityType: 'OUTAGE_INCIDENT', ...event,
  }, { database });
  return {
    async list(searchParams) {
      return (await listOutageRows({ databasePath, filters: filters(searchParams) })).map((row) => dto(row, false));
    },
    async detail(value) {
      const detail = (await findOutageDetail({ databasePath, incidentId: pathId(value) }));
      if (!detail) throw new AdminOutageError(404, 'OUTAGE_NOT_FOUND', '找不到障礙事件。');
      return dto(detail);
    },
    async create(payload, actor, requestAudit = {}) {
      const input = createPayload(payload);
      const result = mapped((await createOutage({
        databasePath, input, actorId: actor.id, now: nextTimestamp(clock),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, {
            action: 'OUTAGE_CREATED', entityId: String(row.id),
            after: { status: row.status }, allowedFields: ['status'],
          }, database);
        },
      })));
      return dto(result.detail);
    },
    async membership(value, mode, payload, actor, requestAudit = {}) {
      const incidentId = pathId(value);
      const input = membershipPayload(payload);
      const result = mapped((await changeOutageSubscription({
        databasePath, incidentId, mode, input, actorId: actor.id,
        updatedAt: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database) {
          await audit(actor, requestAudit, {
            action: mode === 'add' ? 'OUTAGE_SUBSCRIPTION_ADDED' : 'OUTAGE_SUBSCRIPTION_REMOVED',
            entityId: String(incidentId), allowedFields: [],
          }, database);
        },
      })));
      return dto(result.detail);
    },
    async transition(value, action, payload, actor, requestAudit = {}) {
      const incidentId = pathId(value);
      const input = transitionPayload(action, payload);
      const result = mapped((await transitionOutage({
        databasePath, incidentId, action, input, actorId: actor.id,
        updatedAt: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: `OUTAGE_${after.status}`, entityId: String(incidentId),
            before: { status: before.status }, after: { status: after.status },
            allowedFields: ['status'],
          }, database);
        },
      })));
      return dto(result.detail);
    },
  };
}
