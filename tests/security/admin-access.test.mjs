import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(app, staffUserId) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('access matrix is admin-only while the auditor receives read-only masked audit access', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1); const customer = await login(app, 2); const auditor = await login(app, 5);
  const matrix = await request(app, admin, '/api/v1/admin/access');
  assert.equal(matrix.response.status, 200);
  assert.equal(matrix.body.data.staff.length, 5);
  assert.ok(matrix.body.data.roles.some(({ roleCode }) => roleCode === 'SUPER_ADMIN'));
  assert.ok(matrix.body.data.permissions.some(({ permissionCode }) => permissionCode === 'role.manage'));
  assert.equal((await request(app, customer, '/api/v1/admin/access')).response.status, 403);
  assert.equal((await request(app, auditor, '/api/v1/admin/access')).response.status, 403);
  const audits = await request(app, auditor, '/api/v1/admin/audit?page=1&pageSize=10');
  assert.equal(audits.response.status, 200);
  assert.ok(audits.body.data.length >= 1);
  assert.doesNotMatch(JSON.stringify(audits.body), /cookie|csrf|token|@example\.test/i);
  assert.equal((await request(app, customer, '/api/v1/admin/audit')).response.status, 403);
});

test('a system administrator can create staff in another department with an initial role', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const created = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-OPS',
      email: 'operations@example.test',
      displayName: 'Operations Staff',
      department: 'Operations',
      authProvider: 'OTHER',
      providerSubject: 'dev:operations',
      isActive: true,
      roleIds: [3],
    },
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.staffNo, 'DEV-OPS');
  assert.equal(created.body.data.department, 'Operations');
  assert.deepEqual(created.body.data.roles.map(({ roleCode }) => roleCode), ['TECHNICIAN']);
  assert.equal(Object.hasOwn(created.body.data, 'email'), false);
  assert.equal(Object.hasOwn(created.body.data, 'providerSubject'), false);

  const matrix = await request(app, admin, '/api/v1/admin/access');
  assert.ok(matrix.body.data.staff.some(({ staffNo }) => staffNo === 'DEV-OPS'));

  const database = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  const staff = database.prepare(`SELECT id, email, auth_provider, provider_subject
    FROM staff_users WHERE staff_no = ?`).get('DEV-OPS');
  assert.deepEqual({ ...staff, id: Number(staff.id) }, {
    id: Number(created.body.data.id),
    email: 'operations@example.test',
    auth_provider: 'OTHER',
    provider_subject: 'dev:operations',
  });
  const audit = database.prepare(`SELECT action, entity_type, entity_id, after_json
    FROM audit_logs WHERE action = 'STAFF_CREATED' ORDER BY id DESC LIMIT 1`).get();
  database.close();
  assert.equal(audit.entity_type, 'STAFF_USER');
  assert.equal(audit.entity_id, String(created.body.data.id));
  assert.deepEqual(JSON.parse(audit.after_json), {
    staffNo: 'DEV-OPS', isActive: true, roleCodes: ['TECHNICIAN'],
  });
  assert.doesNotMatch(audit.after_json, /email|provider|operations@example/i);

  const newStaffSession = await login(app, created.body.data.id);
  assert.equal((await request(app, newStaffSession, '/api/v1/admin/auth/session')).response.status, 200);
});

test('staff creation enforces role permission, strict input, unique identities, and active roles', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1); const customer = await login(app, 2);
  const valid = {
    staffNo: 'DEV-NOC', email: 'noc@example.test', displayName: 'NOC Staff', department: 'NOC',
    authProvider: 'OTHER', providerSubject: 'dev:noc', isActive: true, roleIds: [3],
  };
  assert.equal((await request(app, customer, '/api/v1/admin/access/staff', {
    method: 'POST', body: valid,
  })).response.status, 403);
  assert.equal((await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST', body: { ...valid, password: 'must-not-be-accepted' },
  })).response.status, 422);
  assert.equal((await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST', body: { ...valid, roleIds: [999] },
  })).response.status, 422);

  const created = await request(app, admin, '/api/v1/admin/access/staff', { method: 'POST', body: valid });
  assert.equal(created.response.status, 201);
  const duplicate = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST', body: { ...valid, email: 'different@example.test', providerSubject: 'dev:noc-2' },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'STAFF_IDENTITY_CONFLICT');
  assert.equal(duplicate.body.error.details[0].field, 'staffNo');
  assert.equal(duplicate.body.error.details[0].message, '此人員編號已被使用，請改用另一個唯一編號。');
});

test('staff creation rolls back the profile and role assignment when auditing fails', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_staff_created_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'STAFF_CREATED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();

  const failed = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-ROLLBACK', email: 'rollback@example.test', displayName: 'Rollback Staff',
      department: 'Operations', authProvider: 'OTHER', providerSubject: 'dev:rollback',
      isActive: true, roleIds: [3],
    },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM staff_users WHERE staff_no = ?').get('DEV-ROLLBACK').count, 0);
  assert.equal(verify.prepare(`SELECT COUNT(*) AS count FROM user_roles
    JOIN staff_users ON staff_users.id = user_roles.staff_user_id WHERE staff_users.staff_no = ?`).get('DEV-ROLLBACK').count, 0);
  verify.close();
});

test('a system administrator can delete an unreferenced staff account with audit evidence', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const created = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-TEMP', email: 'temporary@example.test', displayName: 'Temporary Staff',
      department: 'Operations', authProvider: 'OTHER', providerSubject: 'dev:temporary',
      isActive: true, roleIds: [3],
    },
  });

  const deleted = await request(app, admin, `/api/v1/admin/access/staff/${created.body.data.id}`, {
    method: 'DELETE', body: { expectedUpdatedAt: created.body.data.updatedAt },
  });

  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.data, { deleted: true, id: created.body.data.id });
  const matrix = await request(app, admin, '/api/v1/admin/access');
  assert.equal(matrix.body.data.staff.some(({ id }) => id === created.body.data.id), false);

  const database = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM staff_users WHERE id = ?').get(created.body.data.id).count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_roles WHERE staff_user_id = ?').get(created.body.data.id).count, 0);
  const audit = database.prepare(`SELECT action, entity_type, entity_id, before_json
    FROM audit_logs WHERE action = 'STAFF_DELETED' ORDER BY id DESC LIMIT 1`).get();
  database.close();
  assert.equal(audit.entity_type, 'STAFF_USER');
  assert.equal(audit.entity_id, String(created.body.data.id));
  assert.deepEqual(JSON.parse(audit.before_json), {
    staffNo: 'DEV-TEMP', isActive: true, roleCodes: ['TECHNICIAN'],
  });
  assert.doesNotMatch(audit.before_json, /email|provider|temporary@example/i);
});

test('staff deletion rejects unauthorized, self, referenced, stale, and unknown-field requests', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1); const customer = await login(app, 2);
  const matrix = (await request(app, admin, '/api/v1/admin/access')).body.data;
  const adminStaff = matrix.staff.find(({ id }) => id === 1);
  const technician = matrix.staff.find(({ id }) => id === 3);

  assert.equal((await request(app, customer, '/api/v1/admin/access/staff/3', {
    method: 'DELETE', body: { expectedUpdatedAt: technician.updatedAt },
  })).response.status, 403);
  const self = await request(app, admin, '/api/v1/admin/access/staff/1', {
    method: 'DELETE', body: { expectedUpdatedAt: adminStaff.updatedAt },
  });
  assert.equal(self.response.status, 409);
  assert.equal(self.body.error.code, 'SELF_DELETE_FORBIDDEN');
  const protectedStaff = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-REFERENCED', email: 'referenced@example.test', displayName: 'Referenced Staff',
      department: null, authProvider: 'OTHER', providerSubject: 'dev:referenced', isActive: true, roleIds: [3],
    },
  });
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.prepare(`INSERT INTO cms_pages
    (slug, title, body_html, status, author_staff_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'staff-reference', 'Reference', 'Reference body', 'DRAFT', protectedStaff.body.data.id,
    '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z',
  );
  database.close();
  const referenced = await request(app, admin, `/api/v1/admin/access/staff/${protectedStaff.body.data.id}`, {
    method: 'DELETE', body: { expectedUpdatedAt: protectedStaff.body.data.updatedAt },
  });
  assert.equal(referenced.response.status, 409, JSON.stringify(referenced.body));
  assert.equal(referenced.body.error.code, 'STAFF_REFERENCED');
  assert.match(referenced.body.error.message, /停用帳號/);
  assert.equal((await request(app, admin, `/api/v1/admin/access/staff/${protectedStaff.body.data.id}`, {
    method: 'DELETE', body: { expectedUpdatedAt: protectedStaff.body.data.updatedAt, force: true },
  })).response.status, 422);

  const created = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-STALE', email: 'stale@example.test', displayName: 'Stale Staff',
      department: null, authProvider: 'OTHER', providerSubject: 'dev:stale', isActive: true, roleIds: [3],
    },
  });
  assert.equal((await request(app, admin, `/api/v1/admin/access/staff/${created.body.data.id}`, {
    method: 'DELETE', body: { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
  })).response.status, 409);
});

test('staff deletion rolls back the account and roles when auditing fails', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const created = await request(app, admin, '/api/v1/admin/access/staff', {
    method: 'POST',
    body: {
      staffNo: 'DEV-DELETE-ROLLBACK', email: 'delete-rollback@example.test', displayName: 'Delete Rollback',
      department: null, authProvider: 'OTHER', providerSubject: 'dev:delete-rollback', isActive: true, roleIds: [3],
    },
  });
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_staff_deleted_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'STAFF_DELETED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();

  const failed = await request(app, admin, `/api/v1/admin/access/staff/${created.body.data.id}`, {
    method: 'DELETE', body: { expectedUpdatedAt: created.body.data.updatedAt },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM staff_users WHERE id = ?').get(created.body.data.id).count, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM user_roles WHERE staff_user_id = ?').get(created.body.data.id).count, 1);
  verify.close();
});

test('role changes require role.manage, protect the last active super admin, and revoke target sessions', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1); const customer = await login(app, 2);
  const matrix = (await request(app, admin, '/api/v1/admin/access')).body.data;
  const first = matrix.staff.find(({ id }) => id === 1); const second = matrix.staff.find(({ id }) => id === 2);
  const blocked = await request(app, admin, '/api/v1/admin/access/staff/1/roles', {
    method: 'PUT', body: { roleIds: [2], expectedUpdatedAt: first.updatedAt },
  });
  assert.equal(blocked.response.status, 409);
  const escalated = await request(app, customer, '/api/v1/admin/access/staff/2/roles', {
    method: 'PUT', body: { roleIds: [1, 2], expectedUpdatedAt: second.updatedAt },
  });
  assert.equal(escalated.response.status, 403);
  const granted = await request(app, admin, '/api/v1/admin/access/staff/2/roles', {
    method: 'PUT', body: { roleIds: [1, 2], expectedUpdatedAt: second.updatedAt },
  });
  assert.equal(granted.response.status, 200);
  assert.equal((await request(app, customer, '/api/v1/admin/auth/session')).response.status, 401);
  const secondAdmin = await login(app, 2);
  const refreshed = (await request(app, secondAdmin, '/api/v1/admin/access')).body.data.staff.find(({ id }) => id === 1);
  const removed = await request(app, secondAdmin, '/api/v1/admin/access/staff/1/roles', {
    method: 'PUT', body: { roleIds: [], expectedUpdatedAt: refreshed.updatedAt },
  });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.data.roles, []);
  assert.equal((await request(app, admin, '/api/v1/admin/auth/session')).response.status, 401);
});

test('staff updates are optimistic, protect the last super admin, and audit failure rolls back role assignments', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const matrix = (await request(app, admin, '/api/v1/admin/access')).body.data;
  const first = matrix.staff.find(({ id }) => id === 1); const technician = matrix.staff.find(({ id }) => id === 3);
  const disabled = await request(app, admin, '/api/v1/admin/access/staff/1', {
    method: 'PATCH', body: {
      displayName: first.displayName, department: first.department,
      isActive: false, expectedUpdatedAt: first.updatedAt,
    },
  });
  assert.equal(disabled.response.status, 409);
  const updated = await request(app, admin, '/api/v1/admin/access/staff/3', {
    method: 'PATCH', body: {
      displayName: '維運工程師', department: '網路維運', isActive: true,
      expectedUpdatedAt: technician.updatedAt,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal((await request(app, admin, '/api/v1/admin/access/staff/3', {
    method: 'PATCH', body: {
      displayName: '過期更新', department: null, isActive: true, expectedUpdatedAt: technician.updatedAt,
    },
  })).response.status, 409);

  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_access_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'STAFF_ROLES_CHANGED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();
  const failed = await request(app, admin, '/api/v1/admin/access/staff/3/roles', {
    method: 'PUT', body: { roleIds: [1, 3], expectedUpdatedAt: updated.body.data.updatedAt },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.deepEqual(verify.prepare('SELECT role_id FROM user_roles WHERE staff_user_id = 3 ORDER BY role_id').all().map(({ role_id }) => role_id), [3]);
  verify.close();
});

test('audit search is bounded, filterable, detailed, masked, paginated, and immutable over HTTP', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1); const auditor = await login(app, 5);
  const matrix = (await request(app, admin, '/api/v1/admin/access')).body.data;
  const technician = matrix.staff.find(({ id }) => id === 3);
  await request(app, admin, '/api/v1/admin/access/staff/3', {
    method: 'PATCH', body: {
      displayName: technician.displayName, department: technician.department,
      isActive: true, expectedUpdatedAt: technician.updatedAt,
    },
  });
  const search = await request(app, auditor, '/api/v1/admin/audit?action=STAFF_PROFILE_UPDATED&page=1&pageSize=1');
  assert.equal(search.response.status, 200);
  assert.equal(search.body.meta.pageSize, 1);
  assert.equal(search.body.data[0].action, 'STAFF_PROFILE_UPDATED');
  assert.match(search.body.data[0].ipAddress, /^.+\*$/);
  const detail = await request(app, auditor, `/api/v1/admin/audit/${search.body.data[0].id}`);
  assert.equal(detail.response.status, 200);
  assert.doesNotMatch(JSON.stringify(detail.body), /provider_subject|email|cookie|csrf|token/i);
  assert.equal((await request(app, auditor, `/api/v1/admin/audit/${detail.body.data.id}`, {
    method: 'PATCH', body: {},
  })).response.status, 405);
  assert.equal((await request(app, auditor, '/api/v1/admin/audit?pageSize=101')).response.status, 422);
});
