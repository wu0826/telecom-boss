import {
  createStockItem, createWarehouse, decodeMovementNotes, readInventory, recordMovement,
} from './inventory-repository.mjs';

const WAREHOUSE_FIELDS = new Set(['address', 'code', 'name']);
const ITEM_FIELDS = new Set([
  'equipmentModelId', 'itemType', 'name', 'reorderLevel', 'sellingPrice',
  'sku', 'standardCost', 'unit',
]);
const MOVEMENT_FIELDS = new Set([
  'adjustmentDirection', 'macAddress', 'movementType', 'notes', 'occurredAt',
  'ownership', 'quantity', 'referenceNo', 'serialNo', 'stockItemId',
  'subscriptionId', 'targetWarehouseId', 'warehouseId',
]);
const ITEM_TYPES = new Set(['EQUIPMENT', 'PRODUCT', 'MATERIAL']);
const MOVEMENT_TYPES = new Set(['RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INSTALL', 'RETURN']);
const DIRECTIONS = new Set(['INCREASE', 'DECREASE']);
const OWNERSHIPS = new Set(['COMPANY', 'CUSTOMER', 'RENTAL']);

export class AdminInventoryError extends Error {
  constructor(status, code, message, details = []) {
    super(message); this.name = 'AdminInventoryError';
    this.status = status; this.code = code; this.details = details;
  }
}

function fail(field, message) {
  throw new AdminInventoryError(422, 'INVALID_BODY', '庫存資料驗證失敗。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((key) => !fields.has(key));
  if (unknown) fail(unknown, '不允許此欄位。');
}

function text(value, field, max, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) fail(field, '此欄位必填。');
    return null;
  }
  if (typeof value !== 'string') fail(field, '必須是文字。');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) fail(field, `不得超過 ${max} 字。`);
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

function scaled(value, field, scale, { allowZero = true } = {}) {
  const digits = scale === 2 ? 2 : 3;
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,11})\\.\\d{${digits}}$`);
  if (typeof value !== 'string' || !pattern.test(value)) fail(field, `必須固定 ${digits} 位小數。`);
  const [whole, fraction] = value.split('.');
  const multiplier = 10 ** digits;
  const result = Number(whole) * multiplier + Number(fraction);
  if (!Number.isSafeInteger(result) || (!allowZero && result < 1)) fail(field, '數值必須大於零。');
  return result;
}

function warehousePayload(payload) {
  objectPayload(payload, WAREHOUSE_FIELDS);
  return {
    code: text(payload.code, 'code', 32, true), name: text(payload.name, 'name', 100, true),
    address: text(payload.address, 'address', 255),
  };
}

function itemPayload(payload) {
  objectPayload(payload, ITEM_FIELDS);
  if (!ITEM_TYPES.has(payload.itemType)) fail('itemType', '品項類型不受支援。');
  const equipmentModelId = positiveId(payload.equipmentModelId, 'equipmentModelId', true);
  if (payload.itemType === 'EQUIPMENT' && equipmentModelId === null) fail('equipmentModelId', '設備品項必須連結設備型號。');
  if (payload.itemType !== 'EQUIPMENT' && equipmentModelId !== null) fail('equipmentModelId', '只有設備品項可連結設備型號。');
  return {
    sku: text(payload.sku, 'sku', 64, true), name: text(payload.name, 'name', 150, true),
    itemType: payload.itemType, equipmentModelId,
    unit: text(payload.unit, 'unit', 20, true),
    standardCost: scaled(payload.standardCost, 'standardCost', 2),
    sellingPrice: scaled(payload.sellingPrice, 'sellingPrice', 2),
    reorderLevel: scaled(payload.reorderLevel, 'reorderLevel', 3),
  };
}

function movementPayload(payload) {
  objectPayload(payload, MOVEMENT_FIELDS);
  if (!MOVEMENT_TYPES.has(payload.movementType)) fail('movementType', '異動類型不受支援。');
  const result = {
    movementType: payload.movementType,
    warehouseId: positiveId(payload.warehouseId, 'warehouseId'),
    targetWarehouseId: positiveId(payload.targetWarehouseId, 'targetWarehouseId', true),
    stockItemId: positiveId(payload.stockItemId, 'stockItemId'),
    quantity: scaled(payload.quantity, 'quantity', 3, { allowZero: false }),
    referenceNo: text(payload.referenceNo, 'referenceNo', 64, true),
    occurredAt: iso(payload.occurredAt, 'occurredAt'), notes: text(payload.notes, 'notes', 500),
    adjustmentDirection: payload.adjustmentDirection ?? null,
    subscriptionId: positiveId(payload.subscriptionId, 'subscriptionId', true),
    serialNo: text(payload.serialNo, 'serialNo', 100),
    macAddress: text(payload.macAddress, 'macAddress', 32),
    ownership: payload.ownership ?? null,
  };
  if (result.movementType === 'TRANSFER') {
    if (result.targetWarehouseId === null || result.targetWarehouseId === result.warehouseId) {
      fail('targetWarehouseId', '轉倉目的倉必須存在且不同於來源倉。');
    }
  } else if (result.targetWarehouseId !== null) fail('targetWarehouseId', '只有轉倉可指定目的倉。');
  if (result.movementType === 'ADJUSTMENT') {
    if (!DIRECTIONS.has(result.adjustmentDirection)) fail('adjustmentDirection', '調整必須指定增加或減少。');
  } else if (result.adjustmentDirection !== null) fail('adjustmentDirection', '只有盤點調整可指定方向。');
  if (['INSTALL', 'RETURN'].includes(result.movementType)) {
    if (result.subscriptionId === null) fail('subscriptionId', '安裝或拆回必須指定服務合約。');
    if (!result.serialNo) fail('serialNo', '安裝或拆回必須指定序號。');
    if (result.quantity !== 1_000) fail('quantity', '設備安裝或拆回數量必須為 1.000。');
  } else if (result.subscriptionId !== null || result.serialNo || result.macAddress || result.ownership) {
    fail('subscriptionId', '只有設備安裝或拆回可帶設備欄位。');
  }
  if (result.movementType === 'INSTALL') {
    if (!OWNERSHIPS.has(result.ownership)) fail('ownership', '設備權屬不受支援。');
  } else if (result.ownership !== null || result.macAddress !== null) fail('ownership', '拆回不接受權屬或 MAC。');
  return result;
}

function money(value) { return (Number(value) / 100).toFixed(2); }
function quantity(value) { return (Number(value) / 1_000).toFixed(3); }

function warehouseDto(row) {
  return { id: Number(row.id), code: row.warehouse_code, name: row.warehouse_name, address: row.address, active: Boolean(row.is_active) };
}

function itemDto(row) {
  return {
    id: Number(row.id), sku: row.sku, name: row.item_name, itemType: row.item_type,
    equipmentModel: row.equipment_model_id === null ? null : {
      id: Number(row.equipment_model_id), code: row.model_code, brand: row.brand, name: row.model_name,
    },
    unit: row.unit, standardCost: money(row.standard_cost), sellingPrice: money(row.selling_price),
    reorderLevel: quantity(row.reorder_level), active: Boolean(row.is_active),
  };
}

function balanceDto(row) {
  const onHand = Number(row.quantity_on_hand);
  const reserved = Number(row.quantity_reserved);
  const available = onHand - reserved;
  const reorderLevel = Number(row.reorder_level ?? 0);
  return {
    id: Number(row.id),
    warehouse: { id: Number(row.warehouse_id), code: row.warehouse_code, name: row.warehouse_name },
    item: { id: Number(row.stock_item_id), sku: row.sku, name: row.item_name },
    onHand: quantity(onHand), reserved: quantity(reserved), available: quantity(available),
    warning: available < 0 ? 'NEGATIVE_STOCK' : available <= reorderLevel ? 'LOW_STOCK' : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function movementDto(row) {
  const decoded = decodeMovementNotes(row.notes);
  return {
    id: Number(row.id), movementNo: row.movement_no, movementType: row.movement_type,
    warehouse: { id: Number(row.warehouse_id), code: row.warehouse_code, name: row.warehouse_name },
    targetWarehouse: row.target_warehouse_id === null ? null : {
      id: Number(row.target_warehouse_id), code: row.target_code, name: row.target_name,
    },
    item: { id: Number(row.stock_item_id), sku: row.sku, name: row.item_name },
    quantity: quantity(row.quantity), adjustmentDirection: decoded.adjustmentDirection,
    referenceNo: row.reference_no, occurredAt: new Date(row.occurred_at).toISOString(),
    performedBy: { id: Number(row.performed_by_staff_user_id), no: row.staff_no, name: row.staff_name },
    notes: decoded.notes,
  };
}

function mapped(result) {
  const errors = new Map([
    ['duplicate-master', [409, 'DUPLICATE_INVENTORY_MASTER', '倉庫代碼或品項 SKU 已存在。']],
    ['equipment-model-not-found', [409, 'EQUIPMENT_MODEL_NOT_FOUND', '設備型號不存在或已停用。']],
    ['invalid-source', [409, 'INVALID_INVENTORY_SOURCE', '來源倉庫、品項或庫存餘額無效。']],
    ['invalid-target', [409, 'INVALID_INVENTORY_TARGET', '目的倉庫或庫存餘額無效。']],
    ['insufficient-stock', [409, 'INSUFFICIENT_STOCK', '可用庫存不足，異動未執行。']],
    ['invalid-equipment', [409, 'INVALID_EQUIPMENT_MOVEMENT', '設備異動必須使用設備品項且數量為 1.000。']],
    ['invalid-subscription', [409, 'INVALID_SUBSCRIPTION', '服務合約不存在或未啟用。']],
    ['equipment-not-found', [404, 'CUSTOMER_EQUIPMENT_NOT_FOUND', '找不到可拆回的客戶設備。']],
    ['duplicate-movement', [409, 'DUPLICATE_STOCK_MOVEMENT', '此異動類型與參照編號已處理。']],
  ]);
  const error = errors.get(result.kind);
  if (error) throw new AdminInventoryError(...error);
  return result;
}

export function createAdminInventoryService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const now = () => {
    const value = Number(clock());
    if (!Number.isFinite(value)) throw new TypeError('Invalid inventory clock value');
    return new Date(value).toISOString();
  };
  const audit = (actor, requestAudit, event, database) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent,
    entityType: event.entityType, action: event.action, entityId: event.entityId,
    after: event.after, allowedFields: event.allowedFields,
  }, { database });
  return {
    async view() {
      const result = (await readInventory({ databasePath }));
      return {
        items: result.items.map(itemDto), warehouses: result.warehouses.map(warehouseDto),
        balances: result.balances.map(balanceDto), movements: result.movements.map(movementDto),
      };
    },
    async createWarehouse(payload, actor, requestAudit = {}) {
      const result = mapped((await createWarehouse({
        databasePath, input: warehousePayload(payload), now: now(),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, { entityType: 'WAREHOUSE', action: 'WAREHOUSE_CREATED', entityId: String(row.id), after: { active: true }, allowedFields: ['active'] }, database);
        },
      })));
      return warehouseDto(result.row);
    },
    async createItem(payload, actor, requestAudit = {}) {
      const result = mapped((await createStockItem({
        databasePath, input: itemPayload(payload), now: now(),
        async afterWrite(database, row) {
          await audit(actor, requestAudit, { entityType: 'STOCK_ITEM', action: 'STOCK_ITEM_CREATED', entityId: String(row.id), after: { active: true }, allowedFields: ['active'] }, database);
        },
      })));
      return itemDto(result.row);
    },
    async move(payload, actor, requestAudit = {}) {
      const input = movementPayload(payload);
      const result = mapped((await recordMovement({
        databasePath, input, actorId: actor.id, now: now(),
        async afterWrite(database, movement) {
          await audit(actor, requestAudit, { entityType: 'STOCK_MOVEMENT', action: 'STOCK_MOVEMENT_RECORDED', entityId: String(movement.id), after: { movementType: movement.movement_type }, allowedFields: ['movementType'] }, database);
        },
      })));
      const view = (await readInventory({ databasePath }));
      const movement = view.movements.find(({ id }) => Number(id) === Number(result.movement.id));
      const balance = view.balances.find(({ id }) => Number(id) === Number(result.balance.id));
      const targetBalance = result.targetBalance === null ? null
        : view.balances.find(({ id }) => Number(id) === Number(result.targetBalance.id));
      return {
        movement: movementDto(movement), balance: balanceDto(balance),
        targetBalance: targetBalance ? balanceDto(targetBalance) : null,
        equipment: result.equipment === null ? null : {
          id: Number(result.equipment.id), serialNo: result.equipment.serial_no,
          condition: result.equipment.condition_status,
          installedAt: result.equipment.installed_at === null ? null : new Date(result.equipment.installed_at).toISOString(),
          removedAt: result.equipment.removed_at === null ? null : new Date(result.equipment.removed_at).toISOString(),
        },
      };
    },
  };
}
