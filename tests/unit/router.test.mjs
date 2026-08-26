import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouter } from '../../src/server/http/router.mjs';

const noopHandler = () => {};

test('router resolves exact and parameterized paths without executing handlers', () => {
  const router = createRouter();
  router.register({ method: 'GET', path: '/api/v1/health', handler: noopHandler });
  router.register({ method: 'GET', path: '/api/v1/catalog/plans/:id', handler: noopHandler });

  const exact = router.resolve('GET', '/api/v1/health');
  const parameterized = router.resolve('GET', '/api/v1/catalog/plans/17');

  assert.equal(exact.kind, 'match');
  assert.equal(exact.handler, noopHandler);
  assert.deepEqual(exact.params, {});
  assert.equal(parameterized.kind, 'match');
  assert.deepEqual(parameterized.params, { id: '17' });
});

test('router distinguishes method mismatch from an unknown path', () => {
  const router = createRouter();
  router.register({ method: 'GET', path: '/api/v1/catalog', handler: noopHandler });
  router.register({ method: 'POST', path: '/api/v1/catalog', handler: noopHandler });

  assert.deepEqual(router.resolve('PATCH', '/api/v1/catalog'), {
    kind: 'method-not-allowed',
    allowedMethods: ['GET', 'POST'],
  });
  assert.deepEqual(router.resolve('GET', '/api/v1/unknown'), { kind: 'not-found' });
});

test('router preserves authentication and permission metadata for admin guards', () => {
  const router = createRouter();
  router.register({
    method: 'GET',
    path: '/api/v1/admin/inquiries/:id',
    authentication: 'required',
    permission: 'inquiry.read',
    handler: noopHandler,
  });

  const resolution = router.resolve('GET', '/api/v1/admin/inquiries/42');

  assert.equal(resolution.kind, 'match');
  assert.equal(resolution.authentication, 'required');
  assert.equal(resolution.permission, 'inquiry.read');
  assert.deepEqual(resolution.params, { id: '42' });
});

test('router rejects duplicate or unsafe route declarations', () => {
  const router = createRouter();
  router.register({ method: 'GET', path: '/api/v1/health', handler: noopHandler });

  assert.throws(
    () => router.register({ method: 'GET', path: '/api/v1/health', handler: noopHandler }),
    /already registered/,
  );
  assert.throws(
    () => router.register({ method: 'GET', path: '/api/v1/items/:bad-name', handler: noopHandler }),
    /Invalid route parameter/,
  );
  assert.throws(
    () => router.register({
      method: 'GET',
      path: '/api/v1/admin/inquiries',
      authentication: 'required',
      handler: noopHandler,
    }),
    /permission/,
  );
});
