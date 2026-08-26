import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { createMysqlRuntimeDatabases } from './db/mysql.mjs';
import { startApplicationServer } from './http/server.mjs';
import { developmentLoginEnabled, resolveRuntimeDriver } from './runtime-config.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configuredPort = Number(process.env.PORT ?? 4_173);
const databaseDriver = resolveRuntimeDriver(process.env);

let databaseOptions;
if (databaseDriver === 'mysql') {
  databaseOptions = await createMysqlRuntimeDatabases(process.env);
} else if (databaseDriver === 'sqlite') {
  databaseOptions = {
    metadataDatabasePath: process.env.WEBSITE_SQLITE_PATH
      ?? join(PROJECT_ROOT, 'database', 'data', 'website_db.sqlite'),
    telecomDatabasePath: process.env.TELECOM_SQLITE_PATH
      ?? join(PROJECT_ROOT, 'database', 'data', 'telecom_boss.sqlite'),
  };
}

const application = await startApplicationServer({
  host: '127.0.0.1',
  port: configuredPort,
  ...databaseOptions,
  enableDevelopmentLogin: developmentLoginEnabled(process.env),
  requireStartupReadiness: databaseDriver === 'mysql',
  secureSessionCookie: process.env.NODE_ENV === 'production',
});

process.stdout.write(`Telecom Boss is running at ${application.origin} (${databaseDriver})\n`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await application.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
