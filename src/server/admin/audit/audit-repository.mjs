export async function insertAudit(database, event) {
  const result = await database.prepare(`
    INSERT INTO audit_logs (
      actor_staff_user_id,
      action,
      entity_type,
      entity_id,
      request_id,
      ip_address,
      user_agent,
      before_json,
      after_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.actorStaffUserId,
    event.action,
    event.entityType,
    event.entityId,
    event.requestId,
    event.ipAddress,
    event.userAgent,
    event.beforeJson,
    event.afterJson,
  );
  const row = await database.prepare(`
    SELECT id, action, created_at
    FROM audit_logs
    WHERE id = ?
  `).get(result.lastInsertRowid);
  return {
    id: Number(row.id),
    action: row.action,
    createdAt: row.created_at,
  };
}
