import { randomBytes } from 'node:crypto';

import { findActiveStaffByIdentifier, setPasswordCredential } from '../src/server/admin/auth/auth-repository.mjs';
import { hashPassword, validateNewPassword } from '../src/server/admin/auth/password-hash.mjs';
import { createMysqlRuntimeDatabases } from '../src/server/db/mysql.mjs';

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function readStdin() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, '');
}

async function main() {
  if (process.env.DB_USER === 'intern_migrate') {
    throw new Error('Use the runtime intern account for password credential changes, not intern_migrate');
  }
  const identifier = argument('staff-no') ?? argument('email');
  if (!identifier) throw new Error('Pass --staff-no=... or --email=...');
  const generate = hasFlag('generate');
  const stdin = hasFlag('stdin');
  if (generate === stdin) throw new Error('Choose exactly one of --generate or --stdin');

  const password = generate
    ? randomBytes(24).toString('base64url')
    : await readStdin();
  validateNewPassword(password);

  const { metadataDatabase, telecomDatabase } = await createMysqlRuntimeDatabases(process.env);
  try {
    const staff = await findActiveStaffByIdentifier(telecomDatabase, identifier);
    if (!staff) throw new Error('Active staff account was not found');
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();
    await setPasswordCredential(telecomDatabase, staff.id, passwordHash, timestamp);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      staff: { id: staff.id, staffNo: staff.staffNo, displayName: staff.displayName },
      passwordChangedAt: timestamp,
      ...(generate ? { generatedPassword: password } : {}),
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([metadataDatabase.close(), telecomDatabase.close()]);
  }
}

try { await main(); }
catch (error) {
  process.stderr.write(`Admin password command failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
