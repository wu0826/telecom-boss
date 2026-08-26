import { openRuntimeDatabase } from '../db/runtime-database.mjs';

const METADATA_REQUIRED_MIGRATIONS = Object.freeze([
  'create_metadata_schema',
]);

const TELECOM_REQUIRED_MIGRATIONS = Object.freeze([
  'create_telecom_schema',
  'create_catalog_v2_schema',
  'create_admin_password_auth',
]);

async function checkDatabase(databaseReference, expectedMigrations) {
  try {
    const database = openRuntimeDatabase(databaseReference);
    await database.ping();

    for (const migrationName of expectedMigrations) {
      const migration = await database
        .prepare('SELECT name FROM _schema_migrations WHERE name = ?')
        .get(migrationName);
      if (!migration) return false;
    }

    if (database.kind === 'sqlite') {
      const integrity = await database.prepare('PRAGMA quick_check(1)').get();
      return Object.values(integrity ?? {}).at(0) === 'ok';
    }
    return true;
  } catch {
    return false;
  }
}

export async function getHealth({ metadataDatabasePath, telecomDatabasePath }) {
  const [metadata, telecom] = await Promise.all([
    checkDatabase(metadataDatabasePath, METADATA_REQUIRED_MIGRATIONS),
    checkDatabase(telecomDatabasePath, TELECOM_REQUIRED_MIGRATIONS),
  ]);
  return {
    healthy: metadata && telecom,
    response: {
      status: 'ok',
      databases: {
        metadata: metadata ? 'ok' : 'unavailable',
        telecom: telecom ? 'ok' : 'unavailable',
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

export async function assertRuntimeReadiness(configuration) {
  const health = await getHealth(configuration);
  if (!health.healthy) {
    const unavailable = Object.entries(health.response.databases)
      .filter(([, status]) => status !== 'ok')
      .map(([name]) => name)
      .join(', ');
    throw new Error(`Runtime database readiness check failed: ${unavailable || 'unknown database'}`);
  }
  return health;
}
