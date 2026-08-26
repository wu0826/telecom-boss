import { resolve } from 'node:path';

import { exportCatalogAdminSchema } from './export-catalog-admin-schema.mjs';

const DEFAULT_DATABASE_PATH = resolve('database/data/catalog_admin.sqlite');
const DEFAULT_OUTPUT_PATH = resolve('database/exports/yankees_service_cms.catalog-v2.schema.json');

try {
  const report = await exportCatalogAdminSchema({
    databasePath: process.argv[2] ?? DEFAULT_DATABASE_PATH,
    outputPath: process.argv[3] ?? DEFAULT_OUTPUT_PATH,
    targetName: 'yankees_service_cms',
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown CSMU schema export error';
  process.stderr.write(`CSMU catalog export failed: ${message}\n`);
  process.exitCode = 1;
}
