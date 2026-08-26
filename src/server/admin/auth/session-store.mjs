import { createHash, randomBytes } from 'node:crypto';

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

export function createSessionStore({ idleTimeoutMs, clock = Date.now }) {
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new TypeError('idleTimeoutMs must be a positive integer');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  const sessionsByHash = new Map();
  const hashesByUser = new Map();

  function deleteHash(hash) {
    const session = sessionsByHash.get(hash);
    if (!session) return false;
    sessionsByHash.delete(hash);
    const userHashes = hashesByUser.get(session.userId);
    userHashes.delete(hash);
    if (userHashes.size === 0) hashesByUser.delete(session.userId);
    return true;
  }

  return {
    create(userId) {
      if (!Number.isSafeInteger(userId) || userId < 1) {
        throw new TypeError('userId must be a positive safe integer');
      }
      const now = clock();
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const hash = tokenHash(token);
      const session = { userId, csrfToken, expiresAt: now + idleTimeoutMs };
      sessionsByHash.set(hash, session);
      const userHashes = hashesByUser.get(userId) ?? new Set();
      userHashes.add(hash);
      hashesByUser.set(userId, userHashes);
      return { token, csrfToken, expiresAt: isoTime(session.expiresAt) };
    },

    get(token) {
      const hash = tokenHash(token);
      const session = sessionsByHash.get(hash);
      if (!session) return null;
      const now = clock();
      if (now >= session.expiresAt) {
        deleteHash(hash);
        return null;
      }
      session.expiresAt = now + idleTimeoutMs;
      return {
        userId: session.userId,
        csrfToken: session.csrfToken,
        expiresAt: isoTime(session.expiresAt),
      };
    },

    destroy(token) {
      return deleteHash(tokenHash(token));
    },

    destroyForUser(userId) {
      const hashes = [...(hashesByUser.get(userId) ?? [])];
      for (const hash of hashes) deleteHash(hash);
      return hashes.length;
    },
  };
}
