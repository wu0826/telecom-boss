import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrateMetadataDatabase } from '../../src/server/db/metadata-migration.mjs';
import {
  migrateTelecomTarget,
  TELECOM_MIGRATIONS,
} from '../../src/server/db/migration-runner.mjs';
import { seedMetadataDatabase, seedTelecomDatabase } from '../../src/server/db/seed.mjs';
import { startApplicationServer } from '../../src/server/http/server.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const WEBSITE_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'website_db.schema.json');
const TELECOM_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');

export async function startSeededApplication(t, serverOptions = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-public-'));
  const metadataDatabasePath = join(temporaryDirectory, 'website_db.sqlite');
  const telecomDatabasePath = join(temporaryDirectory, 'telecom_boss.sqlite');

  await migrateMetadataDatabase({
    databasePath: metadataDatabasePath,
    snapshotPath: WEBSITE_SNAPSHOT_PATH,
  });
  await migrateTelecomTarget({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
    migrations: TELECOM_MIGRATIONS,
  });
  await seedMetadataDatabase({
    databasePath: metadataDatabasePath,
    websiteSnapshotPath: WEBSITE_SNAPSHOT_PATH,
    telecomSnapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  await seedTelecomDatabase({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });

  const application = await startApplicationServer({
    host: '127.0.0.1',
    port: 0,
    metadataDatabasePath,
    telecomDatabasePath,
    ...serverOptions,
  });
  t.after(async () => {
    await application.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  return { ...application, metadataDatabasePath, telecomDatabasePath };
}
