import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function writeAccessDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function selectStaff(database, staffUserId) {
  const row = await database.prepare(`SELECT id, staff_no, display_name, department, is_active,
    created_at, updated_at FROM staff_users WHERE id = ?`).get(staffUserId);
  if (!row) return null;
  const roles = await database.prepare(`SELECT roles.id, roles.role_code, roles.role_name
    FROM user_roles JOIN roles ON roles.id = user_roles.role_id
    WHERE user_roles.staff_user_id = ? ORDER BY roles.role_code`).all(staffUserId);
  return { ...row, roles };
}

async function activeRoles(database, roleIds) {
  if (roleIds.length === 0) return [];
  return await database.prepare(`SELECT id, role_code, role_name FROM roles
    WHERE is_active = 1 AND id IN (${roleIds.map(() => '?').join(', ')}) ORDER BY role_code`).all(...roleIds);
}

function identityConflict(error) {
  const match = /UNIQUE constraint failed: staff_users\.(staff_no|email|provider_subject)/.exec(error?.message ?? '');
  return match?.[1] ?? null;
}

export async function createStaffRow({ databasePath, values, roleIds, grantedBy, createdAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseCreatedAt = writeAccessDateTime(database, createdAt);
  try {
    return await runAtomicResult(database, async () => {
      const roles = await activeRoles(database, roleIds);
      if (roles.length !== roleIds.length) return { kind: 'invalid-role' };
      const inserted = await database.prepare(`INSERT INTO staff_users
        (staff_no, email, display_name, auth_provider, provider_subject, department,
          is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(values.staffNo, values.email, values.displayName, values.authProvider,
          values.providerSubject, values.department, values.isActive ? 1 : 0,
          databaseCreatedAt, databaseCreatedAt);
      const staffUserId = Number(inserted.lastInsertRowid);
      const insertRole = await database.prepare(`INSERT INTO user_roles
        (assignment_key, staff_user_id, role_id, granted_by, granted_at)
        VALUES (?, ?, ?, ?, ?)`);
      for (const roleId of roleIds) {
        await insertRole.run(`${staffUserId}:${roleId}`, staffUserId, roleId, grantedBy, databaseCreatedAt);
      }
      const after = await selectStaff(database, staffUserId);
      await afterWrite(database, after);
      return { kind: 'created', row: after };
    });
  } catch (error) {
    const field = await identityConflict(error);
    if (field) return { kind: 'identity-conflict', field };
    throw error;
  } finally { database.close(); }
}

export async function readAccessMatrix({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const staffRows = await database.prepare('SELECT id FROM staff_users ORDER BY staff_no').all();
    const staff = await Promise.all(staffRows.map(({ id }) => selectStaff(database, Number(id))));
    const roles = await database.prepare(`SELECT id, role_code, role_name, description, is_active,
      created_at, updated_at FROM roles ORDER BY role_code`).all();
    const permissions = await database.prepare(`SELECT id, permission_code, permission_name,
      module_name, description FROM permissions ORDER BY module_name, permission_code`).all();
    const rolePermissions = await database.prepare(`SELECT role_id, permission_id FROM role_permissions
      ORDER BY role_id, permission_id`).all();
    return { staff, roles, permissions, rolePermissions };
  } finally { database.close(); }
}

async function activeSuperAdminCount(database) {
  return Number((await database.prepare(`SELECT COUNT(DISTINCT staff_users.id) AS count
    FROM staff_users JOIN user_roles ON user_roles.staff_user_id = staff_users.id
    JOIN roles ON roles.id = user_roles.role_id
    WHERE staff_users.is_active = 1 AND roles.is_active = 1 AND roles.role_code = 'SUPER_ADMIN'`).get()).count);
}

function isActiveSuperAdmin(row) {
  return Boolean(row?.is_active) && row.roles.some(({ role_code }) => role_code === 'SUPER_ADMIN');
}

async function hasRestrictedReferences(database, staffUserId) {
  const row = await database.prepare(`SELECT
    EXISTS(SELECT 1 FROM audit_logs WHERE actor_staff_user_id = ?)
    OR EXISTS(SELECT 1 FROM billing_adjustment_requests
      WHERE requested_by_staff_user_id = ? OR approved_by_staff_user_id = ?)
    OR EXISTS(SELECT 1 FROM billing_adjustments WHERE approved_by_staff_user_id = ?)
    OR EXISTS(SELECT 1 FROM cms_announcements WHERE author_staff_user_id = ?)
    OR EXISTS(SELECT 1 FROM cms_pages WHERE author_staff_user_id = ?)
    OR EXISTS(SELECT 1 FROM stock_movements WHERE performed_by_staff_user_id = ?)
    AS is_referenced`).get(
    staffUserId, staffUserId, staffUserId, staffUserId, staffUserId, staffUserId, staffUserId,
  );
  return Boolean(row.is_referenced);
}

export async function deleteStaffRow({ databasePath, staffUserId, expectedUpdatedAt, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectStaff(database, staffUserId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      if (await isActiveSuperAdmin(before) && await activeSuperAdminCount(database) <= 1) return { kind: 'last-admin' };
      if (await hasRestrictedReferences(database, staffUserId)) return { kind: 'referenced' };
      await database.prepare('DELETE FROM user_roles WHERE staff_user_id = ?').run(staffUserId);
      const deleted = await database.prepare('DELETE FROM staff_users WHERE id = ? AND updated_at = ?')
        .run(staffUserId, before.updated_at);
      if (Number(deleted.changes) !== 1) return { kind: 'conflict' };
      await afterWrite(database, before);
      return { kind: 'deleted', row: before };
    });
  } finally { database.close(); }
}

export async function updateStaffRow({ databasePath, staffUserId, expectedUpdatedAt, updatedAt, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectStaff(database, staffUserId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      if (await isActiveSuperAdmin(before) && !values.isActive && await activeSuperAdminCount(database) <= 1) return { kind: 'last-admin' };
      const update = await database.prepare(`UPDATE staff_users SET display_name = ?, department = ?,
        is_active = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
        .run(values.displayName, values.department, values.isActive ? 1 : 0,
          writeAccessDateTime(database, updatedAt), staffUserId, before.updated_at);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectStaff(database, staffUserId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally { database.close(); }
}

export async function replaceStaffRoles({
  databasePath, staffUserId, roleIds, grantedBy, expectedUpdatedAt, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectStaff(database, staffUserId);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      const roles = await activeRoles(database, roleIds);
      if (roles.length !== roleIds.length) return { kind: 'invalid-role' };
      const removesSuperAdmin = await isActiveSuperAdmin(before)
        && !roles.some(({ role_code }) => role_code === 'SUPER_ADMIN');
      if (removesSuperAdmin && await activeSuperAdminCount(database) <= 1) return { kind: 'last-admin' };
      await database.prepare('DELETE FROM user_roles WHERE staff_user_id = ?').run(staffUserId);
      const insert = await database.prepare(`INSERT INTO user_roles
        (assignment_key, staff_user_id, role_id, granted_by, granted_at)
        VALUES (?, ?, ?, ?, ?)`);
      for (const roleId of roleIds) {
        await insert.run(`${staffUserId}:${roleId}`, staffUserId, roleId, grantedBy,
          writeAccessDateTime(database, updatedAt));
      }
      const update = await database.prepare('UPDATE staff_users SET updated_at = ? WHERE id = ? AND updated_at = ?')
        .run(writeAccessDateTime(database, updatedAt), staffUserId, before.updated_at);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectStaff(database, staffUserId);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally { database.close(); }
}

export async function searchAuditRows({ databasePath, query }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const clauses = []; const values = [];
    if (query.action) { clauses.push('audit_logs.action = ?'); values.push(query.action); }
    if (query.entityType) { clauses.push('audit_logs.entity_type = ?'); values.push(query.entityType); }
    if (query.actorStaffUserId) { clauses.push('audit_logs.actor_staff_user_id = ?'); values.push(query.actorStaffUserId); }
    if (query.from) { clauses.push('audit_logs.created_at >= ?'); values.push(query.from); }
    if (query.to) { clauses.push('audit_logs.created_at <= ?'); values.push(query.to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((await database.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`).get(...values)).count);
    const rows = await database.prepare(`SELECT audit_logs.*, staff_users.staff_no, staff_users.display_name
      FROM audit_logs LEFT JOIN staff_users ON staff_users.id = audit_logs.actor_staff_user_id
      ${where} ORDER BY audit_logs.id DESC LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, (query.page - 1) * query.pageSize);
    return { rows, total };
  } finally { database.close(); }
}

export async function findAuditRow({ databasePath, auditId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`SELECT audit_logs.*, staff_users.staff_no, staff_users.display_name
      FROM audit_logs LEFT JOIN staff_users ON staff_users.id = audit_logs.actor_staff_user_id
      WHERE audit_logs.id = ?`).get(auditId) ?? null;
  } finally { database.close(); }
}
