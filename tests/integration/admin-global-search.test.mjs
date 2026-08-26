import assert from 'node:assert/strict';
import test from 'node:test';

import { globalSearchModulesForPermissions } from '../../src/web/admin/js/pages/global-search-page.mjs';
import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(application, staffUserId) {
  const response = await fetch(`${application.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0];
}

async function responseFor(application, cookie, path) {
  return fetch(`${application.origin}${path}`, { headers: { cookie } });
}

test('global search module visibility agrees with cross-role API permissions', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const roles = [
    {
      staffUserId: 2,
      expectedModules: ['inquiries', 'customers', 'subscriptions'],
      allowedPath: '/api/v1/admin/customers?q=FTTH&page=1&pageSize=5',
      hiddenPath: '/api/v1/admin/invoices?q=FTTH',
    },
    {
      staffUserId: 3,
      expectedModules: ['inquiries', 'customers', 'work-orders', 'outages'],
      allowedPath: '/api/v1/admin/work-orders?q=FTTH',
      hiddenPath: '/api/v1/admin/invoices?q=FTTH',
    },
    {
      staffUserId: 4,
      expectedModules: ['inquiries', 'customers', 'invoices'],
      allowedPath: '/api/v1/admin/invoices?q=FTTH',
      hiddenPath: '/api/v1/admin/outages?q=FTTH',
    },
  ];

  for (const role of roles) {
    const cookie = await login(application, role.staffUserId);
    const session = await responseFor(application, cookie, '/api/v1/admin/auth/session');
    assert.equal(session.status, 200);
    const access = (await session.json()).data;
    assert.deepEqual(
      globalSearchModulesForPermissions(access.permissions).map(({ id }) => id),
      role.expectedModules,
    );
    assert.equal((await responseFor(application, cookie, role.allowedPath)).status, 200);
    const hidden = await responseFor(application, cookie, role.hiddenPath);
    assert.equal(hidden.status, 403);
    assert.equal((await hidden.json()).error.code, 'PERMISSION_DENIED');
  }
});
