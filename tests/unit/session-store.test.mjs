import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStore } from '../../src/server/admin/auth/session-store.mjs';

test('session store issues opaque tokens and refreshes idle expiry', () => {
  let now = Date.parse('2026-07-21T00:00:00.000Z');
  const sessions = createSessionStore({ idleTimeoutMs: 60_000, clock: () => now });

  const created = sessions.create(7);
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.expiresAt, '2026-07-21T00:01:00.000Z');

  now += 30_000;
  assert.deepEqual(sessions.get(created.token), {
    userId: 7,
    csrfToken: created.csrfToken,
    expiresAt: '2026-07-21T00:01:30.000Z',
  });
});

test('session store rejects unknown, expired, and explicitly destroyed sessions', () => {
  let now = Date.parse('2026-07-21T00:00:00.000Z');
  const sessions = createSessionStore({ idleTimeoutMs: 1_000, clock: () => now });

  assert.equal(sessions.get('unknown'), null);
  const expired = sessions.create(1);
  now += 1_001;
  assert.equal(sessions.get(expired.token), null);

  const destroyed = sessions.create(2);
  assert.equal(sessions.destroy(destroyed.token), true);
  assert.equal(sessions.get(destroyed.token), null);
});

test('session store can revoke every active session for one staff user', () => {
  const sessions = createSessionStore({ idleTimeoutMs: 60_000 });
  const first = sessions.create(3);
  const second = sessions.create(3);
  const other = sessions.create(4);

  assert.equal(sessions.destroyForUser(3), 2);
  assert.equal(sessions.get(first.token), null);
  assert.equal(sessions.get(second.token), null);
  assert.equal(sessions.get(other.token).userId, 4);
});
