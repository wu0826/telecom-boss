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

const SELECT_WORK_ORDER = `
  SELECT work_orders.id, work_orders.work_order_no, work_orders.subscription_id,
    work_orders.service_location_id, work_orders.sales_order_id, work_orders.work_type,
    work_orders.priority, work_orders.status, work_orders.assigned_staff_user_id,
    work_orders.scheduled_at, work_orders.started_at, work_orders.completed_at,
    work_orders.problem_description, work_orders.resolution_notes,
    work_orders.created_at, work_orders.updated_at,
    locations.location_no, locations.city, locations.district, locations.address_line,
    customers.id AS customer_id, customers.customer_no, customers.display_name,
    staff.staff_no AS assigned_staff_no, staff.display_name AS assigned_staff_name
  FROM work_orders
  JOIN service_locations AS locations ON locations.id = work_orders.service_location_id
  JOIN customers ON customers.id = locations.customer_id
  LEFT JOIN staff_users AS staff ON staff.id = work_orders.assigned_staff_user_id
`;

async function selectHistory(database, workOrderId) {
  return await database.prepare(`
    SELECT history.id, history.from_status, history.to_status,
      history.changed_by_staff_user_id, history.changed_at,
      staff.staff_no AS changed_by_staff_no, staff.display_name AS changed_by_staff_name
    FROM work_order_status_history AS history
    LEFT JOIN staff_users AS staff ON staff.id = history.changed_by_staff_user_id
    WHERE history.work_order_id = ?
    ORDER BY history.changed_at, history.id
  `).all(workOrderId);
}

async function selectDetail(database, workOrderId) {
  const row = await database.prepare(`${SELECT_WORK_ORDER} WHERE work_orders.id = ?`).get(workOrderId);
  if (!row) return null;
  return { row, history: await selectHistory(database, workOrderId) };
}

async function referenceError(database, input) {
  const location = await database.prepare(`
    SELECT id FROM service_locations
    WHERE id = ? AND status IN ('PENDING_SURVEY', 'SERVICEABLE')
  `).get(input.serviceLocationId);
  if (!location) return 'invalid-location';

  if (input.subscriptionId !== null) {
    const subscription = await database.prepare(`
      SELECT id FROM subscriptions WHERE id = ? AND service_location_id = ?
    `).get(input.subscriptionId, input.serviceLocationId);
    if (!subscription) return 'invalid-subscription';
  }

  if (input.salesOrderId !== null) {
    const order = await database.prepare(`
      SELECT id FROM sales_orders
      WHERE id = ? AND service_location_id = ? AND status = 'APPROVED'
    `).get(input.salesOrderId, input.serviceLocationId);
    if (!order) return 'invalid-order';
  }
  return null;
}

async function eligibleAssignee(database, staffUserId) {
  return await database.prepare(`
    SELECT DISTINCT staff.id
    FROM staff_users AS staff
    JOIN user_roles ON user_roles.staff_user_id = staff.id
    JOIN roles ON roles.id = user_roles.role_id AND roles.is_active = 1
    JOIN role_permissions ON role_permissions.role_id = roles.id
    JOIN permissions ON permissions.id = role_permissions.permission_id
    WHERE staff.id = ? AND staff.is_active = 1
      AND permissions.permission_code = 'operations.manage'
  `).get(staffUserId) ?? null;
}

async function insertHistory(database, workOrderId, fromStatus, toStatus, actorId, changedAt) {
  await database.prepare(`
    INSERT INTO work_order_status_history (
      work_order_id, from_status, to_status, changed_by_staff_user_id, notes, changed_at
    ) VALUES (?, ?, ?, ?, NULL, ?)
  `).run(workOrderId, fromStatus, toStatus, actorId, changedAt);
}

export async function createWorkOrder({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      const invalidReference = await referenceError(database, input);
      if (invalidReference) return { kind: invalidReference };
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM work_orders').get()).id);
      const workOrderNo = `WO-${String(id).padStart(8, '0')}`;
      await database.prepare(`
        INSERT INTO work_orders (
          id, work_order_no, subscription_id, service_location_id, sales_order_id,
          work_type, priority, status, assigned_staff_user_id, scheduled_at,
          started_at, completed_at, problem_description, resolution_notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, NULL, ?, NULL, ?, ?)
      `).run(
        id, workOrderNo, input.subscriptionId, input.serviceLocationId, input.salesOrderId,
        input.workType, input.priority, input.problemDescription, databaseNow, databaseNow,
      );
      await insertHistory(database, id, null, 'OPEN', actorId, databaseNow);
      const detail = await selectDetail(database, id);
      await afterWrite(database, detail);
      return { kind: 'created', detail };
    });
  } finally {
    database.close();
  }
}

export async function transitionWorkOrder({
  databasePath, workOrderId, action, input, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const before = await database.prepare('SELECT * FROM work_orders WHERE id = ?').get(workOrderId);
      if (!before) return { kind: 'not-found' };
      if (before.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (['COMPLETED', 'CANCELLED'].includes(before.status)) return { kind: 'invalid-transition' };

      const changes = {
        status: before.status,
        assignedStaffUserId: before.assigned_staff_user_id,
        scheduledAt: before.scheduled_at,
        startedAt: before.started_at,
        completedAt: before.completed_at,
        resolutionNotes: before.resolution_notes,
      };
      if (action === 'assign') {
        if (before.status !== 'OPEN') return { kind: 'invalid-transition' };
        if (!await eligibleAssignee(database, input.assignedStaffUserId)) return { kind: 'ineligible-assignee' };
        changes.status = 'ASSIGNED';
        changes.assignedStaffUserId = input.assignedStaffUserId;
      } else if (action === 'schedule') {
        if (before.status !== 'ASSIGNED') return { kind: 'invalid-transition' };
        changes.status = 'SCHEDULED';
        changes.scheduledAt = writeDateTime(database, input.scheduledAt);
      } else if (action === 'start') {
        if (before.status !== 'SCHEDULED') return { kind: 'invalid-transition' };
        changes.status = 'IN_PROGRESS';
        changes.startedAt = databaseUpdatedAt;
      } else if (action === 'complete') {
        if (before.status !== 'IN_PROGRESS') return { kind: 'invalid-transition' };
        changes.status = 'COMPLETED';
        changes.completedAt = databaseUpdatedAt;
        changes.resolutionNotes = input.resolutionNotes;
      } else if (action === 'cancel') {
        if (!['OPEN', 'ASSIGNED', 'SCHEDULED'].includes(before.status)) {
          return { kind: 'invalid-transition' };
        }
        changes.status = 'CANCELLED';
        changes.completedAt = databaseUpdatedAt;
        changes.resolutionNotes = input.reason;
      } else {
        return { kind: 'invalid-transition' };
      }

      const result = await database.prepare(`
        UPDATE work_orders
        SET status = ?, assigned_staff_user_id = ?, scheduled_at = ?, started_at = ?,
          completed_at = ?, resolution_notes = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        changes.status, changes.assignedStaffUserId, changes.scheduledAt, changes.startedAt,
      changes.completedAt, changes.resolutionNotes, databaseUpdatedAt, workOrderId, expectedUpdatedAt,
      );
      if (Number(result.changes) !== 1) return { kind: 'conflict' };
      await insertHistory(database, workOrderId, before.status, changes.status, actorId, databaseUpdatedAt);
      const detail = await selectDetail(database, workOrderId);
      await afterWrite(database, before, detail.row);
      return { kind: 'updated', detail: await selectDetail(database, workOrderId) };
    });
  } finally {
    database.close();
  }
}

export async function findWorkOrderDetail({ databasePath, workOrderId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectDetail(database, workOrderId);
  } finally {
    database.close();
  }
}

export async function listWorkOrderRows({ databasePath, filters }) {
  const clauses = [];
  const values = [];
  if (filters.status) {
    clauses.push('work_orders.status = ?');
    values.push(filters.status);
  }
  if (filters.assignedStaffUserId) {
    clauses.push('work_orders.assigned_staff_user_id = ?');
    values.push(filters.assignedStaffUserId);
  }
  if (filters.q) {
    clauses.push(`(work_orders.work_order_no LIKE ? ESCAPE '!' OR customers.display_name LIKE ? ESCAPE '!')`);
    const pattern = `%${filters.q.replace(/[!%_]/g, '!$&')}%`;
    values.push(pattern, pattern);
  }
  if (filters.from) {
    clauses.push('work_orders.scheduled_at >= ?');
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push('work_orders.scheduled_at < ?');
    values.push(filters.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      ${SELECT_WORK_ORDER}
      ${where}
      ORDER BY CASE WHEN work_orders.scheduled_at IS NULL THEN 1 ELSE 0 END,
        work_orders.scheduled_at, work_orders.priority DESC, work_orders.id DESC
      LIMIT 100
    `).all(...values);
  } finally {
    database.close();
  }
}
