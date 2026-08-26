import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import test from 'node:test';

import {
  applyMysqlAdminPasswordAuthMigration,
  getMysqlAdminPasswordAuthPlan,
} from '../../src/server/db/mysql-admin-password-auth-migration.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

async function backupFile() {
  const dir = await mkdtemp(join(tmpdir(), 'telecom-mysql-auth-v3-'));
  const backup = join(dir, 'telecom_boss.sql');
  await writeFile(backup, '-- verified backup\n');
  return backup;
}

class FakeConnection {
  constructor() {
    this.history = [
      { version: 1, name: 'create_telecom_schema' },
      { version: 2, name: 'create_catalog_v2_schema' },
    ];
    this.tableExists = false;
  }

  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (/SELECT GET_LOCK/i.test(normalized)) return [[{ acquired: 1 }], []];
    if (/SELECT RELEASE_LOCK/i.test(normalized)) return [[{ released: 1 }], []];
    if (/SELECT version, name FROM _schema_migrations/i.test(normalized)) {
      return [this.history.map((row) => ({ ...row })), []];
    }
    if (/information_schema\.tables/i.test(normalized)) {
      return [[{ count: this.tableExists ? 1 : 0 }], []];
    }
    if (/CREATE TABLE `staff_password_credentials`/i.test(normalized)) {
      this.tableExists = true;
      return [{ affectedRows: 0 }, []];
    }
    if (/DROP TABLE IF EXISTS `staff_password_credentials`/i.test(normalized)) {
      this.tableExists = false;
      return [{ affectedRows: 0 }, []];
    }
    if (/INSERT INTO _schema_migrations/i.test(normalized)) {
      this.history.push({ version: Number(values[0]), name: values[1] });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected fake query: ${normalized}`);
  }
}

test('MySQL admin password auth v3 adds one credential table without storing plaintext passwords', async () => {
  const [plan, sql] = await Promise.all([
    getMysqlAdminPasswordAuthPlan(),
    readFile(path.join(root, 'database/migrations/mysql/003_admin_password_auth_up.sql'), 'utf8'),
  ]);
  assert.deepEqual(plan.migration, { version: 3, name: 'create_admin_password_auth' });
  assert.deepEqual(plan.createsTables, ['staff_password_credentials']);
  assert.match(sql, /password_hash/);
  assert.match(sql, /FOREIGN KEY \(`staff_user_id`\) REFERENCES `staff_users`/);
  assert.match(sql, /failed_attempts/);
  assert.doesNotMatch(sql, /plaintext|password_value|raw_password/i);
});

test('MySQL admin password auth v3 verifies v1/v2 and registers only after the credential table exists', async () => {
  const connection = new FakeConnection();
  const report = await applyMysqlAdminPasswordAuthMigration({
    connection,
    migrationUser: 'intern_migrate',
    backupPath: await backupFile(),
  });
  assert.equal(report.status, 'applied');
  assert.equal(connection.tableExists, true);
  assert.deepEqual(connection.history.at(-1), { version: 3, name: 'create_admin_password_auth' });
});
