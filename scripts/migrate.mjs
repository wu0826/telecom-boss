import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { migrateMetadataDatabase } from '../src/server/db/metadata-migration.mjs';
import {
  migrateTelecomTarget,
  TELECOM_MIGRATIONS,
} from '../src/server/db/migration-runner.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a path value`);
  }
  return resolve(value);
}

try {
  const report = await migrateMetadataDatabase({
    databasePath: join(PROJECT_ROOT, 'database', 'data', 'website_db.sqlite'),
    snapshotPath: join(PROJECT_ROOT, 'database', 'snapshots', 'website_db.schema.json'),
    backupPath: readOption('--metadata-backup'),
  });
  const telecomReport = await migrateTelecomTarget({
    databasePath: join(PROJECT_ROOT, 'database', 'data', 'telecom_boss.sqlite'),
    snapshotPath: join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json'),
    backupPath: readOption('--telecom-backup'),
    migrations: TELECOM_MIGRATIONS,
  });

  process.stdout.write(`${JSON.stringify({ metadata: report, telecom: telecomReport }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown migration error';
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
}
