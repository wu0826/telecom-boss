import {
  createAdjustmentRequest, decideAdjustment, findBillingActivity,
  listAdjustmentRequestRows, postPayment,
} from './payment-repository.mjs';

const PAYMENT_FIELDS = new Set([
  'amount', 'expectedUpdatedAt', 'idempotencyKey', 'invoiceId', 'notes',
  'paidAt', 'paymentMethod', 'transactionReference',
]);
const ADJUSTMENT_FIELDS = new Set(['adjustmentType', 'amount', 'invoiceId', 'reason']);
const DECISION_FIELDS = new Set(['expectedUpdatedAt']);
const METHODS = new Set(['CASH', 'TRANSFER', 'CARD', 'CONVENIENCE_STORE', 'AUTOPAY', 'OTHER']);
const ADJUSTMENT_TYPES = new Set(['CREDIT', 'DEBIT', 'WRITE_OFF']);
const REQUEST_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED']);
const LONG_DIGIT_SEQUENCE = /\d{12,19}/;

export class AdminPaymentError extends Error {
  constructor(status, code, message, details = []) {
    super(message); this.name = 'AdminPaymentError';
    this.status = status; this.code = code; this.details = details;
  }
}

function fail(field, message) {
  throw new AdminPaymentError(422, 'INVALID_BODY', '付款或調整資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((key) => !fields.has(key));
  if (unknown) fail(unknown, '不允許此欄位。');
}

function positiveId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須是正整數。');
  return value;
}

function pathId(value, field) {
  return positiveId(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, field);
}

function text(value, field, max, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) fail(field, '此欄位必填。');
    return null;
  }
  if (typeof value !== 'string') fail(field, '必須是文字。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) fail(field, `不得超過 ${max} 字。`);
  if (LONG_DIGIT_SEQUENCE.test(cleaned)) fail(field, '不得包含完整卡號或銀行帳號。');
  return cleaned;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function money(value, field = 'amount') {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    fail(field, '必須是正數且固定兩位小數。');
  }
  const [whole, fraction] = value.split('.');
  const scaled = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(scaled) || scaled < 1) fail(field, '金額必須大於零。');
  return scaled;
}

function paymentPayload(payload) {
  objectPayload(payload, PAYMENT_FIELDS);
  if (!METHODS.has(payload.paymentMethod)) fail('paymentMethod', '付款方式不受支援。');
  return {
    invoiceId: positiveId(payload.invoiceId, 'invoiceId'),
    expectedUpdatedAt: iso(payload.expectedUpdatedAt, 'expectedUpdatedAt'),
    idempotencyKey: text(payload.idempotencyKey, 'idempotencyKey', 100, true),
    paidAt: iso(payload.paidAt, 'paidAt'), amount: money(payload.amount),
    paymentMethod: payload.paymentMethod,
    transactionReference: text(payload.transactionReference, 'transactionReference', 100),
    notes: text(payload.notes, 'notes', 500),
  };
}

function adjustmentPayload(payload) {
  objectPayload(payload, ADJUSTMENT_FIELDS);
  if (!ADJUSTMENT_TYPES.has(payload.adjustmentType)) fail('adjustmentType', '調整類型不受支援。');
  return {
    invoiceId: positiveId(payload.invoiceId, 'invoiceId'),
    adjustmentType: payload.adjustmentType, amount: money(payload.amount),
    reason: text(payload.reason, 'reason', 1_000, true),
  };
}

function decisionPayload(payload) {
  objectPayload(payload, DECISION_FIELDS);
  return { expectedUpdatedAt: iso(payload.expectedUpdatedAt, 'expectedUpdatedAt') };
}

function scaled(value) { return (Number(value) / 100).toFixed(2); }

function invoiceDto(row) {
  return {
    id: Number(row.id), invoiceNo: row.invoice_no, status: row.status,
    totalAmount: scaled(row.total_amount), balanceDue: scaled(row.balance_due),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function paymentDto(row) {
  return {
    id: Number(row.id), paymentNo: row.payment_no, paidAt: new Date(row.paid_at).toISOString(),
    amount: scaled(row.amount), paymentMethod: row.payment_method,
    transactionReference: row.transaction_reference, status: row.status,
    receivedBy: row.received_by_staff_user_id === null ? null : {
      id: Number(row.received_by_staff_user_id), no: row.staff_no, name: row.staff_name,
    }, notes: row.notes,
  };
}

function requestDto(row) {
  return {
    id: Number(row.id), requestNo: row.request_no, invoiceId: Number(row.invoice_id),
    invoiceNo: row.invoice_no, adjustmentType: row.adjustment_type,
    amount: scaled(row.amount), reason: row.reason, status: row.status,
    requestedBy: {
      id: Number(row.requested_by_staff_user_id), no: row.applicant_no, name: row.applicant_name,
    },
    approvedBy: row.approved_by_staff_user_id === null ? null : {
      id: Number(row.approved_by_staff_user_id), no: row.approver_no, name: row.approver_name,
    },
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function activityDto(detail) {
  return {
    invoice: invoiceDto(detail.invoice),
    payments: detail.payments.map(paymentDto),
    adjustmentRequests: detail.requests.map(requestDto),
    adjustments: detail.adjustments.map((row) => ({
      id: Number(row.id), adjustmentNo: row.adjustment_no,
      adjustmentType: row.adjustment_type, amount: scaled(row.amount), reason: row.reason,
      approvedBy: { id: Number(row.approved_by_staff_user_id), no: row.approver_no, name: row.approver_name },
      approvedAt: new Date(row.approved_at).toISOString(),
    })),
  };
}

function mapped(result) {
  const errors = new Map([
    ['invoice-not-found', [404, 'INVOICE_NOT_FOUND', '找不到帳單。']],
    ['invoice-not-payable', [409, 'INVOICE_NOT_PAYABLE', '帳單目前不可入帳。']],
    ['invoice-not-adjustable', [409, 'INVOICE_NOT_ADJUSTABLE', '帳單目前不可調整。']],
    ['overpayment', [409, 'OVERPAYMENT', '付款金額不得超過未繳餘額。']],
    ['duplicate-payment', [409, 'DUPLICATE_PAYMENT', '付款識別碼或交易參照已使用。']],
    ['request-not-found', [404, 'ADJUSTMENT_REQUEST_NOT_FOUND', '找不到調整申請。']],
    ['conflict', [409, 'BILLING_CONFLICT', '資料已由其他操作更新，請重新載入。']],
    ['already-decided', [409, 'ADJUSTMENT_ALREADY_DECIDED', '調整申請已完成決定。']],
    ['self-approval', [409, 'SELF_APPROVAL_FORBIDDEN', '申請人不得核准自己的調整。']],
    ['adjustment-exceeds-balance', [409, 'ADJUSTMENT_EXCEEDS_BALANCE', '貸項或沖銷不得超過未繳餘額。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminPaymentError(...error);
  return result;
}

function nextTimestamp(clock, expected = null) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid payment clock value');
  return new Date(expected ? Math.max(now, Date.parse(expected) + 1) : now).toISOString();
}

export function createAdminPaymentService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent,
    entityType: event.entityType, action: event.action, entityId: event.entityId,
    before: event.before, after: event.after, allowedFields: event.allowedFields,
  }, { database });
  return {
    async activity(value) {
      const detail = (await findBillingActivity({ databasePath, invoiceId: pathId(value, 'invoiceId') }));
      if (!detail) throw new AdminPaymentError(404, 'INVOICE_NOT_FOUND', '找不到帳單。');
      return activityDto(detail);
    },
    async listRequests(searchParams) {
      const unknown = [...searchParams.keys()].find((key) => key !== 'status');
      if (unknown) throw new AdminPaymentError(422, 'INVALID_QUERY', '查詢參數不受支援。');
      const status = searchParams.get('status') || null;
      if (status && !REQUEST_STATUSES.has(status)) throw new AdminPaymentError(422, 'INVALID_QUERY', '狀態不受支援。');
      return (await listAdjustmentRequestRows({ databasePath, status })).map(requestDto);
    },
    async postPayment(payload, actor, requestAudit = {}) {
      const input = paymentPayload(payload);
      const result = mapped((await postPayment({
        databasePath, input, actorId: actor.id,
        now: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database, payment, before, after) {
          await audit(actor, requestAudit, {
            entityType: 'PAYMENT', action: 'PAYMENT_CONFIRMED', entityId: String(payment.id),
            before: { status: before.status, balanceDue: scaled(before.balance_due) },
            after: { status: after.status, balanceDue: scaled(after.balance_due) },
            allowedFields: ['status', 'balanceDue'],
          }, database);
        },
      })));
      return { payment: paymentDto(result.payment), invoice: invoiceDto(result.invoice) };
    },
    async requestAdjustment(payload, actor, requestAudit = {}) {
      const input = adjustmentPayload(payload);
      const result = mapped((await createAdjustmentRequest({
        databasePath, input, actorId: actor.id, now: nextTimestamp(clock),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, {
            entityType: 'BILLING_ADJUSTMENT_REQUEST', action: 'BILLING_ADJUSTMENT_REQUESTED',
            entityId: String(row.id), after: { status: row.status }, allowedFields: ['status'],
          }, database);
        },
      })));
      const detail = (await findBillingActivity({ databasePath, invoiceId: input.invoiceId }));
      return requestDto(detail.requests.find(({ id }) => Number(id) === Number(result.row.id)));
    },
    async decide(value, action, payload, actor, requestAudit = {}) {
      const requestId = pathId(value, 'adjustmentRequestId');
      const input = decisionPayload(payload);
      const result = mapped((await decideAdjustment({
        databasePath, requestId, action, input, actorId: actor.id,
        now: nextTimestamp(clock, input.expectedUpdatedAt),
        async afterWrite(database, before, after, invoiceBefore, invoiceAfter) {
          await audit(actor, requestAudit, {
            entityType: 'BILLING_ADJUSTMENT_REQUEST',
            action: `BILLING_ADJUSTMENT_${after.status}`, entityId: String(requestId),
            before: { status: before.status, invoiceStatus: invoiceBefore.status },
            after: { status: after.status, invoiceStatus: invoiceAfter.status },
            allowedFields: ['status', 'invoiceStatus'],
          }, database);
        },
      })));
      const detail = (await findBillingActivity({ databasePath, invoiceId: Number(result.request.invoice_id) }));
      return {
        request: requestDto(detail.requests.find(({ id }) => Number(id) === requestId)),
        invoice: invoiceDto(result.invoice),
      };
    },
  };
}
