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

const SELECT_INCIDENT = `
  SELECT incidents.*, areas.area_code, areas.area_name,
    COUNT(links.id) AS impacted_subscriptions,
    COUNT(DISTINCT subscriptions.customer_id) AS impacted_customers
  FROM outage_incidents AS incidents
  LEFT JOIN service_areas AS areas ON areas.id = incidents.service_area_id
  LEFT JOIN outage_subscriptions AS links ON links.outage_incident_id = incidents.id
  LEFT JOIN subscriptions ON subscriptions.id = links.subscription_id
`;

async function selectIncident(database, incidentId) {
  return await database.prepare(`
    ${SELECT_INCIDENT}
    WHERE incidents.id = ? GROUP BY incidents.id
  `).get(incidentId) ?? null;
}

async function selectDetail(database, incidentId) {
  const row = await selectIncident(database, incidentId);
  if (!row) return null;
  const subscriptions = await database.prepare(`
    SELECT links.id, links.subscription_id, links.impact_started_at, links.impact_ended_at,
      links.notes, subscriptions.subscription_no, subscriptions.status,
      plans.plan_code, plans.plan_name, customers.customer_no, customers.display_name
    FROM outage_subscriptions AS links
    JOIN subscriptions ON subscriptions.id = links.subscription_id
    JOIN service_plans AS plans ON plans.id = subscriptions.service_plan_id
    JOIN customers ON customers.id = subscriptions.customer_id
    WHERE links.outage_incident_id = ? ORDER BY links.id
  `).all(incidentId);
  return { row, subscriptions };
}

export async function createOutage({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  const detectedAt = writeDateTime(database, input.detectedAt);
  try {
    return await runAtomicResult(database, async () => {
      if (input.serviceAreaId !== null) {
        const area = await database.prepare('SELECT id FROM service_areas WHERE id = ?').get(input.serviceAreaId);
        if (!area) return { kind: 'invalid-area' };
      }
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM outage_incidents').get()).id);
      const incidentNo = `OUT-${String(id).padStart(8, '0')}`;
      await database.prepare(`
        INSERT INTO outage_incidents (
          id, incident_no, title, severity, status, service_area_id, detected_at,
          resolved_at, root_cause, resolution_notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'INVESTIGATING', ?, ?, NULL, NULL, NULL, ?, ?)
      `).run(id, incidentNo, input.title, input.severity, input.serviceAreaId, detectedAt, databaseNow, databaseNow);
      const detail = await selectDetail(database, id);
      await afterWrite(database, detail.row, actorId);
      return { kind: 'created', detail };
    });
  } finally {
    database.close();
  }
}

export async function listOutageRows({ databasePath, filters }) {
  const clauses = [];
  const values = [];
  if (filters.status) { clauses.push('incidents.status = ?'); values.push(filters.status); }
  if (filters.severity) { clauses.push('incidents.severity = ?'); values.push(filters.severity); }
  if (filters.q) {
    clauses.push(`(incidents.incident_no LIKE ? ESCAPE '!' OR incidents.title LIKE ? ESCAPE '!')`);
    const pattern = `%${filters.q.replace(/[!%_]/g, '!$&')}%`;
    values.push(pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      ${SELECT_INCIDENT} ${where}
      GROUP BY incidents.id ORDER BY incidents.detected_at DESC, incidents.id DESC LIMIT 100
    `).all(...values);
  } finally {
    database.close();
  }
}

export async function findOutageDetail({ databasePath, incidentId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try { return await selectDetail(database, incidentId); } finally { database.close(); }
}

export async function changeOutageSubscription({
  databasePath, incidentId, mode, input, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const incident = await database.prepare('SELECT * FROM outage_incidents WHERE id = ?').get(incidentId);
      if (!incident) return { kind: 'not-found' };
      if (incident.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (incident.status === 'RESOLVED') return { kind: 'invalid-transition' };
      if (mode === 'add') {
        const subscription = await database.prepare(`
          SELECT id FROM subscriptions WHERE id = ? AND status = 'ACTIVE'
        `).get(input.subscriptionId);
        if (!subscription) return { kind: 'inactive-subscription' };
        const duplicate = await database.prepare(`
          SELECT id FROM outage_subscriptions
          WHERE outage_incident_id = ? AND subscription_id = ?
        `).get(incidentId, input.subscriptionId);
        if (duplicate) return { kind: 'duplicate-membership' };
        const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM outage_subscriptions').get()).id);
        await database.prepare(`
          INSERT INTO outage_subscriptions (
            id, outage_incident_id, subscription_id, impact_started_at,
            impact_ended_at, notes, created_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        `).run(id, incidentId, input.subscriptionId, incident.detected_at, input.notes, databaseUpdatedAt);
      } else {
        const deleted = await database.prepare(`
          DELETE FROM outage_subscriptions
          WHERE outage_incident_id = ? AND subscription_id = ?
        `).run(incidentId, input.subscriptionId);
        if (Number(deleted.changes) !== 1) return { kind: 'membership-not-found' };
      }
      const updated = await database.prepare(`
        UPDATE outage_incidents SET updated_at = ? WHERE id = ? AND updated_at = ?
      `).run(databaseUpdatedAt, incidentId, expectedUpdatedAt);
      if (Number(updated.changes) !== 1) return { kind: 'conflict' };
      const detail = await selectDetail(database, incidentId);
      await afterWrite(database, incident, detail.row, actorId);
      return { kind: 'updated', detail };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-membership' };
    throw error;
  } finally {
    database.close();
  }
}

export async function transitionOutage({
  databasePath, incidentId, action, input, actorId, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseUpdatedAt = writeDateTime(database, updatedAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const before = await database.prepare('SELECT * FROM outage_incidents WHERE id = ?').get(incidentId);
      if (!before) return { kind: 'not-found' };
      if (before.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      const transitions = {
        identify: ['INVESTIGATING', 'IDENTIFIED'],
        monitor: ['IDENTIFIED', 'MONITORING'],
        resolve: ['MONITORING', 'RESOLVED'],
      };
      const transition = transitions[action];
      if (!transition || before.status !== transition[0]) return { kind: 'invalid-transition' };
      const rootCause = action === 'identify' ? input.rootCause : before.root_cause;
      const resolutionNotes = ['monitor', 'resolve'].includes(action)
        ? input.resolutionNotes : before.resolution_notes;
      const resolvedAt = action === 'resolve' ? databaseUpdatedAt : null;
      const update = await database.prepare(`
        UPDATE outage_incidents SET status = ?, root_cause = ?, resolution_notes = ?,
          resolved_at = ?, updated_at = ? WHERE id = ? AND updated_at = ?
      `).run(
        transition[1], rootCause, resolutionNotes, resolvedAt, databaseUpdatedAt,
      incidentId, expectedUpdatedAt,
    );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      if (action === 'resolve') {
        await database.prepare(`
          UPDATE outage_subscriptions SET impact_ended_at = ?
          WHERE outage_incident_id = ? AND impact_ended_at IS NULL
        `).run(databaseUpdatedAt, incidentId);
      }
      const after = await database.prepare('SELECT * FROM outage_incidents WHERE id = ?').get(incidentId);
      await afterWrite(database, before, after, actorId);
      return { kind: 'updated', detail: await selectDetail(database, incidentId) };
    });
  } finally {
    database.close();
  }
}
