import {
  createStaffRow, deleteStaffRow, findAuditRow, readAccessMatrix, replaceStaffRoles, searchAuditRows,
  updateStaffRow,
} from './access-repository.mjs';

const CREATE_FIELDS = new Set([
  'authProvider', 'department', 'displayName', 'email', 'isActive', 'providerSubject', 'roleIds', 'staffNo',
]);
const STAFF_FIELDS = new Set(['department', 'displayName', 'expectedUpdatedAt', 'isActive']);
const DELETE_FIELDS = new Set(['expectedUpdatedAt']);
const ROLE_FIELDS = new Set(['expectedUpdatedAt', 'roleIds']);
const AUDIT_QUERY_FIELDS = new Set(['action', 'actorStaffUserId', 'entityType', 'from', 'page', 'pageSize', 'to']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const STAFF_NO_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER_SUBJECT_PATTERN = /^[^\s\u0000-\u001f\u007f]{2,191}$/;
const AUTH_PROVIDERS = new Set(['GOOGLE', 'LDAP', 'OTHER']);

export class AdminAccessError extends Error {
  constructor(status, code, message, details = []) {
    super(message); this.name = 'AdminAccessError'; this.status = status; this.code = code; this.details = details;
  }
}

function fail(field, message, code = 'INVALID_BODY') {
  throw new AdminAccessError(422, code, '存取控制資料格式不正確。', [{ field, message }]);
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((field) => !fields.has(field));
  if (unknown) fail(unknown, '不支援此欄位。');
}

function positiveId(value, code = 'STAFF_NOT_FOUND') {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) throw new AdminAccessError(404, code, '找不到資料。');
  return id;
}

function expectedUpdatedAt(payload) {
  const value = payload.expectedUpdatedAt;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('expectedUpdatedAt', '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function text(payload, field, max, nullable = false) {
  const raw = payload[field];
  if (nullable && (raw === null || raw === undefined || raw === '')) return null;
  if (typeof raw !== 'string') fail(field, '必須是文字。');
  const value = raw.trim();
  if (!value || value.length > max) fail(field, `長度必須介於 1 到 ${max} 字。`);
  return value;
}

function roleIds(payload, { required = false } = {}) {
  if (!Array.isArray(payload.roleIds) || (required && payload.roleIds.length === 0)
    || payload.roleIds.length > 20 || new Set(payload.roleIds).size !== payload.roleIds.length
    || payload.roleIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    fail('roleIds', `必須是${required ? '含至少一個角色的' : ''}不重複正整數陣列，最多 20 筆。`);
  }
  return [...payload.roleIds].sort((a, b) => a - b);
}

function createValues(payload) {
  const staffNo = text(payload, 'staffNo', 32);
  if (!STAFF_NO_PATTERN.test(staffNo)) fail('staffNo', '限 2 至 32 碼大寫英數字、連字號或底線。');
  const email = text(payload, 'email', 191).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) fail('email', '請輸入有效的電子郵件地址。');
  const authProvider = text(payload, 'authProvider', 16);
  if (!AUTH_PROVIDERS.has(authProvider)) fail('authProvider', '必須是 GOOGLE、LDAP 或 OTHER。');
  const providerSubject = text(payload, 'providerSubject', 191);
  if (!PROVIDER_SUBJECT_PATTERN.test(providerSubject)) fail('providerSubject', '身分識別值不可含空白或控制字元。');
  if (typeof payload.isActive !== 'boolean') fail('isActive', '必須是布林值。');
  return {
    staffNo, email, authProvider, providerSubject,
    displayName: text(payload, 'displayName', 100),
    department: text(payload, 'department', 100, true),
    isActive: payload.isActive,
  };
}

function timestamp(clock, current = null) {
  const now = Number(clock()); if (!Number.isFinite(now)) throw new TypeError('Invalid access clock value');
  return new Date(Math.max(now, current ? Date.parse(current) + 1 : now)).toISOString();
}

function utc(value) { return value ? new Date(value).toISOString() : null; }

function roleDto(row) {
  return { id: Number(row.id), roleCode: row.role_code, roleName: row.role_name };
}

function staffDto(row) {
  return {
    id: Number(row.id), staffNo: row.staff_no, displayName: row.display_name,
    department: row.department, isActive: Boolean(row.is_active), roles: row.roles.map(roleDto),
    createdAt: utc(row.created_at), updatedAt: utc(row.updated_at),
  };
}

function mapResult(result) {
  if (result.kind === 'not-found') throw new AdminAccessError(404, 'STAFF_NOT_FOUND', '找不到後台人員。');
  if (result.kind === 'conflict') throw new AdminAccessError(409, 'STAFF_CONFLICT', '人員資料已更新，請重新載入。');
  if (result.kind === 'last-admin') throw new AdminAccessError(409, 'LAST_SUPER_ADMIN', '不可停用或移除最後一位啟用中的系統管理員。');
  if (result.kind === 'referenced') throw new AdminAccessError(
    409,
    'STAFF_REFERENCED',
    '此人員已有必須保留的營運紀錄，無法刪除；請改為停用帳號。',
  );
  if (result.kind === 'invalid-role') throw new AdminAccessError(422, 'INVALID_BODY', '角色不存在或未啟用。', [{ field: 'roleIds', message: '請重新整理頁面，再選擇至少一個已啟用角色。' }]);
  if (result.kind === 'identity-conflict') {
    const field = { staff_no: 'staffNo', email: 'email', provider_subject: 'providerSubject' }[result.field];
    const message = {
      staffNo: '此人員編號已被使用，請改用另一個唯一編號。',
      email: '此 Email 已被使用，請確認是否已有人員帳號或改用其他工作 Email。',
      providerSubject: '此身分識別值已被使用，請確認身分提供者或改用其他唯一識別值。',
    }[field];
    throw new AdminAccessError(409, 'STAFF_IDENTITY_CONFLICT', '人員編號、Email 或身分識別值已被使用。', [
      { field, message },
    ]);
  }
  return result;
}

function parseAuditQuery(params) {
  for (const key of params.keys()) if (!AUDIT_QUERY_FIELDS.has(key)) fail(key, '不支援此查詢欄位。', 'INVALID_QUERY');
  const action = (params.get('action') ?? '').trim(); const entityType = (params.get('entityType') ?? '').trim();
  if (action && !CODE_PATTERN.test(action)) fail('action', '格式不正確。', 'INVALID_QUERY');
  if (entityType && !CODE_PATTERN.test(entityType)) fail('entityType', '格式不正確。', 'INVALID_QUERY');
  const actorValue = params.get('actorStaffUserId'); const actorStaffUserId = actorValue ? Number(actorValue) : null;
  if (actorValue && (!Number.isSafeInteger(actorStaffUserId) || actorStaffUserId < 1)) fail('actorStaffUserId', '必須是正整數。', 'INVALID_QUERY');
  const parseDate = (name) => {
    const value = params.get(name); if (!value) return null;
    if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(name, '必須是 UTC ISO 8601 時間。', 'INVALID_QUERY');
    return value;
  };
  const from = parseDate('from'); const to = parseDate('to');
  if (from && to && from > to) fail('to', '不可早於開始時間。', 'INVALID_QUERY');
  const page = Number(params.get('page') || 1); const pageSize = Number(params.get('pageSize') || 25);
  if (!Number.isSafeInteger(page) || page < 1) fail('page', '必須是正整數。', 'INVALID_QUERY');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('pageSize', '必須介於 1 到 100。', 'INVALID_QUERY');
  return { action: action || null, entityType: entityType || null, actorStaffUserId, from, to, page, pageSize };
}

function parsedJson(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function maskIp(value) {
  if (!value) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.replace(/\d+$/, '*');
  if (value.includes(':')) return `${value.split(':').slice(0, 2).join(':')}:*`;
  return '*';
}

function auditDto(row) {
  return {
    id: Number(row.id), action: row.action, entityType: row.entity_type, entityId: row.entity_id,
    actor: row.actor_staff_user_id ? {
      id: Number(row.actor_staff_user_id), staffNo: row.staff_no, displayName: row.display_name,
    } : null,
    requestId: row.request_id, ipAddress: maskIp(row.ip_address),
    userAgent: row.user_agent ? '[captured]' : null,
    before: parsedJson(row.before_json), after: parsedJson(row.after_json), createdAt: utc(row.created_at),
  };
}

export function createAdminAccessService({ databasePath, auditService, revokeUserSessions, clock = Date.now }) {
  if (!auditService?.record || typeof revokeUserSessions !== 'function') throw new TypeError('Access dependencies are required');
  const audit = (database, actor, requestAudit, event) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent, ...event,
  }, { database });
  return {
    async matrix() {
      const rows = (await readAccessMatrix({ databasePath }));
      const permissionsByRole = Map.groupBy(rows.rolePermissions, ({ role_id }) => Number(role_id));
      const permissionById = new Map(rows.permissions.map((permission) => [Number(permission.id), permission.permission_code]));
      return {
        staff: rows.staff.map(staffDto),
        roles: rows.roles.map((role) => ({
          ...roleDto(role), description: role.description, isActive: Boolean(role.is_active),
          permissionCodes: (permissionsByRole.get(Number(role.id)) ?? []).map(({ permission_id }) => permissionById.get(Number(permission_id))),
        })),
        permissions: rows.permissions.map((permission) => ({
          id: Number(permission.id), permissionCode: permission.permission_code,
          permissionName: permission.permission_name, moduleName: permission.module_name,
          description: permission.description,
        })),
      };
    },
    async createStaff(payload, actor, requestAudit = {}) {
      objectPayload(payload, CREATE_FIELDS);
      const values = createValues(payload);
      const assignedRoleIds = roleIds(payload, { required: true });
      const result = mapResult((await createStaffRow({
        databasePath, values, roleIds: assignedRoleIds, grantedBy: actor.id, createdAt: timestamp(clock),
        async afterWrite(database, after) {
          await audit(database, actor, requestAudit, {
            action: 'STAFF_CREATED', entityType: 'STAFF_USER', entityId: String(after.id),
            after: {
              staffNo: after.staff_no, isActive: Boolean(after.is_active),
              roleCodes: after.roles.map(({ role_code }) => role_code),
            },
            allowedFields: ['staffNo', 'isActive', 'roleCodes'],
          });
        },
      })));
      return staffDto(result.row);
    },
    async updateStaff(staffUserIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, STAFF_FIELDS); const staffUserId = positiveId(staffUserIdValue); const expected = expectedUpdatedAt(payload);
      if (typeof payload.isActive !== 'boolean') fail('isActive', '必須是布林值。');
      const result = mapResult((await updateStaffRow({
        databasePath, staffUserId, expectedUpdatedAt: expected, updatedAt: timestamp(clock, expected),
        values: { displayName: text(payload, 'displayName', 100), department: text(payload, 'department', 100, true), isActive: payload.isActive },
        async afterWrite(database, before, after) {
          await audit(database, actor, requestAudit, {
            action: 'STAFF_PROFILE_UPDATED', entityType: 'STAFF_USER', entityId: String(staffUserId),
            before: { staffNo: before.staff_no, isActive: Boolean(before.is_active) },
            after: { staffNo: after.staff_no, isActive: Boolean(after.is_active) },
            allowedFields: ['staffNo', 'isActive'],
          });
        },
      })));
      revokeUserSessions(staffUserId); return staffDto(result.row);
    },
    async deleteStaff(staffUserIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, DELETE_FIELDS);
      const staffUserId = positiveId(staffUserIdValue);
      if (staffUserId === actor.id) {
        throw new AdminAccessError(409, 'SELF_DELETE_FORBIDDEN', '不可刪除目前登入中的本人帳號。');
      }
      const expected = expectedUpdatedAt(payload);
      const result = mapResult((await deleteStaffRow({
        databasePath, staffUserId, expectedUpdatedAt: expected,
        async afterWrite(database, before) {
          await audit(database, actor, requestAudit, {
            action: 'STAFF_DELETED', entityType: 'STAFF_USER', entityId: String(staffUserId),
            before: {
              staffNo: before.staff_no, isActive: Boolean(before.is_active),
              roleCodes: before.roles.map(({ role_code }) => role_code),
            },
            allowedFields: ['staffNo', 'isActive', 'roleCodes'],
          });
        },
      })));
      revokeUserSessions(staffUserId);
      return { deleted: true, id: Number(result.row.id) };
    },
    async replaceRoles(staffUserIdValue, payload, actor, requestAudit = {}) {
      objectPayload(payload, ROLE_FIELDS); const staffUserId = positiveId(staffUserIdValue); const expected = expectedUpdatedAt(payload);
      const assignedRoleIds = roleIds(payload);
      const result = mapResult((await replaceStaffRoles({
        databasePath, staffUserId, roleIds: assignedRoleIds,
        grantedBy: actor.id, expectedUpdatedAt: expected, updatedAt: timestamp(clock, expected),
        async afterWrite(database, before, after) {
          await audit(database, actor, requestAudit, {
            action: 'STAFF_ROLES_CHANGED', entityType: 'STAFF_USER', entityId: String(staffUserId),
            before: { roleCodes: before.roles.map(({ role_code }) => role_code) },
            after: { roleCodes: after.roles.map(({ role_code }) => role_code) }, allowedFields: ['roleCodes'],
          });
        },
      })));
      revokeUserSessions(staffUserId); return staffDto(result.row);
    },
    async auditList(params) {
      const query = parseAuditQuery(params); const result = (await searchAuditRows({ databasePath, query }));
      return { data: result.rows.map(auditDto), total: result.total, page: query.page, pageSize: query.pageSize };
    },
    async auditDetail(auditIdValue) {
      const auditId = positiveId(auditIdValue, 'AUDIT_NOT_FOUND');
      const row = (await findAuditRow({ databasePath, auditId }));
      if (!row) throw new AdminAccessError(404, 'AUDIT_NOT_FOUND', '找不到稽核紀錄。');
      return auditDto(row);
    },
  };
}
