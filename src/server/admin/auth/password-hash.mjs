import * as crypto from 'node:crypto';

export const ARGON2ID_PARAMETERS = Object.freeze({
  version: 19,
  memory: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
});

const ENCODED_PATTERN = /^argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;
const DUMMY_SALT = Buffer.from('b7e151628aed2a6abf7158809cf4f3c7', 'hex');

function normalizePassword(password) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string');
  return password.normalize('NFC');
}

function argon2Implementation() {
  if (typeof crypto.argon2 !== 'function') {
    throw new Error('Node.js runtime does not provide crypto.argon2; Node.js >= 24.7.0 is required');
  }
  return (password, salt, parameters) => new Promise((resolve, reject) => {
    crypto.argon2('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      parallelism: parameters.parallelism,
      tagLength: parameters.tagLength,
      memory: parameters.memory,
      passes: parameters.passes,
    }, (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)));
  });
}

function encode({ salt, derivedKey, parameters }) {
  return [
    'argon2id',
    `v=${parameters.version}`,
    `m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}`,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = ENCODED_PATTERN.exec(encoded);
  if (!match) return null;
  const parameters = {
    version: Number(match[1]),
    memory: Number(match[2]),
    passes: Number(match[3]),
    parallelism: Number(match[4]),
    tagLength: Buffer.from(match[6], 'base64url').length,
  };
  if (
    parameters.version !== 19
    || !Number.isSafeInteger(parameters.memory) || parameters.memory < 8 || parameters.memory > 1_048_576
    || !Number.isSafeInteger(parameters.passes) || parameters.passes < 1 || parameters.passes > 10
    || !Number.isSafeInteger(parameters.parallelism) || parameters.parallelism < 1 || parameters.parallelism > 16
    || parameters.tagLength < 4 || parameters.tagLength > 64
  ) return null;
  const salt = Buffer.from(match[5], 'base64url');
  const derivedKey = Buffer.from(match[6], 'base64url');
  if (salt.length < 8 || derivedKey.length !== parameters.tagLength) return null;
  return { parameters, salt, derivedKey };
}

export function validateNewPassword(password) {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < 15 || length > 128) {
    throw new RangeError('Password must contain between 15 and 128 Unicode characters');
  }
  return normalized;
}

export async function hashPassword(password, {
  parameters = ARGON2ID_PARAMETERS,
  randomBytes = crypto.randomBytes,
  deriveKey = argon2Implementation(),
} = {}) {
  const normalized = validateNewPassword(password);
  const salt = randomBytes(parameters.saltLength ?? 16);
  const derivedKey = await deriveKey(normalized, salt, parameters);
  return encode({ salt, derivedKey: Buffer.from(derivedKey), parameters });
}

export async function verifyPassword(password, encoded, { deriveKey = argon2Implementation() } = {}) {
  const normalized = normalizePassword(password);
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const actual = Buffer.from(await deriveKey(normalized, parsed.salt, parsed.parameters));
  return actual.length === parsed.derivedKey.length
    && crypto.timingSafeEqual(actual, parsed.derivedKey);
}

export async function fakeVerifyPassword(password, { deriveKey = argon2Implementation() } = {}) {
  const normalized = normalizePassword(password);
  await deriveKey(normalized, DUMMY_SALT, ARGON2ID_PARAMETERS);
  return false;
}
