import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const SORT_COLUMNS = Object.freeze({
  planCode: 'plan_code',
  planName: 'plan_name',
  downloadMbps: 'download_mbps',
  updatedAt: 'updated_at',
});

function escapeLike(value) {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}


export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}
async function selectPlan(database, planId) {
  return await database.prepare(`
    SELECT id, plan_code, plan_name, service_category, technology,
      download_mbps, upload_mbps, bandwidth_label, contract_months,
      wifi_included, description, is_active, effective_from, effective_to,
      created_at, updated_at
    FROM service_plans
    WHERE id = ?
  `).get(planId) ?? null;
}

export async function searchPlanRows({ databasePath, query }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const clauses = [];
    const values = [];
    if (query.keyword) {
      const keyword = `%${await escapeLike(query.keyword)}%`;
      clauses.push(`(
        plan_code LIKE ? ESCAPE '!'
        OR plan_name LIKE ? ESCAPE '!'
        OR bandwidth_label LIKE ? ESCAPE '!'
      )`);
      values.push(keyword, keyword, keyword);
    }
    if (query.isPublished !== null) {
      clauses.push('is_active = ?');
      values.push(query.isPublished ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((await database.prepare(
      `SELECT COUNT(*) AS count FROM service_plans ${where}`,
    ).get(...values)).count);
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.pageSize;
    const rows = await database.prepare(`
      SELECT id, plan_code, plan_name, service_category, technology,
        download_mbps, upload_mbps, bandwidth_label, contract_months,
        wifi_included, description, is_active, effective_from, effective_to,
        created_at, updated_at
      FROM service_plans
      ${where}
      ORDER BY ${SORT_COLUMNS[query.sort]} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...values, query.pageSize, offset);
    return { rows, total };
  } finally {
    database.close();
  }
}

export async function findPlanRow({ databasePath, planId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectPlan(database, planId);
  } finally {
    database.close();
  }
}

export async function createPlanRow({ databasePath, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const result = await database.prepare(`
        INSERT INTO service_plans (
          plan_code, plan_name, service_category, technology,
          download_mbps, upload_mbps, bandwidth_label, contract_months,
          wifi_included, description, is_active, effective_from, effective_to,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        values.planCode,
        values.planName,
        values.serviceCategory,
        values.technology,
        values.downloadMbps,
        values.uploadMbps,
        values.bandwidthLabel,
        values.contractMonths,
        values.wifiIncluded ? 1 : 0,
        values.description,
        values.effectiveFrom,
        values.effectiveTo,
        writeDateTime(database, values.createdAt),
    writeDateTime(database, values.updatedAt),
      );
      const row = await selectPlan(database, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return row;
    });
  } finally {
    database.close();
  }
}

export async function updatePlanRow({
  databasePath,
  planId,
  expectedUpdatedAt,
  updatedAt,
  values,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectPlan(database, planId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE service_plans
        SET plan_code = ?, plan_name = ?, service_category = ?, technology = ?,
          download_mbps = ?, upload_mbps = ?, bandwidth_label = ?, contract_months = ?,
          wifi_included = ?, description = ?, effective_from = ?, effective_to = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        values.planCode,
        values.planName,
        values.serviceCategory,
        values.technology,
        values.downloadMbps,
        values.uploadMbps,
        values.bandwidthLabel,
        values.contractMonths,
        values.wifiIncluded ? 1 : 0,
        values.description,
        values.effectiveFrom,
        values.effectiveTo,
    writeDateTime(database, updatedAt),
    planId,
        before.updated_at,
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectPlan(database, planId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function setPlanPublicationRow({
  databasePath,
  planId,
  expectedUpdatedAt,
  isPublished,
  updatedAt,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectPlan(database, planId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      const update = await database.prepare(`
        UPDATE service_plans
        SET is_active = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(isPublished ? 1 : 0, writeDateTime(database, updatedAt), planId, before.updated_at);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectPlan(database, planId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

async function referenceCounts(database, planId) {
  const references = [
    ['plan_prices', 'service_plan_id'],
    ['promotion_plans', 'service_plan_id'],
    ['service_inquiries', 'requested_plan_id'],
    ['order_service_items', 'service_plan_id'],
  ];
  const counts = await Promise.all(references.map(async ([table, column]) => {
    const row = await database.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    ).get(planId);
    return [table, Number(row.count)];
  }));
  return Object.fromEntries(counts);
}

export async function deletePlanRow({ databasePath, planId, expectedUpdatedAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const row = await selectPlan(database, planId);
      if (!row) return { kind: 'not-found' };
      if (new Date(row.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      const references = await referenceCounts(database, planId);
      if (Object.values(references).some((count) => count > 0)) {
        return { kind: 'referenced', references };
      }
      await database.prepare('DELETE FROM service_plans WHERE id = ?').run(planId);
      await afterWrite(database, row);
      return { kind: 'deleted' };
    });
  } finally {
    database.close();
  }
}
