import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ARGON2ID_PARAMETERS,
  hashPassword,
  parsePasswordHash,
  validateNewPassword,
  verifyPassword,
} from '../../src/server/admin/auth/password-hash.mjs';

async function fakeDerive(password, salt, parameters) {
  return createHash('sha256')
    .update(password)
    .update(salt)
    .update([parameters.memory, parameters.passes, parameters.parallelism, parameters.tagLength].join(':'))
    .digest();
}

test('password hashing stores an Argon2id-style encoded record and verifies in constant-size buffers', async () => {
  const hash = await hashPassword('correct horse battery staple', {
    randomBytes: () => Buffer.alloc(16, 7),
    deriveKey: fakeDerive,
  });
  const parsed = parsePasswordHash(hash);
  assert.equal(parsed.parameters.memory, ARGON2ID_PARAMETERS.memory);
  assert.equal(parsed.parameters.passes, ARGON2ID_PARAMETERS.passes);
  assert.equal(parsed.parameters.parallelism, ARGON2ID_PARAMETERS.parallelism);
  assert.equal(await verifyPassword('correct horse battery staple', hash, { deriveKey: fakeDerive }), true);
  assert.equal(await verifyPassword('incorrect horse battery staple', hash, { deriveKey: fakeDerive }), false);
});

test('new passwords follow the single-factor minimum without arbitrary composition rules', () => {
  assert.throws(() => validateNewPassword('short-password'), /between 15 and 128/);
  assert.equal(validateNewPassword('這是一組足夠長而且可以包含空白的管理員密碼'), '這是一組足夠長而且可以包含空白的管理員密碼');
  assert.equal(validateNewPassword('a password with spaces and no forced symbols'), 'a password with spaces and no forced symbols');
});

test('stored Argon2 parameters are bounded before verification work is accepted', () => {
  const salt = Buffer.alloc(16, 1).toString('base64url');
  const key = Buffer.alloc(32, 2).toString('base64url');
  assert.equal(parsePasswordHash(`argon2id$v=19$m=1048577,t=2,p=1$${salt}$${key}`), null);
  assert.equal(parsePasswordHash(`argon2id$v=19$m=19456,t=11,p=1$${salt}$${key}`), null);
  assert.equal(parsePasswordHash(`argon2id$v=19$m=19456,t=2,p=17$${salt}$${key}`), null);
});
