import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  TelecomMigrationError,
  migrateTelecomDatabase,
} from '../../src/server/db/telecom-migration.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');

function applicationTables(database) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT GLOB 'sqlite_*'
        AND substr(name, 1, 1) <> '_'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
}

function leadingIndexColumns(database, tableName) {
  const columns = new Set();
  for (const index of database.prepare(`PRAGMA index_list('${tableName}')`).all()) {
    const [firstColumn] = database.prepare(`PRAGMA index_info('${index.name}')`).all();
    if (firstColumn?.name) columns.add(firstColumn.name);
  }
  return columns;
}

function uniqueLeadingColumns(database, tableName) {
  const columns = new Set();
  for (const index of database.prepare(`PRAGMA index_list('${tableName}')`).all()) {
    if (index.unique !== 1) continue;
    const [firstColumn] = database.prepare(`PRAGMA index_info('${index.name}')`).all();
    if (firstColumn?.name) columns.add(firstColumn.name);
  }
  return columns;
}

test('telecom migration compiles all snapshot tables, columns, keys, and relations', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-business-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  const report = await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });

  assert.equal(report.databaseName, 'telecom_boss');
  assert.equal(report.tableCount, 39);
  assert.equal(report.columnCount, 421);
  assert.equal(report.relationCount, 64);
  assert.equal(report.decimalScaleByColumn['plan_prices.amount'], 2);
  assert.equal(report.decimalScaleByColumn['invoice_items.quantity'], 3);

  database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA foreign_keys = ON');

  const planPriceColumns = database.prepare("PRAGMA table_info('plan_prices')").all();
  assert.equal(planPriceColumns.find(({ name }) => name === 'amount').dflt_value, '0');
  assert.equal(planPriceColumns.find(({ name }) => name === 'billing_cycle').dflt_value, "'MONTHLY'");
  const invoiceItemColumns = database.prepare("PRAGMA table_info('invoice_items')").all();
  assert.equal(invoiceItemColumns.find(({ name }) => name === 'quantity').dflt_value, '1000');

  const expectedTables = [
    ...snapshot.tables.map(({ en_name }) => en_name),
    'billing_adjustment_requests',
  ].sort();
  assert.deepEqual(applicationTables(database), expectedTables);
  assert.deepEqual(
    database.prepare("PRAGMA table_info('billing_adjustment_requests')").all().map(({ name }) => name),
    [
      'id', 'request_no', 'invoice_id', 'adjustment_type', 'amount', 'reason',
      'requested_by_staff_user_id', 'status', 'approved_by_staff_user_id',
      'approved_at', 'created_at', 'updated_at',
    ],
  );

  const tableById = new Map(snapshot.tables.map((table) => [table.id, table]));
  const columnsByTable = Map.groupBy(snapshot.columns, ({ table_id }) => table_id);
  const relationByChild = new Map(snapshot.relations.map((relation) => [
    `${relation.to_table_id}.${relation.to_col}`,
    relation,
  ]));
  let foreignKeyCount = 0;

  for (const table of snapshot.tables) {
    const expectedColumns = columnsByTable.get(table.id);
    const actualColumns = database.prepare(`PRAGMA table_info('${table.en_name}')`).all();
    assert.deepEqual(
      actualColumns.map(({ name }) => name),
      expectedColumns.map(({ en_name }) => en_name),
      `${table.en_name} columns must match the telecom snapshot`,
    );
    assert.ok(actualColumns.some(({ pk }) => pk === 1), `${table.en_name} must have a PK`);

    const indexedColumns = leadingIndexColumns(database, table.en_name);
    const uniqueColumns = uniqueLeadingColumns(database, table.en_name);
    for (const column of expectedColumns) {
      if (column.is_index || column.is_unique) {
        assert.ok(indexedColumns.has(column.en_name), `${table.en_name}.${column.en_name} needs an index`);
      }
      if (column.is_unique) {
        assert.ok(uniqueColumns.has(column.en_name), `${table.en_name}.${column.en_name} needs UNIQUE`);
      }

      const actualColumn = actualColumns.find(({ name }) => name === column.en_name);
      if (column.data_type === 'DECIMAL') {
        assert.equal(actualColumn.type, 'INTEGER', `${table.en_name}.${column.en_name} uses fixed-scale INTEGER`);
      }
    }

    const foreignKeys = database.prepare(`PRAGMA foreign_key_list('${table.en_name}')`).all();
    foreignKeyCount += foreignKeys.length;
    for (const foreignKey of foreignKeys) {
      assert.ok(
        indexedColumns.has(foreignKey.from),
        `${table.en_name}.${foreignKey.from} must lead an index`,
      );

      const sourceColumn = expectedColumns.find(({ en_name }) => en_name === foreignKey.from);
      const expectedRelation = relationByChild.get(`${table.id}.${foreignKey.from}`);
      assert.equal(foreignKey.table, tableById.get(expectedRelation.from_table_id).en_name);
      assert.equal(foreignKey.to, expectedRelation.from_col);
      assert.equal(
        foreignKey.on_delete,
        sourceColumn.is_nullable ? 'SET NULL' : 'RESTRICT',
        `${table.en_name}.${foreignKey.from} delete policy`,
      );
    }

    const [tableMetadata] = database
      .prepare('PRAGMA table_list')
      .all()
      .filter(({ name }) => name === table.en_name);
    assert.equal(tableMetadata.strict, 1, `${table.en_name} must be STRICT`);
  }

  assert.equal(foreignKeyCount, snapshot.relations.length);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(tableById.size, 39);
});

test('compiled telecom constraints reject invalid enums, booleans, unique keys, and foreign keys', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-constraints-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  let database;
  t.after(async () => {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');

  database.prepare(`
    INSERT INTO service_plans (
      id, plan_code, plan_name, service_category, technology, contract_months,
      wifi_included, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'FTTH-300', '300M 光纖', 'BROADBAND', 'FTTH', 12, 1, 1);

  assert.throws(
    () => database.prepare(`
      INSERT INTO service_plans (
        id, plan_code, plan_name, service_category, technology, contract_months,
        wifi_included, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'BAD-ENUM', '錯誤類別', 'INVALID', 'FTTH', 12, 1, 1),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO service_plans (
        id, plan_code, plan_name, service_category, technology, contract_months,
        wifi_included, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(3, 'BAD-BOOL', '錯誤布林', 'BROADBAND', 'FTTH', 12, 7, 1),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO service_plans (
        id, plan_code, plan_name, service_category, technology, contract_months,
        wifi_included, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(4, 'FTTH-300', '重複方案', 'BROADBAND', 'FTTH', 12, 0, 1),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO plan_prices (
        id, price_period_key, service_plan_id, price_type, billing_cycle,
        amount, priority, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'missing-plan', 999, 'STANDARD', 'MONTHLY', 99900, 100, 1),
    /FOREIGN KEY constraint failed/,
  );
});

test('telecom migration refuses unsafe replacement and rejects malformed snapshots', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-safety-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  const malformedPath = join(temporaryDirectory, 'malformed.schema.json');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH });
  await assert.rejects(
    () => migrateTelecomDatabase({ databasePath, snapshotPath: SNAPSHOT_PATH }),
    (error) => error instanceof TelecomMigrationError && /backupPath/.test(error.message),
  );

  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  snapshot.tables[0].en_name = 'staff_users; DROP TABLE roles;--';
  await writeFile(malformedPath, JSON.stringify(snapshot), 'utf8');

  await assert.rejects(
    () => migrateTelecomDatabase({
      databasePath: join(temporaryDirectory, 'malformed.sqlite'),
      snapshotPath: malformedPath,
    }),
    (error) => error instanceof TelecomMigrationError && /identifier/.test(error.message),
  );
});
