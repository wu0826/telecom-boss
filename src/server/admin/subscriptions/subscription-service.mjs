import {
  findSubscriptionDetail, listSubscriptionRows, saveServiceAccount, transitionSubscription,
} from './subscription-repository.mjs';

const STATUSES = new Set(['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'EXPIRED']);
const TRANSITION_FIELDS = new Set(['expectedUpdatedAt', 'reason']);
const ACCOUNT_FIELDS = new Set([
  'accessUsername', 'circuitNo', 'credentialSecretRef', 'expectedUpdatedAt',
  'ipAssignment', 'staticIp', 'vlanId',
]);
const IP_ASSIGNMENTS = new Set(['DYNAMIC', 'STATIC', 'PPPOE']);
const SECRET_REFERENCE = /^(?:vault|secret-manager):\/\/[A-Za-z0-9._/-]{1,200}$/;

export class AdminSubscriptionError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminSubscriptionError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new AdminSubscriptionError(422, 'INVALID_BODY', '服務合約資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((key) => !fields.has(key));
  if (unknown) fail(unknown, '不支援此欄位；不得傳送密碼或權杖。');
}

function isoTimestamp(value, field = 'expectedUpdatedAt') {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function pathId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) fail('subscriptionId', '必須是正整數。');
  return id;
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(field, '必須是文字或 null。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) fail(field, `最多 ${maxLength} 個字元。`);
  return cleaned;
}

function requiredText(value, field, maxLength) {
  const cleaned = optionalText(value, field, maxLength);
  if (!cleaned) fail(field, '此欄位為必填。');
  return cleaned;
}

function transitionPayload(action, payload) {
  objectPayload(payload, TRANSITION_FIELDS);
  const reason = optionalText(payload.reason, 'reason', 500);
  if (['suspend', 'terminate'].includes(action) && !reason) fail('reason', '此操作必須提供原因。');
  return { expectedUpdatedAt: isoTimestamp(payload.expectedUpdatedAt), reason };
}

function accountPayload(payload) {
  objectPayload(payload, ACCOUNT_FIELDS);
  if (!IP_ASSIGNMENTS.has(payload.ipAssignment)) fail('ipAssignment', 'IP 配置方式無效。');
  const circuitNo = requiredText(payload.circuitNo, 'circuitNo', 64);
  const accessUsername = optionalText(payload.accessUsername, 'accessUsername', 128);
  if (payload.ipAssignment === 'PPPOE' && !accessUsername) fail('accessUsername', 'PPPoE 必須提供使用者名稱。');
  let credentialSecretRef = Object.hasOwn(payload, 'credentialSecretRef')
    ? optionalText(payload.credentialSecretRef, 'credentialSecretRef', 255) : undefined;
  if (credentialSecretRef && !SECRET_REFERENCE.test(credentialSecretRef)) {
    fail('credentialSecretRef', '只接受 vault:// 或 secret-manager:// 外部祕密參照。');
  }
  let staticIp = optionalText(payload.staticIp, 'staticIp', 45);
  if (payload.ipAssignment === 'STATIC') {
    if (!staticIp || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(staticIp)
      || staticIp.split('.').some((part) => Number(part) > 255)) {
      fail('staticIp', '固定 IP 配置必須提供有效 IPv4 位址。');
    }
  } else {
    staticIp = null;
  }
  const vlanId = payload.vlanId === null || payload.vlanId === undefined || payload.vlanId === ''
    ? null : payload.vlanId;
  if (vlanId !== null && (!Number.isSafeInteger(vlanId) || vlanId < 1 || vlanId > 4094)) {
    fail('vlanId', 'VLAN 必須介於 1 到 4094。');
  }
  return {
    expectedUpdatedAt: isoTimestamp(payload.expectedUpdatedAt), circuitNo,
    accessUsername, credentialSecretRef, ipAssignment: payload.ipAssignment,
    staticIp, vlanId,
  };
}

function fixedMoney(value) {
  const digits = BigInt(value).toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function serviceAccountDto(row) {
  if (row.account_id === null) return null;
  return {
    id: Number(row.account_id),
    circuitNo: row.circuit_no,
    accessUsername: row.access_username,
    credentialConfigured: row.credential_secret_ref !== null,
    ipAssignment: row.ip_assignment,
    staticIp: row.static_ip,
    vlanId: row.vlan_id === null ? null : Number(row.vlan_id),
    activatedAt: row.account_activated_at === null ? null : new Date(row.account_activated_at).toISOString(),
    deactivatedAt: row.account_deactivated_at === null ? null : new Date(row.account_deactivated_at).toISOString(),
  };
}

function subscriptionDto(detail, { full = true } = {}) {
  const row = detail.row ?? detail;
  const dto = {
    id: Number(row.id), subscriptionNo: row.subscription_no, status: row.status,
    customer: { id: Number(row.customer_id), no: row.customer_no, name: row.display_name },
    serviceLocation: {
      id: Number(row.service_location_id), no: row.location_no,
      address: `${row.city}${row.district}${row.address_line}`,
    },
    servicePlan: { id: Number(row.service_plan_id), code: row.plan_code, name: row.plan_name },
    monthlyFee: fixedMoney(row.monthly_fee),
    contract: { start: row.contract_start_date, end: row.contract_end_date },
    billingDay: Number(row.billing_day), autoRenew: Boolean(row.auto_renew),
    activatedAt: row.activated_at === null ? null : new Date(row.activated_at).toISOString(),
    terminatedAt: row.terminated_at === null ? null : new Date(row.terminated_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (full) {
    dto.sourceOrder = row.sales_order_id === null ? null : {
      id: Number(row.sales_order_id), orderNo: row.order_no,
      orderServiceItemId: Number(row.order_service_item_id),
    };
    dto.terminationReason = row.termination_reason;
    dto.serviceAccount = serviceAccountDto(row);
    dto.workOrders = detail.workOrders.map((workOrder) => ({
      id: Number(workOrder.id), workOrderNo: workOrder.work_order_no,
      workType: workOrder.work_type, status: workOrder.status,
    }));
    dto.history = detail.history.map((history) => ({
      id: Number(history.id), fromStatus: history.from_status, toStatus: history.to_status,
      changedBy: history.changed_by_staff_user_id === null ? null : {
        id: Number(history.changed_by_staff_user_id), staffNo: history.staff_no,
        name: history.staff_name,
      },
      reason: history.change_reason,
      changedAt: new Date(history.changed_at).toISOString(),
    }));
  }
  return dto;
}

function filters(searchParams) {
  const allowed = new Set(['q', 'status']);
  const unknown = [...searchParams.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new AdminSubscriptionError(422, 'INVALID_QUERY', '查詢條件無效。');
  const status = searchParams.get('status') || null;
  if (status && !STATUSES.has(status)) throw new AdminSubscriptionError(422, 'INVALID_QUERY', '查詢狀態無效。');
  const q = searchParams.get('q')?.trim() || null;
  if (q && q.length > 100) throw new AdminSubscriptionError(422, 'INVALID_QUERY', '關鍵字過長。');
  return { status, q };
}

function mapped(result) {
  const errors = new Map([
    ['not-found', [404, 'SUBSCRIPTION_NOT_FOUND', '找不到服務合約。']],
    ['conflict', [409, 'SUBSCRIPTION_CONFLICT', '服務合約已由其他人更新，請重新載入。']],
    ['invalid-transition', [409, 'INVALID_SUBSCRIPTION_TRANSITION', '目前狀態不允許此操作。']],
    ['duplicate-account', [409, 'DUPLICATE_SERVICE_ACCOUNT', '線路編號或使用者名稱已被使用。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminSubscriptionError(...error);
  return result;
}

function nextTimestamp(clock, expected) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid subscription clock value');
  return new Date(Math.max(now, Date.parse(expected) + 1)).toISOString();
}

export function createAdminSubscriptionService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const recordAudit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent,
    entityType: 'SUBSCRIPTION', ...event,
  }, { database });
  return {
    async list(searchParams) {
      return (await listSubscriptionRows({ databasePath, filters: filters(searchParams) }))
        .map((row) => subscriptionDto(row, { full: false }));
    },
    async detail(value) {
      const detail = (await findSubscriptionDetail({ databasePath, subscriptionId: pathId(value) }));
      if (!detail) throw new AdminSubscriptionError(404, 'SUBSCRIPTION_NOT_FOUND', '找不到服務合約。');
      return subscriptionDto(detail);
    },
    async transition(value, action, payload, actor, requestAudit = {}) {
      const subscriptionId = pathId(value);
      const input = transitionPayload(action, payload);
      const result = mapped((await transitionSubscription({
        databasePath, subscriptionId, action, input, actorId: actor.id,
        updatedAt: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database, before, after) {
          const actions = {
            activate: 'SUBSCRIPTION_ACTIVATED', suspend: 'SUBSCRIPTION_SUSPENDED',
            resume: 'SUBSCRIPTION_RESUMED', terminate: 'SUBSCRIPTION_TERMINATED',
            expire: 'SUBSCRIPTION_EXPIRED',
          };
          await recordAudit(actor, requestAudit, {
            action: actions[action], entityId: String(subscriptionId),
            before: { status: before.status }, after: { status: after.status },
            allowedFields: ['status'],
          }, database);
        },
      })));
      return subscriptionDto(result.detail);
    },
    async saveAccount(value, payload, actor, requestAudit = {}) {
      const subscriptionId = pathId(value);
      const input = accountPayload(payload);
      const result = mapped((await saveServiceAccount({
        databasePath, subscriptionId, input, actorId: actor.id,
        updatedAt: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database) {
          await recordAudit(actor, requestAudit, {
            action: 'SERVICE_ACCOUNT_UPDATED', entityId: String(subscriptionId),
            allowedFields: [],
          }, database);
        },
      })));
      return subscriptionDto(result.detail);
    },
  };
}
