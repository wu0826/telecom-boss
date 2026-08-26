import { randomUUID } from 'node:crypto';

import { createMysqlRuntimeDatabases } from '../src/server/db/mysql.mjs';
import { assertRuntimeReadiness } from '../src/server/services/health-service.mjs';
import { resolveRuntimeDriver } from '../src/server/runtime-config.mjs';

class ExpectedRollback extends Error {}

function requireProductionMysql(env) {
  if ((env.NODE_ENV ?? '') !== 'production') {
    throw new Error('Smoke test requires NODE_ENV=production');
  }
  if (resolveRuntimeDriver(env) !== 'mysql') {
    throw new Error('Smoke test requires DB_DRIVER=mysql');
  }
}

async function scalar(database, sql, ...params) {
  const row = await database.prepare(sql).get(...params);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

async function reversibleWriteProbe(database) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const categoryCode = `SMOKE_${suffix}`;
  const slug = `smoke-${suffix}`;
  try {
    await database.transaction(async (transactionDatabase) => {
      await transactionDatabase.prepare(`
        INSERT INTO catalog_categories (
          parent_id, category_code, slug, category_name, description,
          sort_order, is_active, created_by_staff_user_id,
          updated_by_staff_user_id, created_at, updated_at, row_version
        ) VALUES (NULL, ?, ?, ?, ?, 0, 0, NULL, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 1)
      `).run(categoryCode, slug, 'Production smoke probe', 'Automatically rolled back');

      const inserted = await transactionDatabase
        .prepare('SELECT id FROM catalog_categories WHERE category_code = ?')
        .get(categoryCode);
      if (!inserted?.id) throw new Error('Reversible Catalog write probe could not read its inserted row');

      // Deliberately abort. A successful smoke probe must leave production data unchanged.
      throw new ExpectedRollback('rollback smoke probe');
    });
    throw new Error('Reversible write probe unexpectedly committed');
  } catch (error) {
    if (!(error instanceof ExpectedRollback)) throw error;
  }

  const remaining = await scalar(
    database,
    'SELECT COUNT(*) AS count FROM catalog_categories WHERE category_code = ?',
    categoryCode,
  );
  if (remaining !== 0) throw new Error('Reversible write probe left production data behind');
}

async function main() {
  requireProductionMysql(process.env);
  const databases = await createMysqlRuntimeDatabases(process.env);
  const { metadataDatabase, telecomDatabase } = databases;
  try {
    const readiness = await assertRuntimeReadiness({
      metadataDatabasePath: metadataDatabase,
      telecomDatabasePath: telecomDatabase,
    });

    const counts = {
      servicePlans: await scalar(telecomDatabase, 'SELECT COUNT(*) AS count FROM service_plans'),
      catalogProducts: await scalar(telecomDatabase, 'SELECT COUNT(*) AS count FROM catalog_products'),
      orders: await scalar(telecomDatabase, 'SELECT COUNT(*) AS count FROM sales_orders'),
      invoices: await scalar(telecomDatabase, 'SELECT COUNT(*) AS count FROM invoices'),
      passwordCredentials: await scalar(telecomDatabase, 'SELECT COUNT(*) AS count FROM staff_password_credentials'),
    };

    await reversibleWriteProbe(telecomDatabase);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      readiness: readiness.response,
      counts,
      reversibleWriteProbe: 'rolled-back',
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([metadataDatabase.close(), telecomDatabase.close()]);
  }
}

await main();
