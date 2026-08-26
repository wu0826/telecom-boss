import { getMysqlCatalogV2Plan, applyMysqlCatalogV2Migration, rollbackMysqlCatalogV2Migration } from '../src/server/db/mysql-catalog-v2-migration.mjs';
import { getMysqlAdminPasswordAuthPlan, applyMysqlAdminPasswordAuthMigration, rollbackMysqlAdminPasswordAuthMigration } from '../src/server/db/mysql-admin-password-auth-migration.mjs';

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mysqlConfigFromEnvironment() {
  const user = readRequiredEnv('DB_USER');
  if (user !== 'intern_migrate') {
    throw new Error('DB_USER must be intern_migrate for schema migration');
  }
  return {
    host: process.env.DB_HOST?.trim() || '127.0.0.1',
    port: readIntegerEnv('DB_PORT', 3306),
    user,
    password: readRequiredEnv('DB_PASSWORD'),
    database: process.env.TELECOM_DB_NAME?.trim() || 'telecom_boss',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  };
}

async function main() {
  const [catalogPlan, authPlan] = await Promise.all([getMysqlCatalogV2Plan(), getMysqlAdminPasswordAuthPlan()]);
  if (hasFlag('--dry-run')) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', telecom: [catalogPlan, authPlan] }, null, 2)}\n`);
    return;
  }

  const rollbackV2 = hasFlag('--rollback-v2');
  const rollbackV3 = hasFlag('--rollback-v3');
  if (rollbackV2 && rollbackV3) throw new Error('Choose only one rollback target');
  const confirmCatalogDataLoss = hasFlag('--confirm-catalog-data-loss');
  const confirmCredentialDataLoss = hasFlag('--confirm-credential-data-loss');
  const config = mysqlConfigFromEnvironment();
  const backupPath = process.env.MYSQL_MIGRATION_BACKUP_PATH?.trim() || null;
  const lockTimeoutSeconds = readIntegerEnv('DB_TRANSACTION_LOCK_TIMEOUT', 15);

  // Dynamic import keeps dry-run usable before npm install on a fresh host.
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection(config);
  try {
    const [identityRows] = await connection.query(
      'SELECT DATABASE() AS database_name, @@version AS mysql_version',
    );
    const identity = identityRows[0] ?? {};
    if (identity.database_name !== config.database) {
      throw new Error(`Connected database is ${identity.database_name ?? 'NULL'}, expected ${config.database}`);
    }

    let mode = 'apply';
    let report;
    if (rollbackV2) {
      mode = 'rollback-v2';
      report = await rollbackMysqlCatalogV2Migration({
        connection,
        migrationUser: config.user,
        backupPath,
        confirmDataLoss: confirmCatalogDataLoss,
        lockTimeoutSeconds,
      });
    } else if (rollbackV3) {
      mode = 'rollback-v3';
      report = await rollbackMysqlAdminPasswordAuthMigration({
        connection,
        migrationUser: config.user,
        backupPath,
        confirmDataLoss: confirmCredentialDataLoss,
        lockTimeoutSeconds,
      });
    } else {
      const catalog = await applyMysqlCatalogV2Migration({
        connection,
        migrationUser: config.user,
        backupPath,
        lockTimeoutSeconds,
      });
      const adminPasswordAuth = await applyMysqlAdminPasswordAuthMigration({
        connection,
        migrationUser: config.user,
        backupPath,
        lockTimeoutSeconds,
      });
      report = { catalog, adminPasswordAuth };
    }

    process.stdout.write(`${JSON.stringify({
      mode,
      database: identity.database_name,
      mysqlVersion: identity.mysql_version,
      migrationUser: config.user,
      report,
    }, null, 2)}\n`);
  } finally {
    await connection.end();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  process.stderr.write(`MySQL migration failed: ${message}${cause ? `; cause: ${cause}` : ''}\n`);
  process.exitCode = 1;
}
