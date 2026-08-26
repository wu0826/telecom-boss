import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const DIRECTION_PREFIX = '__adjustment_direction__:';

function mysqlDateTime(value) {
  if (value === null || value === undefined) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid MySQL datetime value: ${value}`);
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function writeInventoryDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

function encodeNotes(direction, notes) {
  return direction ? `${DIRECTION_PREFIX}${direction}\n${notes ?? ''}` : notes;
}

export function decodeMovementNotes(value) {
  if (!value?.startsWith(DIRECTION_PREFIX)) return { adjustmentDirection: null, notes: value };
  const separator = value.indexOf('\n');
  return {
    adjustmentDirection: value.slice(DIRECTION_PREFIX.length, separator < 0 ? undefined : separator),
    notes: separator < 0 ? null : value.slice(separator + 1) || null,
  };
}

async function selectInventory(database) {
  const items = await database.prepare(`
    SELECT stock_items.*, equipment_models.model_code, equipment_models.brand,
      equipment_models.model_name
    FROM stock_items
    LEFT JOIN equipment_models ON equipment_models.id = stock_items.equipment_model_id
    ORDER BY stock_items.item_name, stock_items.id
  `).all();
  const warehouses = await database.prepare(`SELECT * FROM warehouses ORDER BY warehouse_name, id`).all();
  const balances = await database.prepare(`
    SELECT balances.*, warehouses.warehouse_code, warehouses.warehouse_name,
      items.sku, items.item_name, items.reorder_level
    FROM warehouse_stock AS balances
    JOIN warehouses ON warehouses.id = balances.warehouse_id
    JOIN stock_items AS items ON items.id = balances.stock_item_id
    ORDER BY warehouses.warehouse_name, items.item_name
  `).all();
  const movements = await database.prepare(`
    SELECT movements.*, warehouses.warehouse_code, warehouses.warehouse_name,
      targets.warehouse_code AS target_code, targets.warehouse_name AS target_name,
      items.sku, items.item_name, staff.staff_no, staff.display_name AS staff_name
    FROM stock_movements AS movements
    JOIN warehouses ON warehouses.id = movements.warehouse_id
    LEFT JOIN warehouses AS targets ON targets.id = movements.target_warehouse_id
    JOIN stock_items AS items ON items.id = movements.stock_item_id
    JOIN staff_users AS staff ON staff.id = movements.performed_by_staff_user_id
    ORDER BY movements.occurred_at DESC, movements.id DESC LIMIT 100
  `).all();
  return { items, warehouses, balances, movements };
}

export async function readInventory({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try { return await selectInventory(database); } finally { database.close(); }
}

export async function createWarehouse({ databasePath, input, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeInventoryDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM warehouses').get()).id);
      await database.prepare(`INSERT INTO warehouses (
        id, warehouse_code, warehouse_name, address, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(id, input.code, input.name, input.address, databaseNow, databaseNow);
      const items = await database.prepare('SELECT id FROM stock_items WHERE is_active = 1 ORDER BY id').all();
      for (const item of items) {
        const balanceId = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM warehouse_stock').get()).id);
        await database.prepare(`INSERT INTO warehouse_stock (
          id, balance_key, warehouse_id, stock_item_id, quantity_on_hand, quantity_reserved, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?)`).run(balanceId, `${id}:${item.id}`, id, item.id, databaseNow);
      }
      const row = await database.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-master' };
    throw error;
  } finally { database.close(); }
}

export async function createStockItem({ databasePath, input, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeInventoryDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      if (input.equipmentModelId !== null) {
        const model = await database.prepare('SELECT id FROM equipment_models WHERE id = ? AND is_active = 1').get(input.equipmentModelId);
        if (!model) return { kind: 'equipment-model-not-found' };
      }
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM stock_items').get()).id);
      await database.prepare(`INSERT INTO stock_items (
        id, sku, item_name, item_type, equipment_model_id, unit, standard_cost,
        selling_price, reorder_level, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        id, input.sku, input.name, input.itemType, input.equipmentModelId, input.unit,
        input.standardCost, input.sellingPrice, input.reorderLevel, databaseNow, databaseNow,
      );
      const warehouses = await database.prepare('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id').all();
      for (const warehouse of warehouses) {
        const balanceId = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM warehouse_stock').get()).id);
        await database.prepare(`INSERT INTO warehouse_stock (
          id, balance_key, warehouse_id, stock_item_id, quantity_on_hand, quantity_reserved, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?)`).run(balanceId, `${warehouse.id}:${id}`, warehouse.id, id, databaseNow);
      }
      const row = await database.prepare('SELECT * FROM stock_items WHERE id = ?').get(id);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-master' };
    throw error;
  } finally { database.close(); }
}

async function resolveBalance(database, warehouseId, stockItemId) {
  return await database.prepare(`
    SELECT balances.*, warehouses.is_active AS warehouse_active,
      items.is_active AS item_active, items.item_type, items.equipment_model_id
    FROM warehouse_stock AS balances
    JOIN warehouses ON warehouses.id = balances.warehouse_id
    JOIN stock_items AS items ON items.id = balances.stock_item_id
    WHERE balances.warehouse_id = ? AND balances.stock_item_id = ?
  `).get(warehouseId, stockItemId) ?? null;
}

async function updateBalance(database, balance, delta, now) {
  const next = Number(balance.quantity_on_hand) + delta;
  const available = next - Number(balance.quantity_reserved);
  if (next < 0 || available < 0) return null;
  await database.prepare('UPDATE warehouse_stock SET quantity_on_hand = ?, updated_at = ? WHERE id = ?')
    .run(next, now, balance.id);
  return await database.prepare('SELECT * FROM warehouse_stock WHERE id = ?').get(balance.id);
}

export async function recordMovement({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeInventoryDateTime(database, now);
  const databaseOccurredAt = writeInventoryDateTime(database, input.occurredAt);
  try {
    return await runAtomicResult(database, async () => {
      const source = await resolveBalance(database, input.warehouseId, input.stockItemId);
      if (!source || !source.warehouse_active || !source.item_active) return { kind: 'invalid-source' };
      let target = null;
      if (input.movementType === 'TRANSFER') {
        target = await resolveBalance(database, input.targetWarehouseId, input.stockItemId);
        if (!target || !target.warehouse_active || !target.item_active) return { kind: 'invalid-target' };
      }
      let equipment = null;
      if (['INSTALL', 'RETURN'].includes(input.movementType)) {
        if (source.item_type !== 'EQUIPMENT' || source.equipment_model_id === null || input.quantity !== 1_000) {
          return { kind: 'invalid-equipment' };
        }
        const subscription = await database.prepare(`SELECT id FROM subscriptions WHERE id = ? AND status = 'ACTIVE'`)
          .get(input.subscriptionId);
        if (!subscription) return { kind: 'invalid-subscription' };
        if (input.movementType === 'RETURN') {
          equipment = await database.prepare(`
            SELECT * FROM customer_equipment
            WHERE subscription_id = ? AND equipment_model_id = ? AND serial_no = ?
              AND removed_at IS NULL AND condition_status = 'IN_USE'
          `).get(input.subscriptionId, source.equipment_model_id, input.serialNo);
          if (!equipment) return { kind: 'equipment-not-found' };
        }
      }
      const outgoing = ['ISSUE', 'TRANSFER', 'INSTALL'].includes(input.movementType)
        || (input.movementType === 'ADJUSTMENT' && input.adjustmentDirection === 'DECREASE');
      const sourceAfter = await updateBalance(database, source, outgoing ? -input.quantity : input.quantity, databaseNow);
      if (!sourceAfter) return { kind: 'insufficient-stock' };
      let targetAfter = null;
      if (target) targetAfter = await updateBalance(database, target, input.quantity, databaseNow);

      if (input.movementType === 'INSTALL') {
        const equipmentId = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM customer_equipment').get()).id);
        await database.prepare(`INSERT INTO customer_equipment (
          id, subscription_id, equipment_model_id, serial_no, mac_address,
          ownership, condition_status, installed_at, removed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'IN_USE', ?, NULL, ?, ?)`).run(
          equipmentId, input.subscriptionId, source.equipment_model_id, input.serialNo,
          input.macAddress, input.ownership, databaseOccurredAt, databaseNow, databaseNow,
        );
        equipment = await database.prepare('SELECT * FROM customer_equipment WHERE id = ?').get(equipmentId);
      }
      if (input.movementType === 'RETURN') {
        await database.prepare(`UPDATE customer_equipment SET condition_status = 'RETURNED',
          removed_at = ?, updated_at = ? WHERE id = ?`).run(databaseOccurredAt, databaseNow, equipment.id);
        equipment = await database.prepare('SELECT * FROM customer_equipment WHERE id = ?').get(equipment.id);
      }
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM stock_movements').get()).id);
      await database.prepare(`INSERT INTO stock_movements (
        id, movement_no, warehouse_id, target_warehouse_id, stock_item_id,
        movement_type, quantity, reference_no, occurred_at,
        performed_by_staff_user_id, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, `MOV-${String(id).padStart(8, '0')}`, input.warehouseId,
        input.targetWarehouseId, input.stockItemId, input.movementType,
        input.quantity, input.referenceNo, databaseOccurredAt, actorId,
        await encodeNotes(input.adjustmentDirection, input.notes), databaseNow,
      );
      const movement = await database.prepare('SELECT * FROM stock_movements WHERE id = ?').get(id);
      await afterWrite(database, movement, source, sourceAfter);
      return { kind: 'created', movement, balance: sourceAfter, targetBalance: targetAfter, equipment };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-movement' };
    throw error;
  } finally { database.close(); }
}
