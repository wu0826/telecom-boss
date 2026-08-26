import { openRuntimeDatabase } from '../../db/runtime-database.mjs';

export async function getStaffAccess(databasePath, staffUserId) {
  const database = openRuntimeDatabase(databasePath);
  const roleRows = await database.prepare(`
    SELECT DISTINCT roles.role_code, roles.role_name
    FROM user_roles
    JOIN roles ON roles.id = user_roles.role_id
    WHERE user_roles.staff_user_id = ? AND roles.is_active = 1
    ORDER BY roles.role_code
  `).all(staffUserId);
  const permissionRows = await database.prepare(`
    SELECT DISTINCT permissions.permission_code
    FROM user_roles
    JOIN roles ON roles.id = user_roles.role_id AND roles.is_active = 1
    JOIN role_permissions ON role_permissions.role_id = roles.id
    JOIN permissions ON permissions.id = role_permissions.permission_id
    WHERE user_roles.staff_user_id = ?
    ORDER BY permissions.permission_code
  `).all(staffUserId);
  return {
    roles: roleRows.map((row) => ({ code: row.role_code, name: row.role_name })),
    permissions: permissionRows.map((row) => row.permission_code),
  };
}
