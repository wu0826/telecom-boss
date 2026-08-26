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

async function selectPrice(database, priceId, planId) {
  return await database.prepare(`
    SELECT id, service_plan_id, price_type, billing_cycle, amount,
      month_from, month_to, effective_from, effective_to, priority,
      is_active, created_at, updated_at
    FROM plan_prices
    WHERE id = ? AND service_plan_id = ?
  `).get(priceId, planId) ?? null;
}

async function planExists(database, planId) {
  return Boolean(await database.prepare('SELECT 1 FROM service_plans WHERE id = ?').get(planId));
}

async function hasOverlap(database, planId, values, excludedPriceId = 0) {
  return Boolean(await database.prepare(`
    SELECT 1
    FROM plan_prices
    WHERE service_plan_id = ?
      AND price_type = ?
      AND billing_cycle = ?
      AND priority = ?
      AND is_active = 1
      AND id <> ?
      AND COALESCE(month_from, -2147483648) <= COALESCE(?, 2147483647)
      AND COALESCE(month_to, 2147483647) >= COALESCE(?, -2147483648)
      AND COALESCE(effective_from, '0001-01-01') <= COALESCE(?, '9999-12-31')
      AND COALESCE(effective_to, '9999-12-31') >= COALESCE(?, '0001-01-01')
    LIMIT 1
  `).get(
    planId,
    values.priceType,
    values.billingCycle,
    values.priority,
    excludedPriceId,
    values.monthTo,
    values.monthFrom,
    values.effectiveTo,
    values.effectiveFrom,
  ));
}

export async function listPriceRows({ databasePath, planId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    if (!await planExists(database, planId)) return { kind: 'plan-not-found' };
    return {
      kind: 'found',
      rows: await database.prepare(`
        SELECT id, service_plan_id, price_type, billing_cycle, amount,
          month_from, month_to, effective_from, effective_to, priority,
          is_active, created_at, updated_at
        FROM plan_prices
        WHERE service_plan_id = ?
        ORDER BY priority, price_type, month_from, effective_from, id
      `).all(planId),
    };
  } finally {
    database.close();
  }
}

export async function createPriceRow({ databasePath, planId, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await planExists(database, planId)) return { kind: 'plan-not-found' };
      if (values.isActive && await hasOverlap(database, planId, values)) return { kind: 'overlap' };
      const result = await database.prepare(`
        INSERT INTO plan_prices (
          price_period_key, service_plan_id, price_type, billing_cycle, amount,
          month_from, month_to, effective_from, effective_to, priority,
          is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.pricePeriodKey,
        planId,
        values.priceType,
        values.billingCycle,
        values.amountMinor,
        values.monthFrom,
        values.monthTo,
        values.effectiveFrom,
        values.effectiveTo,
        values.priority,
        values.isActive ? 1 : 0,
        writeDateTime(database, values.createdAt),
    writeDateTime(database, values.updatedAt),
      );
      const row = await selectPrice(database, Number(result.lastInsertRowid), planId);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updatePriceRow({
  databasePath,
  planId,
  priceId,
  expectedUpdatedAt,
  updatedAt,
  values,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectPrice(database, priceId, planId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      if (values.isActive && await hasOverlap(database, planId, values, priceId)) return { kind: 'overlap' };
      const update = await database.prepare(`
        UPDATE plan_prices
        SET price_period_key = ?, price_type = ?, billing_cycle = ?, amount = ?,
          month_from = ?, month_to = ?, effective_from = ?, effective_to = ?,
          priority = ?, is_active = ?, updated_at = ?
        WHERE id = ? AND service_plan_id = ? AND updated_at = ?
      `).run(
        values.pricePeriodKey,
        values.priceType,
        values.billingCycle,
        values.amountMinor,
        values.monthFrom,
        values.monthTo,
        values.effectiveFrom,
        values.effectiveTo,
        values.priority,
        values.isActive ? 1 : 0,
    writeDateTime(database, updatedAt),
    priceId,
        planId,
        before.updated_at,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectPrice(database, priceId, planId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function deletePriceRow({ databasePath, planId, priceId, expectedUpdatedAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const row = await selectPrice(database, priceId, planId);
      if (!row) return { kind: 'not-found' };
      if (new Date(row.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      const references = Number((await database.prepare(`
        SELECT COUNT(*) AS count FROM order_service_items WHERE plan_price_id = ?
      `).get(priceId)).count);
      if (references > 0) return { kind: 'referenced' };
      await database.prepare('DELETE FROM plan_prices WHERE id = ? AND service_plan_id = ?').run(priceId, planId);
      await afterWrite(database, row);
      return { kind: 'deleted' };
    });
  } finally {
    database.close();
  }
}
