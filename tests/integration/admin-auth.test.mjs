import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

function sessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  return { setCookie, cookie: setCookie.split(';', 1)[0] };
}

async function login(application, staffUserId, { cookie, fetchSite = 'same-origin' } = {}) {
  return fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': fetchSite,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ staffUserId }),
  });
}

test('development login is disabled by default and exposes no account list', async (t) => {
  const application = await startSeededApplication(t);

  const [usersResponse, loginResponse] = await Promise.all([
    fetch(`${application.origin}/api/v1/admin/auth/development-users`),
    login(application, 1),
  ]);

  assert.equal(usersResponse.status, 404);
  assert.equal(loginResponse.status, 404);
  assert.equal((await loginResponse.json()).error.code, 'DEVELOPMENT_LOGIN_DISABLED');
});

test('development login lists safe test identities and creates a hardened session cookie', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });

  const usersResponse = await fetch(`${application.origin}/api/v1/admin/auth/development-users`);
  const usersBody = await usersResponse.json();
  assert.equal(usersResponse.status, 200);
  assert.deepEqual(usersBody.data.users.map(({ staffNo }) => staffNo), [
    'DEV-ADMIN',
    'DEV-CS',
    'DEV-TECH',
    'DEV-BILL',
    'DEV-AUDIT',
  ]);
  assert.doesNotMatch(JSON.stringify(usersBody), /email|providerSubject|token/i);

  const response = await login(application, 1);
  const bodyText = await response.text();
  const body = JSON.parse(bodyText);
  const { setCookie, cookie } = sessionCookie(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.user, {
    id: 1,
    staffNo: 'DEV-ADMIN',
    displayName: '開發系統管理員',
    department: '資訊部',
  });
  assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
  assert.match(setCookie, /^telecom_admin_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/api\/v1\/admin/i);
  assert.match(setCookie, /Max-Age=1800/i);
  assert.doesNotMatch(bodyText, new RegExp(cookie.split('=')[1]));

  const sessionResponse = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).data.user.id, 1);
});

test('login rotates an existing session and logout revokes the replacement', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const firstCookie = sessionCookie(await login(application, 1)).cookie;
  const secondResponse = await login(application, 1, { cookie: firstCookie });
  const secondCookie = sessionCookie(secondResponse).cookie;
  const secondBody = await secondResponse.json();
  assert.notEqual(secondCookie, firstCookie);

  const firstSession = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie: firstCookie },
  });
  assert.equal(firstSession.status, 401);

  const logoutResponse = await fetch(`${application.origin}/api/v1/admin/auth/logout`, {
    method: 'POST',
    headers: {
      cookie: secondCookie,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': secondBody.data.csrfToken,
    },
  });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/i);

  const reusedSession = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie: secondCookie },
  });
  assert.equal(reusedSession.status, 401);
  assert.equal((await reusedSession.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('expired, unknown, and disabled-user sessions fail with generic authentication errors', async (t) => {
  let now = Date.parse('2026-07-21T00:00:00.000Z');
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    sessionIdleTimeoutMs: 1_000,
    sessionClock: () => now,
  });
  const expiredCookie = sessionCookie(await login(application, 2)).cookie;
  now += 1_001;
  const expired = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie: expiredCookie },
  });
  assert.equal(expired.status, 401);

  const unknown = await fetch(`${application.origin}/api/v1/admin/auth/session`, {
    headers: { cookie: 'telecom_admin_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  });
  assert.equal(unknown.status, 401);

  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare('UPDATE staff_users SET is_active = 0 WHERE id = ?').run(3);
  database.close();
  const disabledLogin = await login(application, 3);
  assert.equal(disabledLogin.status, 401);
  assert.equal((await disabledLogin.json()).error.code, 'AUTHENTICATION_FAILED');
});

test('development login validates input, rejects cross-site requests, and rate limits attempts', async (t) => {
  const application = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    developmentLoginRateLimit: { maxAttempts: 2, windowMs: 60_000 },
  });

  const crossSite = await login(application, 1, { fetchSite: 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'CROSS_SITE_REQUEST');

  const invalid = await login(application, '1');
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, 'VALIDATION_FAILED');

  assert.equal((await login(application, 999)).status, 401);
  assert.equal((await login(application, 999)).status, 401);
  const limited = await login(application, 999);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

const TEST_PASSWORD_HASH = `test$${'x'.repeat(75)}`;
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_PASSWORD_HASHER = Object.freeze({
  async verifyPassword(password, encoded) {
    return encoded === TEST_PASSWORD_HASH && password === TEST_PASSWORD;
  },
  async fakeVerifyPassword() { return false; },
});

async function enablePasswordLogin(application, staffUserId = 1) {
  const database = new DatabaseSync(application.telecomDatabasePath);
  database.prepare(`
    INSERT INTO staff_password_credentials (
      staff_user_id, password_hash, failed_attempts, first_failed_at, locked_until,
      password_changed_at, created_at, updated_at
    ) VALUES (?, ?, 0, NULL, NULL, ?, ?, ?)
  `).run(staffUserId, TEST_PASSWORD_HASH, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
  database.close();
}

async function passwordLogin(application, identifier, password, fetchSite = 'same-origin', forwardedFor = null) {
  return fetch(`${application.origin}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': fetchSite,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: JSON.stringify({ identifier, password }),
  });
}

test('production password login authenticates by staff number and rotates into the existing RBAC session', async (t) => {
  const application = await startSeededApplication(t, { passwordHasher: TEST_PASSWORD_HASHER });
  await enablePasswordLogin(application, 1);

  const response = await passwordLogin(application, 'DEV-ADMIN', TEST_PASSWORD);
  assert.equal(response.status, 200);
  const body = await response.json();
  const { setCookie, cookie } = sessionCookie(response);
  assert.equal(body.data.user.staffNo, 'DEV-ADMIN');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);

  const sessionResponse = await fetch(`${application.origin}/api/v1/admin/auth/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.data.user.id, 1);
  assert.ok(Array.isArray(session.data.permissions));
  assert.ok(session.data.roles.length > 0);
});

test('password login returns the same generic failure for unknown accounts and wrong passwords', async (t) => {
  const application = await startSeededApplication(t, { passwordHasher: TEST_PASSWORD_HASHER });
  await enablePasswordLogin(application, 1);

  const [wrong, unknown] = await Promise.all([
    passwordLogin(application, 'DEV-ADMIN', 'incorrect password'),
    passwordLogin(application, 'missing@example.invalid', 'incorrect password'),
  ]);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const wrongBody = await wrong.json();
  const unknownBody = await unknown.json();
  assert.equal(wrongBody.error.code, 'AUTHENTICATION_FAILED');
  assert.equal(unknownBody.error.code, 'AUTHENTICATION_FAILED');
  assert.equal(wrongBody.error.message, unknownBody.error.message);
});

test('password login locks an account after repeated failures without disclosing lock state', async (t) => {
  let now = Date.parse('2026-08-18T00:00:00.000Z');
  const application = await startSeededApplication(t, {
    passwordHasher: TEST_PASSWORD_HASHER,
    sessionClock: () => now,
    passwordLoginPolicy: { threshold: 2, observationWindowMs: 60_000, lockDurationMs: 60_000 },
  });
  await enablePasswordLogin(application, 1);

  assert.equal((await passwordLogin(application, 'DEV-ADMIN', 'wrong-1')).status, 401);
  assert.equal((await passwordLogin(application, 'DEV-ADMIN', 'wrong-2')).status, 401);
  assert.equal((await passwordLogin(application, 'DEV-ADMIN', TEST_PASSWORD)).status, 401);

  now += 60_001;
  assert.equal((await passwordLogin(application, 'DEV-ADMIN', TEST_PASSWORD)).status, 200);
});



test('password login throttling uses the trusted Apache client address instead of one global loopback bucket', async (t) => {
  const application = await startSeededApplication(t, {
    passwordHasher: TEST_PASSWORD_HASHER,
    passwordLoginRateLimit: { maxAttempts: 1, windowMs: 60_000 },
  });
  await enablePasswordLogin(application, 1);

  assert.equal((await passwordLogin(
    application, 'DEV-ADMIN', 'wrong', 'same-origin', '198.51.100.77, 203.0.113.10',
  )).status, 401);
  assert.equal((await passwordLogin(
    application, 'DEV-ADMIN', 'wrong', 'same-origin', '192.0.2.123, 203.0.113.10',
  )).status, 429);
  assert.equal((await passwordLogin(
    application, 'DEV-ADMIN', 'wrong', 'same-origin', '198.51.100.20',
  )).status, 401);
});
test('production sessions can add the Secure cookie attribute without changing development behavior', async (t) => {
  const application = await startSeededApplication(t, {
    passwordHasher: TEST_PASSWORD_HASHER,
    secureSessionCookie: true,
  });
  await enablePasswordLogin(application, 1);
  const response = await passwordLogin(application, 'DEV-ADMIN', TEST_PASSWORD);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/i);
});
