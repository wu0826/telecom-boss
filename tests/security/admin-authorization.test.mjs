import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  const body = await response.json();
  return {
    response,
    body,
    cookie: response.headers.get('set-cookie').split(';', 1)[0],
  };
}

test('current-user DTO contains only safe identity, roles, permissions, and a CSRF token', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const signedIn = await login(application, 1);
  const response = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie: signedIn.cookie },
  });
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.user, {
    id: 1,
    staffNo: 'DEV-ADMIN',
    displayName: '開發系統管理員',
    department: '資訊部',
  });
  assert.deepEqual(body.data.roles, [{ code: 'SUPER_ADMIN', name: '系統管理員' }]);
  assert.deepEqual(body.data.permissions, [
    'access.manage',
    'audit.read',
    'billing.manage',
    'catalog.manage',
    'content.manage',
    'customer.read',
    'customer.sensitive.read',
    'customer.write',
    'inventory.manage',
    'operations.manage',
    'order.manage',
    'role.manage',
  ]);
  assert.match(body.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(text, /email|providerSubject|authProvider|sessionToken/i);
});

test('protected admin routes return 401 without a session and 403 without permission', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const anonymous = await fetch(`${application.origin}/api/v1/admin/auth/access-context`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'AUTHENTICATION_REQUIRED');

  const customerService = await login(application, 2);
  const denied = await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
    headers: { cookie: customerService.cookie },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'PERMISSION_DENIED');

  const administrator = await login(application, 1);
  const allowed = await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
    headers: { cookie: administrator.cookie },
  });
  assert.equal(allowed.status, 200);
});

test('permission changes are reflected by an existing session before its next action', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const customerService = await login(application, 2);
  const database = new DatabaseSync(application.telecomDatabasePath);
  try {
    assert.equal((await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
      headers: { cookie: customerService.cookie },
    })).status, 403);

    database.prepare(`
      INSERT INTO role_permissions (id, grant_key, role_id, permission_id)
      VALUES (?, ?, ?, ?)
    `).run(100, '2:9', 2, 9);
    assert.equal((await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
      headers: { cookie: customerService.cookie },
    })).status, 200);

    database.prepare('DELETE FROM role_permissions WHERE id = ?').run(100);
    assert.equal((await fetch(`${application.origin}/api/v1/admin/auth/access-context`, {
      headers: { cookie: customerService.cookie },
    })).status, 403);
  } finally {
    database.close();
  }
});

test('mutating admin routes reject missing, mismatched, cross-site, and stale CSRF tokens', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });

  for (const headers of [
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'A'.repeat(43) },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const signedIn = await login(application, 1);
    const response = await fetch(`${application.origin}/api/v1/admin/auth/logout`, {
      method: 'POST',
      headers: { cookie: signedIn.cookie, ...headers },
    });
    assert.equal(response.status, 403);
  }

  const signedIn = await login(application, 1);
  const success = await fetch(`${application.origin}/api/v1/admin/auth/logout`, {
    method: 'POST',
    headers: {
      cookie: signedIn.cookie,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': signedIn.body.data.csrfToken,
    },
  });
  assert.equal(success.status, 200);

  const replay = await fetch(`${application.origin}/api/v1/admin/auth/logout`, {
    method: 'POST',
    headers: {
      cookie: signedIn.cookie,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': signedIn.body.data.csrfToken,
    },
  });
  assert.equal(replay.status, 401);
});
