import { createHash } from 'node:crypto';

import { createOrderDraft, findOrderDetail, listOrderRows } from './order-repository.mjs';
import { transitionOrder } from './order-workflow.mjs';

const ORDER_FIELDS = new Set([
  'customerId', 'engineeringProjectId', 'notes', 'orderType',
  'productItems', 'serviceItems', 'serviceLocationId',
]);
const SERVICE_ITEM_FIELDS = new Set([
  'planPriceId', 'promotionId', 'quantity', 'servicePlanId',
]);
const PRODUCT_ITEM_FIELDS = new Set(['quantity', 'stockItemId']);
const ORDER_TYPES = new Set([
  'NEW_SERVICE', 'UPGRADE', 'RENEWAL', 'TERMINATION', 'PRODUCT', 'PROJECT',
]);
const IDEMPOTENCY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSITION_FIELDS = new Set(['expectedUpdatedAt', 'reason']);

export class AdminOrderError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminOrderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(field, message) {
  throw new AdminOrderError(422, 'INVALID_BODY', '訂單資料格式不正確。', [{ field, message }]);
}

function objectPayload(payload, fields, field = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(field ?? 'body', '必須是 JSON 物件。');
  }
  const unknown = Object.keys(payload).filter((key) => !fields.has(key));
  if (unknown.length) fail(field ?? unknown[0], '包含未允許的欄位。');
}

function positiveId(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail(field, '必須是正整數識別碼。');
  return value;
}

function quantity(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    fail(field, '數量必須是 1 到 1000 的整數。');
  }
  return value;
}

function text(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(field, '必須是文字或 null。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) fail(field, `最多 ${maxLength} 個字元。`);
  return cleaned;
}

function itemArray(value, field, allowedFields, mapper) {
  if (!Array.isArray(value) || value.length > 50) fail(field, '必須是最多 50 筆的陣列。');
  return value.map((item, index) => {
    objectPayload(item, allowedFields, `${field}.${index}`);
    return mapper(item, index);
  });
}

function ensureUnique(items, key, field) {
  const values = items.map((item) => item[key]);
  if (new Set(values).size !== values.length) fail(field, '同一引用不可重複。');
}

function normalizedOrder(payload) {
  objectPayload(payload, ORDER_FIELDS);
  if (!ORDER_TYPES.has(payload.orderType)) fail('orderType', '訂單類型不在允許清單。');
  const serviceItems = itemArray(
    payload.serviceItems ?? [],
    'serviceItems',
    SERVICE_ITEM_FIELDS,
    (item, index) => ({
      servicePlanId: positiveId(item.servicePlanId, `serviceItems.${index}.servicePlanId`),
      planPriceId: positiveId(item.planPriceId, `serviceItems.${index}.planPriceId`),
      promotionId: positiveId(item.promotionId, `serviceItems.${index}.promotionId`, { nullable: true }),
      quantity: quantity(item.quantity, `serviceItems.${index}.quantity`),
    }),
  );
  const productItems = itemArray(
    payload.productItems ?? [],
    'productItems',
    PRODUCT_ITEM_FIELDS,
    (item, index) => ({
      stockItemId: positiveId(item.stockItemId, `productItems.${index}.stockItemId`),
      quantity: quantity(item.quantity, `productItems.${index}.quantity`),
    }),
  );
  ensureUnique(serviceItems, 'servicePlanId', 'serviceItems');
  ensureUnique(productItems, 'stockItemId', 'productItems');
  const engineeringProjectId = positiveId(
    payload.engineeringProjectId, 'engineeringProjectId', { nullable: true },
  );
  if (!serviceItems.length && !productItems.length && engineeringProjectId === null) {
    fail('serviceItems', '訂單至少需要一個方案、商品或工程專案。');
  }
  if (payload.orderType === 'PROJECT' && engineeringProjectId === null) {
    fail('engineeringProjectId', '工程訂單必須指定工程專案。');
  }
  return {
    customerId: positiveId(payload.customerId, 'customerId'),
    serviceLocationId: positiveId(
      payload.serviceLocationId, 'serviceLocationId', { nullable: true },
    ),
    engineeringProjectId,
    orderType: payload.orderType,
    notes: text(payload.notes, 'notes', 2_000),
    serviceItems,
    productItems,
  };
}

function formatMinorUnits(value) {
  const digits = BigInt(value).toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function orderDto(detail) {
  const row = detail.row;
  return {
    id: Number(row.id),
    orderNo: row.order_no,
    orderType: row.order_type,
    status: row.status,
    customer: { id: Number(row.customer_id), no: row.customer_no, name: row.display_name },
    serviceLocation: row.service_location_id === null ? null : {
      id: Number(row.service_location_id), no: row.location_no,
      address: `${row.city}${row.district}${row.address_line}`,
    },
    engineeringProject: row.engineering_project_id === null ? null : {
      id: Number(row.engineering_project_id), no: row.project_no, name: row.project_name,
    },
    salesStaffUserId: row.sales_staff_user_id === null ? null : Number(row.sales_staff_user_id),
    orderedAt: new Date(row.ordered_at).toISOString(),
    amounts: {
      subtotal: formatMinorUnits(row.subtotal_amount),
      tax: formatMinorUnits(row.tax_amount),
      total: formatMinorUnits(row.total_amount),
    },
    notes: detail.notes,
    serviceItems: detail.serviceItems.map((item) => ({
      id: Number(item.id),
      servicePlanId: Number(item.service_plan_id),
      planCode: item.plan_code,
      planName: item.plan_name,
      planPriceId: item.plan_price_id === null ? null : Number(item.plan_price_id),
      priceType: item.price_type,
      promotionId: item.promotion_id === null ? null : Number(item.promotion_id),
      promotionCode: item.promotion_code,
      quantity: Number(item.quantity),
      unitPrice: formatMinorUnits(item.unit_price),
      contractMonths: Number(item.contract_months),
      descriptionSnapshot: item.description_snapshot,
    })),
    productItems: detail.productItems.map((item) => ({
      id: Number(item.id),
      stockItemId: Number(item.stock_item_id),
      sku: item.sku,
      itemName: item.item_name,
      quantity: Number(item.quantity),
      unitPrice: formatMinorUnits(item.unit_price),
      discountAmount: formatMinorUnits(item.discount_amount),
    })),
    workOrder: detail.workOrder ? {
      id: Number(detail.workOrder.id),
      workOrderNo: detail.workOrder.work_order_no,
      workType: detail.workOrder.work_type,
      status: detail.workOrder.status,
    } : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function transitionPayload(payload) {
  objectPayload(payload, TRANSITION_FIELDS);
  const expected = payload.expectedUpdatedAt;
  if (
    typeof expected !== 'string'
    || Number.isNaN(Date.parse(expected))
    || new Date(expected).toISOString() !== expected
  ) fail('expectedUpdatedAt', '必須是有效的 UTC ISO 8601 時間。');
  return { expectedUpdatedAt: expected, reason: text(payload.reason, 'reason', 500) };
}

function nextTimestamp(clock, expected) {
  const now = new Date(clock()).valueOf();
  if (Number.isNaN(now)) throw new TypeError('Invalid order clock value');
  return new Date(Math.max(now, Date.parse(expected) + 1)).toISOString();
}

function mapResult(result) {
  const mappings = new Map([
    ['idempotency-conflict', [409, 'IDEMPOTENCY_CONFLICT', '冪等鍵已用於不同訂單內容。']],
    ['invalid-customer', [409, 'INVALID_CUSTOMER', '客戶不存在或目前不可建立訂單。']],
    ['invalid-location', [409, 'INVALID_SERVICE_LOCATION', '服務地址不屬於客戶或目前不可使用。']],
    ['invalid-project', [409, 'INVALID_PROJECT', '工程專案不屬於客戶或目前不可使用。']],
    ['invalid-price', [409, 'INVALID_PLAN_PRICE', '方案或價格目前不可使用。']],
    ['invalid-promotion', [409, 'INVALID_PROMOTION', '促銷不適用此方案或目前不可使用。']],
    ['invalid-stock', [409, 'INVALID_STOCK_ITEM', '庫存品項目前不可銷售。']],
    ['insufficient-stock', [409, 'INSUFFICIENT_STOCK', '可用庫存不足。']],
  ]);
  const mapping = mappings.get(result.kind);
  if (mapping) throw new AdminOrderError(...mapping);
  return result;
}

export function createAdminOrderService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  return {
    async list() {
      return (await listOrderRows({ databasePath })).map((row) => ({
        id: Number(row.id),
        orderNo: row.order_no,
        orderType: row.order_type,
        status: row.status,
        customer: { no: row.customer_no, name: row.display_name },
        total: formatMinorUnits(row.total_amount),
        orderedAt: new Date(row.ordered_at).toISOString(),
      }));
    },
    async detail(orderIdValue) {
      const orderId = positiveId(
        typeof orderIdValue === 'string' && /^\d+$/.test(orderIdValue)
          ? Number(orderIdValue)
          : orderIdValue,
        'orderId',
      );
      const detail = (await findOrderDetail({ databasePath, orderId }));
      if (!detail) throw new AdminOrderError(404, 'ORDER_NOT_FOUND', '找不到訂單。');
      return orderDto(detail);
    },
    async create(payload, idempotencyKey, actor, requestAudit = {}) {
      if (!IDEMPOTENCY_PATTERN.test(idempotencyKey ?? '')) {
        throw new AdminOrderError(422, 'INVALID_IDEMPOTENCY_KEY', '必須提供有效的 Idempotency-Key。');
      }
      const normalized = normalizedOrder(payload);
      const requestSignature = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      const orderNo = `SO-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
      const now = new Date(clock()).toISOString();
      const result = mapResult((await createOrderDraft({
        databasePath,
        input: { ...normalized, requestSignature, orderNo },
        actorId: actor.id,
        now,
        async afterWrite(database, detail) {
          await auditService.record({
            actorStaffUserId: actor.id,
            requestId: requestAudit.requestId,
            ipAddress: requestAudit.ipAddress,
            userAgent: requestAudit.userAgent,
            action: 'ORDER_DRAFT_CREATED',
            entityType: 'SALES_ORDER',
            entityId: String(detail.row.id),
            after: { status: 'DRAFT' },
            allowedFields: ['status'],
          }, { database });
        },
      })));
      return { data: orderDto(result.detail), replayed: result.kind === 'replayed' };
    },
    async transition(orderIdValue, action, payload, actor, requestAudit = {}) {
      const orderId = positiveId(
        typeof orderIdValue === 'string' && /^\d+$/.test(orderIdValue)
          ? Number(orderIdValue)
          : orderIdValue,
        'orderId',
      );
      const { expectedUpdatedAt, reason } = transitionPayload(payload);
      const result = (await transitionOrder({
        databasePath,
        orderId,
        action,
        expectedUpdatedAt,
        updatedAt: nextTimestamp(clock, expectedUpdatedAt),
        actorId: actor.id,
        reason,
        async afterWrite(database, before, after) {
          const actions = {
            submit: 'ORDER_SUBMITTED', approve: 'ORDER_APPROVED', cancel: 'ORDER_CANCELLED',
          };
          await auditService.record({
            actorStaffUserId: actor.id,
            requestId: requestAudit.requestId,
            ipAddress: requestAudit.ipAddress,
            userAgent: requestAudit.userAgent,
            action: actions[action],
            entityType: 'SALES_ORDER',
            entityId: String(orderId),
            before: { status: before.status },
            after: { status: after.status },
            allowedFields: ['status'],
          }, { database });
        },
      }));
      if (result.kind === 'not-found') {
        throw new AdminOrderError(404, 'ORDER_NOT_FOUND', '找不到訂單。');
      }
      if (result.kind === 'invalid-transition') {
        throw new AdminOrderError(409, 'INVALID_ORDER_TRANSITION', '目前訂單狀態不允許此操作。');
      }
      if (result.kind === 'conflict') {
        throw new AdminOrderError(409, 'ORDER_CONFLICT', '訂單已被其他人更新。');
      }
      const detail = (await findOrderDetail({ databasePath, orderId }));
      return orderDto(detail);
    },
  };
}
