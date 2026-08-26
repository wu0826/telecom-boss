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

const SELECT_SUBSCRIPTION = `
  SELECT subscriptions.*, customers.customer_no, customers.display_name,
    locations.location_no, locations.city, locations.district, locations.address_line,
    plans.plan_code, plans.plan_name,
    order_items.sales_order_id, orders.order_no,
    accounts.id AS account_id, accounts.circuit_no, accounts.access_username,
    accounts.credential_secret_ref, accounts.ip_assignment, accounts.static_ip,
    accounts.vlan_id, accounts.activated_at AS account_activated_at,
    accounts.deactivated_at AS account_deactivated_at,
    accounts.updated_at AS account_updated_at
  FROM subscriptions
  JOIN customers ON customers.id = subscriptions.customer_id
  JOIN service_locations AS locations ON locations.id = subscriptions.service_location_id
  JOIN service_plans AS plans ON plans.id = subscriptions.service_plan_id
  LEFT JOIN order_service_items AS order_items ON order_items.id = subscriptions.order_service_item_id
  LEFT JOIN sales_orders AS orders ON orders.id = order_items.sales_order_id
  LEFT JOIN service_accounts AS accounts ON accounts.subscription_id = subscriptions.id
`;

async function selectDetail(database, subscriptionId) {
  const row = await database.prepare(`${SELECT_SUBSCRIPTION} WHERE subscriptions.id = ?`).get(subscriptionId);
  if (!row) return null;
  const history = await database.prepare(`
    SELECT history.id, history.from_status, history.to_status,
      history.changed_by_staff_user_id, history.change_reason, history.changed_at,
      staff.staff_no, staff.display_name AS staff_name
    FROM subscription_status_history AS history
    LEFT JOIN staff_users AS staff ON staff.id = history.changed_by_staff_user_id
    WHERE history.subscription_id = ? ORDER BY history.changed_at, history.id
  `).all(subscriptionId);
  const workOrders = await database.prepare(`
    SELECT id, work_order_no, work_type, status, scheduled_at, completed_at
    FROM work_orders WHERE subscription_id = ? ORDER BY created_at, id
  `).all(subscriptionId);
  return { row, history, workOrders };
}

async function insertHistory(database, subscriptionId, fromStatus, toStatus, actorId, reason, now) {
  await database.prepare(`
    INSERT INTO subscription_status_history (
      subscription_id, from_status, to_status, changed_by_staff_user_id, change_reason, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(subscriptionId, fromStatus, toStatus, actorId, reason, now);
}

function addMonths(dateText, months) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export async function provisionSubscriptionFromCompletedInstall({ database, workOrderId, actorId, now }) {
  const databaseNow = writeDateTime(database, now);
  const source = await database.prepare(`
    SELECT work_orders.id AS work_order_id, work_orders.work_type, work_orders.sales_order_id,
      work_orders.service_location_id, work_orders.subscription_id,
      orders.customer_id, items.id AS order_service_item_id, items.service_plan_id,
      items.unit_price, items.quantity, items.contract_months
    FROM work_orders
    LEFT JOIN sales_orders AS orders ON orders.id = work_orders.sales_order_id
    LEFT JOIN order_service_items AS items ON items.sales_order_id = orders.id
    WHERE work_orders.id = ?
    ORDER BY items.id LIMIT 1
  `).get(workOrderId);
  if (!source || source.work_type !== 'INSTALL') return null;
  if (source.subscription_id !== null) {
    return { created: false, subscriptionId: Number(source.subscription_id) };
  }
  if (source.sales_order_id === null || source.order_service_item_id === null) return null;
  const existing = await database.prepare(`
    SELECT id FROM subscriptions WHERE order_service_item_id = ?
  `).get(source.order_service_item_id);
  if (existing) {
    await database.prepare('UPDATE work_orders SET subscription_id = ? WHERE id = ?')
      .run(existing.id, workOrderId);
    return { created: false, subscriptionId: Number(existing.id) };
  }

  const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM subscriptions').get()).id);
  const subscriptionNo = `SUB-${String(id).padStart(8, '0')}`;
  const contractStartDate = databaseNow.slice(0, 10);
  const contractEndDate = await addMonths(contractStartDate, Number(source.contract_months));
  const monthlyFee = Number(source.unit_price) * Number(source.quantity);
  await database.prepare(`
    INSERT INTO subscriptions (
      id, subscription_no, customer_id, service_location_id, service_plan_id,
      order_service_item_id, status, contract_start_date, contract_end_date,
      activated_at, terminated_at, monthly_fee, billing_day, auto_renew,
      termination_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL, NULL, ?, 1, 0, NULL, ?, ?)
  `).run(
    id, subscriptionNo, source.customer_id, source.service_location_id,
    source.service_plan_id, source.order_service_item_id, contractStartDate,
    contractEndDate, monthlyFee, databaseNow, databaseNow,
  );
  await insertHistory(database, id, null, 'PENDING', actorId, null, databaseNow);
  await database.prepare('UPDATE work_orders SET subscription_id = ? WHERE id = ?').run(id, workOrderId);
  return { created: true, subscriptionId: id };
}

export async function listSubscriptionRows({ databasePath, filters }) {
  const clauses = [];
  const values = [];
  if (filters.status) {
    clauses.push('subscriptions.status = ?');
    values.push(filters.status);
  }
  if (filters.q) {
    clauses.push(`(subscriptions.subscription_no LIKE ? ESCAPE '!'
      OR customers.display_name LIKE ? ESCAPE '!' OR plans.plan_name LIKE ? ESCAPE '!')`);
    const pattern = `%${filters.q.replace(/[!%_]/g, '!$&')}%`;
    values.push(pattern, pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      ${SELECT_SUBSCRIPTION} ${where}
      ORDER BY subscriptions.updated_at DESC, subscriptions.id DESC LIMIT 100
    `).all(...values);
  } finally {
    database.close();
  }
}

export async function findSubscriptionDetail({ databasePath, subscriptionId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectDetail(database, subscriptionId);
  } finally {
    database.close();
  }
}

export async function transitionSubscription({
  databasePath, subscriptionId, action, input, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const before = await database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!before) return { kind: 'not-found' };
      if (before.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (['TERMINATED', 'EXPIRED'].includes(before.status)) return { kind: 'invalid-transition' };
      const targetByAction = {
        activate: before.status === 'PENDING' ? 'ACTIVE' : null,
        suspend: before.status === 'ACTIVE' ? 'SUSPENDED' : null,
        resume: before.status === 'SUSPENDED' ? 'ACTIVE' : null,
        terminate: ['PENDING', 'ACTIVE', 'SUSPENDED'].includes(before.status) ? 'TERMINATED' : null,
        expire: ['ACTIVE', 'SUSPENDED'].includes(before.status) ? 'EXPIRED' : null,
      };
      const target = targetByAction[action];
      if (!target) return { kind: 'invalid-transition' };
      const activatedAt = target === 'ACTIVE' && before.activated_at === null
        ? databaseUpdatedAt : before.activated_at;
      const terminatedAt = ['TERMINATED', 'EXPIRED'].includes(target) ? databaseUpdatedAt : null;
      const terminationReason = target === 'TERMINATED' ? input.reason : before.termination_reason;
      const update = await database.prepare(`
        UPDATE subscriptions
        SET status = ?, activated_at = ?, terminated_at = ?, termination_reason = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        target, activatedAt, terminatedAt, terminationReason, databaseUpdatedAt,
      subscriptionId, expectedUpdatedAt,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      await insertHistory(database, subscriptionId, before.status, target, actorId, input.reason, databaseUpdatedAt);
      const after = await database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      await afterWrite(database, before, after);
      return { kind: 'updated', detail: await selectDetail(database, subscriptionId) };
    });
  } finally {
    database.close();
  }
}

export async function saveServiceAccount({
  databasePath, subscriptionId, input, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const subscription = await database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
      if (!subscription) return { kind: 'not-found' };
      if (subscription.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (['TERMINATED', 'EXPIRED'].includes(subscription.status)) return { kind: 'invalid-transition' };
      const before = await database.prepare('SELECT * FROM service_accounts WHERE subscription_id = ?')
        .get(subscriptionId) ?? null;
      const credentialSecretRef = input.credentialSecretRef === undefined
        ? before?.credential_secret_ref ?? null : input.credentialSecretRef;
      if (before) {
        await database.prepare(`
          UPDATE service_accounts SET circuit_no = ?, access_username = ?,
            credential_secret_ref = ?, ip_assignment = ?, static_ip = ?, vlan_id = ?,
            updated_at = ? WHERE subscription_id = ?
        `).run(
          input.circuitNo, input.accessUsername, credentialSecretRef,
          input.ipAssignment, input.staticIp, input.vlanId, databaseUpdatedAt, subscriptionId,
        );
      } else {
        const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM service_accounts').get()).id);
        await database.prepare(`
          INSERT INTO service_accounts (
            id, subscription_id, circuit_no, access_username, credential_secret_ref,
            ip_assignment, static_ip, vlan_id, activated_at, deactivated_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(
          id, subscriptionId, input.circuitNo, input.accessUsername,
          credentialSecretRef, input.ipAssignment, input.staticIp,
          input.vlanId, databaseUpdatedAt, databaseUpdatedAt,
        );
      }
      const update = await database.prepare(`
        UPDATE subscriptions SET updated_at = ? WHERE id = ? AND updated_at = ?
      `).run(databaseUpdatedAt, subscriptionId, expectedUpdatedAt);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await database.prepare('SELECT * FROM service_accounts WHERE subscription_id = ?')
        .get(subscriptionId);
      await afterWrite(database, before, after, actorId);
      return { kind: 'updated', detail: await selectDetail(database, subscriptionId) };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-account' };
    throw error;
  } finally {
    database.close();
  }
}
