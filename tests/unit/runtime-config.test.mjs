import assert from 'node:assert/strict';
import test from 'node:test';

import {
  developmentLoginEnabled,
  resolveRuntimeDriver,
} from '../../src/server/runtime-config.mjs';

test('production runtime defaults to MySQL and refuses SQLite override', () => {
  assert.equal(resolveRuntimeDriver({ NODE_ENV: 'production' }), 'mysql');
  assert.equal(resolveRuntimeDriver({ NODE_ENV: 'production', DB_DRIVER: 'mysql' }), 'mysql');
  assert.throws(
    () => resolveRuntimeDriver({ NODE_ENV: 'production', DB_DRIVER: 'sqlite' }),
    /Production runtime requires DB_DRIVER=mysql/,
  );
});

test('development runtime may use SQLite but rejects unsupported drivers', () => {
  assert.equal(resolveRuntimeDriver({}), 'sqlite');
  assert.equal(resolveRuntimeDriver({ DB_DRIVER: 'mysql' }), 'mysql');
  assert.throws(() => resolveRuntimeDriver({ DB_DRIVER: 'postgres' }), /Unsupported DB_DRIVER/);
});

test('development login is fail-closed in production', () => {
  assert.equal(developmentLoginEnabled({}), false);
  assert.equal(developmentLoginEnabled({ ENABLE_DEVELOPMENT_LOGIN: 'true' }), true);
  assert.throws(
    () => developmentLoginEnabled({ NODE_ENV: 'production', ENABLE_DEVELOPMENT_LOGIN: 'true' }),
    /cannot be enabled in production/,
  );
});
