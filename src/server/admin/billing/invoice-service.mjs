import {
  findInvoiceDetail, generateInvoice, listBillableSubscriptionIds,
  listInvoiceRows, transitionInvoice,
} from './invoice-repository.mjs';

const GENERATE_FIELDS = new Set(['billingPeriodEnd', 'billingPeriodStart', 'dueDate', 'subscriptionId']);
const BATCH_FIELDS = new Set(['billingPeriodEnd', 'billingPeriodStart', 'dueDate']);
const TRANSITION_FIELDS = new Set(['expectedUpdatedAt', 'reason']);
const STATUSES = new Set(['DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID']);

export class AdminInvoiceError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminInvoiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new AdminInvoiceError(422, 'INVALID_BODY', '帳單資料驗證失敗。', [{ field, message }]);
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

function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(field, '必須是 YYYY-MM-DD。');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(field, '日期無效。');
  return value;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function pathId(value) {
  return positiveId(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, 'invoiceId');
}

function generationPayload(payload, batch = false) {
  objectPayload(payload, batch ? BATCH_FIELDS : GENERATE_FIELDS);
  const result = {
    billingPeriodStart: date(payload.billingPeriodStart, 'billingPeriodStart'),
    billingPeriodEnd: date(payload.billingPeriodEnd, 'billingPeriodEnd'),
    dueDate: date(payload.dueDate, 'dueDate'),
  };
  if (!batch) result.subscriptionId = positiveId(payload.subscriptionId, 'subscriptionId');
  if (result.billingPeriodEnd < result.billingPeriodStart) fail('billingPeriodEnd', '不得早於帳期起日。');
  if (result.dueDate < result.billingPeriodEnd) fail('dueDate', '不得早於帳期迄日。');
  return result;
}

function transitionPayload(action, payload) {
  objectPayload(payload, TRANSITION_FIELDS);
  const result = { expectedUpdatedAt: iso(payload.expectedUpdatedAt, 'expectedUpdatedAt') };
  if (action === 'void') {
    if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.trim().length > 500) {
      fail('reason', '作廢原因必填且不得超過 500 字。');
    }
    result.reason = payload.reason.trim();
  } else if (payload.reason !== undefined) {
    fail('reason', '此動作不接受原因。');
  }
  return result;
}

function filters(searchParams) {
  const allowed = new Set(['q', 'status']);
  const unknown = [...searchParams.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new AdminInvoiceError(422, 'INVALID_QUERY', '查詢參數不受支援。');
  const status = searchParams.get('status') || null;
  if (status && !STATUSES.has(status)) throw new AdminInvoiceError(422, 'INVALID_QUERY', '帳單狀態不受支援。');
  const q = searchParams.get('q')?.trim() || null;
  if (q && q.length > 100) throw new AdminInvoiceError(422, 'INVALID_QUERY', '搜尋文字過長。');
  return { q, status };
}

function money(value) {
  return (Number(value) / 100).toFixed(2);
}

function dto(detail, full = true) {
  const row = detail.row ?? detail;
  const result = {
    id: Number(row.id), invoiceNo: row.invoice_no, status: row.status,
    customer: { id: Number(row.customer_id), no: row.customer_no, name: row.display_name },
    subscription: row.subscription_id === null ? null : {
      id: Number(row.subscription_id), no: row.subscription_no,
      plan: { code: row.plan_code, name: row.plan_name },
    },
    billingPeriod: { start: row.billing_period_start, end: row.billing_period_end },
    generatedAt: new Date(row.created_at).toISOString(),
    issuedAt: new Date(row.issued_at).toISOString(),
    dueDate: row.due_date,
    subtotalAmount: money(row.subtotal_amount), taxAmount: money(row.tax_amount),
    totalAmount: money(row.total_amount), balanceDue: money(row.balance_due),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (full) result.items = detail.items.map((item) => ({
    id: Number(item.id), itemType: item.item_type, description: item.description,
    period: { start: item.period_start, end: item.period_end },
    quantity: (Number(item.quantity) / 1_000).toFixed(3), unitPrice: money(item.unit_price),
    lineAmount: money(item.line_amount), taxAmount: money(item.tax_amount),
  }));
  return result;
}

function mapped(result) {
  const errors = new Map([
    ['subscription-not-found', [404, 'SUBSCRIPTION_NOT_FOUND', '找不到服務合約。']],
    ['subscription-not-billable', [409, 'SUBSCRIPTION_NOT_BILLABLE', '服務合約目前不可出帳。']],
    ['duplicate-period', [409, 'DUPLICATE_BILLING_PERIOD', '此服務合約的帳期已出帳。']],
    ['not-found', [404, 'INVOICE_NOT_FOUND', '找不到帳單。']],
    ['conflict', [409, 'INVOICE_CONFLICT', '帳單已由其他操作更新，請重新載入。']],
    ['invalid-transition', [409, 'INVALID_INVOICE_TRANSITION', '目前帳單狀態不允許此動作。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminInvoiceError(...error);
  return result;
}

function nextTimestamp(clock, expected = null) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid invoice clock value');
  return new Date(expected ? Math.max(now, Date.parse(expected) + 1) : now).toISOString();
}

function batchRequestId(requestId, subscriptionId) {
  const suffix = subscriptionId.toString(16).padStart(12, '0').slice(-12);
  return `${requestId.slice(0, 24)}${suffix}`;
}

export function createAdminInvoiceService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id,
    requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress,
    userAgent: requestAudit.userAgent,
    entityType: 'INVOICE',
    ...event,
  }, { database });

  async function createOne(input, actor, requestAudit) {
    const result = mapped((await generateInvoice({
      databasePath, input, now: nextTimestamp(clock),
      async afterWrite(database, row) {
        await audit(actor, requestAudit, {
          action: 'INVOICE_GENERATED', entityId: String(row.id),
          after: { status: row.status, totalAmount: money(row.total_amount) },
          allowedFields: ['status', 'totalAmount'],
        }, database);
      },
    })));
    return dto(result.detail);
  }

  return {
    async list(searchParams) {
      return (await listInvoiceRows({ databasePath, filters: filters(searchParams) })).map((row) => dto(row, false));
    },
    async detail(value) {
      const detail = (await findInvoiceDetail({ databasePath, invoiceId: pathId(value) }));
      if (!detail) throw new AdminInvoiceError(404, 'INVOICE_NOT_FOUND', '找不到帳單。');
      return dto(detail);
    },
    async generate(payload, actor, requestAudit = {}) {
      return await createOne(generationPayload(payload), actor, requestAudit);
    },
    async batch(payload, actor, requestAudit = {}) {
      const input = generationPayload(payload, true);
      const subscriptionIds = (await listBillableSubscriptionIds({ databasePath }));
      const results = [];
      for (const subscriptionId of subscriptionIds) {
        try {
          const invoice = await createOne({ ...input, subscriptionId }, actor, {
            ...requestAudit, requestId: batchRequestId(requestAudit.requestId, subscriptionId),
          });
          results.push({ subscriptionId, outcome: 'CREATED', invoice });
        } catch (error) {
          if (!(error instanceof AdminInvoiceError)) throw error;
          results.push({ subscriptionId, outcome: 'FAILED', error: { code: error.code, message: error.message } });
        }
      }
      return {
        summary: {
          created: results.filter(({ outcome }) => outcome === 'CREATED').length,
          failed: results.filter(({ outcome }) => outcome === 'FAILED').length,
        },
        results,
      };
    },
    async transition(value, action, payload, actor, requestAudit = {}) {
      const invoiceId = pathId(value);
      const input = transitionPayload(action, payload);
      const now = nextTimestamp(clock, input.expectedUpdatedAt);
      const result = mapped((await transitionInvoice({
        databasePath, invoiceId, action, input, now, today: now.slice(0, 10),
        async afterWrite(database, before, after) {
          await audit(actor, requestAudit, {
            action: `INVOICE_${after.status}`, entityId: String(invoiceId),
            before: { status: before.status }, after: { status: after.status },
            allowedFields: ['status'],
          }, database);
        },
      })));
      return dto(result.detail);
    },
  };
}
