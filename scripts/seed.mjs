import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { seedMetadataDatabase, seedTelecomDatabase } from '../src/server/db/seed.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE_SNAPSHOT_PATH = join(
  PROJECT_ROOT,
  'database',
  'snapshots',
  'website_db.schema.json',
);
const TELECOM_SNAPSHOT_PATH = join(
  PROJECT_ROOT,
  'database',
  'snapshots',
  'telecom_boss.schema.json',
);

try {
  const metadata = await seedMetadataDatabase({
    databasePath: join(PROJECT_ROOT, 'database', 'data', 'website_db.sqlite'),
    websiteSnapshotPath: WEBSITE_SNAPSHOT_PATH,
    telecomSnapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  const telecom = await seedTelecomDatabase({
    databasePath: join(PROJECT_ROOT, 'database', 'data', 'telecom_boss.sqlite'),
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  process.stdout.write(`${JSON.stringify({ metadata, telecom }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown seed error';
  process.stderr.write(`Seed failed: ${message}\n`);
  process.exitCode = 1;
}

