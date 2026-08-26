import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function selectOrder(database, orderId) {
  return (await database.prepare(`
    SELECT id, order_no, order_type, status, service_location_id, updated_at
    FROM sales_orders WHERE id = ?
  `).get(orderId)) ?? null;
}

async function selectWorkOrder(database, orderId) {
  return (await database.prepare(`
    SELECT id, work_order_no, work_type, status
    FROM work_orders WHERE sales_order_id = ? ORDER BY id LIMIT 1
  `).get(orderId)) ?? null;
}

async function eligibleForInstallation(database, order) {
  if (!['NEW_SERVICE', 'UPGRADE'].includes(order.order_type) || order.service_location_id === null) {
    return false;
  }
  return Boolean(await database.prepare(`
    SELECT 1 FROM order_service_items WHERE sales_order_id = ? LIMIT 1
  `).get(order.id));
}

async function createInstallationWorkOrder(database, order, actorId, now) {
  const existing = await selectWorkOrder(database, order.id);
  if (existing) return existing;
  const result = await database.prepare(`
    INSERT INTO work_orders (
      work_order_no, service_location_id, sales_order_id, work_type,
      priority, status, problem_description, created_at, updated_at
    ) VALUES (?, ?, ?, 'INSTALL', 'NORMAL', 'OPEN', ?, ?, ?)
  `).run(
    `WO-INSTALL-${order.id}`,
    order.service_location_id,
    order.id,
    `Install service for ${order.order_no}`,
    now,
    now,
  );
  const workOrderId = Number(result.lastInsertRowid);
  await database.prepare(`
    INSERT INTO work_order_status_history (
      work_order_id, from_status, to_status, changed_by_staff_user_id, notes, changed_at
    ) VALUES (?, NULL, 'OPEN', ?, 'Created by order approval', ?)
  `).run(workOrderId, actorId, now);
  return selectWorkOrder(database, order.id);
}

export async function transitionOrder({
  databasePath,
  orderId,
  action,
  expectedUpdatedAt,
  updatedAt,
  actorId,
  reason,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  return runAtomicResult(database, async () => {
    const before = await selectOrder(database, orderId);
    if (!before) return { kind: 'not-found' };
    const targets = { submit: 'SUBMITTED', approve: 'APPROVED', cancel: 'CANCELLED' };
    const target = targets[action];
    if (before.status === target) {
      return { kind: 'replayed', order: before, workOrder: await selectWorkOrder(database, orderId) };
    }
    const valid = (
      (action === 'submit' && before.status === 'DRAFT')
      || (action === 'approve' && before.status === 'SUBMITTED')
      || (action === 'cancel' && ['DRAFT', 'SUBMITTED'].includes(before.status))
    );
    if (!valid) return { kind: 'invalid-transition' };
    if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
    const update = await database.prepare(`
      UPDATE sales_orders SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?
    `).run(target, databaseUpdatedAt, orderId, before.updated_at);
    if (Number(update.changes) !== 1) return { kind: 'conflict' };
    let workOrder = null;
    if (action === 'approve' && await eligibleForInstallation(database, before)) {
      workOrder = await createInstallationWorkOrder(database, before, actorId, databaseUpdatedAt);
    }
    const after = await selectOrder(database, orderId);
    await afterWrite(database, before, after, workOrder, reason);
    return { kind: 'updated', order: after, workOrder };
  });
}
