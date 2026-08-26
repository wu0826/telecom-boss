import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const SORT_COLUMNS = Object.freeze({
  createdAt: 'service_inquiries.created_at',
  inquiryNo: 'service_inquiries.inquiry_no',
  status: 'service_inquiries.status',
});

function escapeLike(value) {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

export function mysqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.valueOf())) {
    throw new TypeError('Invalid MySQL datetime value');
  }

  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function buildWhere(filters) {
  const clauses = [];
  const values = [];
  if (filters.keyword) {
    const keyword = `%${await escapeLike(filters.keyword)}%`;
    clauses.push(`(
      service_inquiries.inquiry_no LIKE ? ESCAPE '!'
      OR service_inquiries.prospect_name LIKE ? ESCAPE '!'
      OR service_inquiries.phone LIKE ? ESCAPE '!'
      OR service_inquiries.email LIKE ? ESCAPE '!'
    )`);
    values.push(keyword, keyword, keyword, keyword);
  }
  for (const [column, value] of [
    ['service_inquiries.requested_plan_id', filters.planId],
    ['service_inquiries.channel', filters.channel],
    ['service_inquiries.status', filters.status],
    ['service_inquiries.assigned_staff_user_id', filters.assigneeId],
  ]) {
    if (value !== null) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (filters.fromAt) {
    clauses.push('service_inquiries.created_at >= ?');
    values.push(filters.fromAt);
  }
  if (filters.toAt) {
    clauses.push('service_inquiries.created_at < ?');
    values.push(filters.toAt);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

const SELECT_FIELDS = `
  service_inquiries.id,
  service_inquiries.inquiry_no,
  service_inquiries.prospect_name,
  service_inquiries.phone,
  service_inquiries.email,
  service_inquiries.address_text,
  service_inquiries.channel,
  service_inquiries.status,
  service_inquiries.created_at,
  service_inquiries.updated_at,
  service_plans.id AS plan_id,
  service_plans.plan_code,
  service_plans.plan_name,
  staff_users.id AS assignee_id,
  staff_users.display_name AS assignee_name
`;

const JOINS = `
  FROM service_inquiries
  LEFT JOIN service_plans ON service_plans.id = service_inquiries.requested_plan_id
  LEFT JOIN staff_users ON staff_users.id = service_inquiries.assigned_staff_user_id
`;

export async function searchInquiryRows({ databasePath, query }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const where = await buildWhere(query);
    const total = Number((await database.prepare(`
      SELECT COUNT(*) AS count
      ${JOINS}
      ${where.sql}
    `).get(...where.values)).count);
    const sortColumn = SORT_COLUMNS[query.sort];
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const pageSize = Number(query.pageSize);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await database.prepare(`
      SELECT ${SELECT_FIELDS}
      ${JOINS}
      ${where.sql}
      ORDER BY ${sortColumn} ${direction}, service_inquiries.id ${direction}
      LIMIT ${pageSize} OFFSET ${offset}
    `).all(...where.values);
    return { rows, total };
  } finally {
    database.close();
  }
}

export async function findInquiryRow({ databasePath, inquiryId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectInquiryById(database, inquiryId);
  } finally {
    database.close();
  }
}

async function selectInquiryById(database, inquiryId) {
  return await database.prepare(`
    SELECT ${SELECT_FIELDS}
    ${JOINS}
    WHERE service_inquiries.id = ?
  `).get(inquiryId) ?? null;
}

async function eligibleAssignee(database, staffUserId) {
  if (staffUserId === null) return true;
  return Boolean(await database.prepare(`
    SELECT 1
    FROM staff_users
    JOIN user_roles ON user_roles.staff_user_id = staff_users.id
    JOIN roles ON roles.id = user_roles.role_id AND roles.is_active = 1
    JOIN role_permissions ON role_permissions.role_id = roles.id
    JOIN permissions ON permissions.id = role_permissions.permission_id
    WHERE staff_users.id = ?
      AND staff_users.is_active = 1
      AND permissions.permission_code = 'customer.write'
    LIMIT 1
  `).get(staffUserId));
}

export async function listEligibleInquiryAssignees(databasePath) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      SELECT DISTINCT
        staff_users.id,
        staff_users.staff_no,
        staff_users.display_name,
        staff_users.department
      FROM staff_users
      JOIN user_roles ON user_roles.staff_user_id = staff_users.id
      JOIN roles ON roles.id = user_roles.role_id AND roles.is_active = 1
      JOIN role_permissions ON role_permissions.role_id = roles.id
      JOIN permissions ON permissions.id = role_permissions.permission_id
      WHERE staff_users.is_active = 1
        AND permissions.permission_code = 'customer.write'
      ORDER BY staff_users.display_name, staff_users.id
    `).all();
  } finally {
    database.close();
  }
}

export async function updateInquiryWorkflowRow({
  databasePath,
  inquiryId,
  expectedUpdatedAt,
  requestedAssigneeId,
  updatedAt,
  validate,
  afterUpdate,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const current = await database.prepare(`
        SELECT id, status, assigned_staff_user_id, updated_at
        FROM service_inquiries
        WHERE id = ?
      `).get(inquiryId);
      if (!current) return { kind: 'not-found' };
      const normalizedUpdatedAt = new Date(current.updated_at).toISOString();
      if (normalizedUpdatedAt !== expectedUpdatedAt) return { kind: 'conflict' };
      const next = await validate({
        current,
        assigneeEligible: await eligibleAssignee(database, requestedAssigneeId),
      });
      const update = await database.prepare(`
        UPDATE service_inquiries
        SET assigned_staff_user_id = ?, status = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        next.assignedStaffUserId,
        next.status,
        writeDateTime(database, updatedAt),
        inquiryId,
        writeDateTime(database, expectedUpdatedAt),
      );
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const updated = await selectInquiryById(database, inquiryId);
      await afterUpdate(database, current, updated);
      return { kind: 'updated', row: updated };
    });
  } finally {
    database.close();
  }
}
