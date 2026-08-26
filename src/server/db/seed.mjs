import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileTelecomSchema, scaleDecimalValue } from './schema-compiler.mjs';
import { backfillCatalogV2 } from './catalog-v2-backfill.mjs';
import { openSqliteDatabase, runInTransaction } from './sqlite.mjs';

const INTEGER_TYPES = new Set(['BIGINT', 'BOOLEAN', 'INT', 'TINYINT']);
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export class DatabaseSeedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DatabaseSeedError';
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DatabaseSeedError(`Unable to read ${label} snapshot: ${path}`, { cause: error });
  }
}

async function requireDatabase(path, label) {
  try {
    await stat(path);
  } catch (error) {
    throw new DatabaseSeedError(`${label} database must be migrated before seeding: ${path}`, {
      cause: error,
    });
  }
}

function quoteIdentifier(identifier) {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new DatabaseSeedError(`Unsafe seed identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function upsert(database, tableName, row, primaryKey = 'id') {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  if (!columns.includes(primaryKey)) {
    throw new DatabaseSeedError(`${tableName} seed row is missing primary key ${primaryKey}`);
  }

  const updateColumns = columns.filter((column) => column !== primaryKey);
  const conflictAction = updateColumns.length === 0
    ? 'DO NOTHING'
    : `DO UPDATE SET ${updateColumns
      .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
      .join(', ')}`;
  const sql = `
    INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT (${quoteIdentifier(primaryKey)}) ${conflictAction}
  `;
  database.prepare(sql).run(...columns.map((column) => row[column]));
}

function assertMigration(database, migrationName, label) {
  let migration;
  try {
    migration = database
      .prepare('SELECT name FROM _schema_migrations WHERE name = ?')
      .get(migrationName);
  } catch (error) {
    throw new DatabaseSeedError(`${label} database does not contain the migration registry`, {
      cause: error,
    });
  }
  if (!migration) throw new DatabaseSeedError(`${label} database schema is not current`);
}

function hasMigration(database, migrationName) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM _schema_migrations
    WHERE name = ?
  `).get(migrationName));
}

function preferredLabelColumn(columns, fallbackColumn) {
  const candidates = columns.filter(({ is_pk }) => !is_pk);
  const priorities = [
    (name) => name === 'display_name',
    (name) => name.endsWith('_name'),
    (name) => name === 'title',
    (name) => name.endsWith('_no'),
    (name) => name.endsWith('_code'),
    (name) => name === 'email',
  ];

  for (const predicate of priorities) {
    const match = candidates.find(({ en_name }) => predicate(en_name));
    if (match) return match;
  }
  return candidates.find(({ data_type }) => ['VARCHAR', 'CHAR', 'TEXT', 'ENUM'].includes(data_type))
    ?? fallbackColumn;
}

function seedMetadataRows(database, websiteSnapshot, telecomSnapshot) {
  const websiteSamplesByTable = Map.groupBy(websiteSnapshot.sample_data, ({ table_id }) => table_id);
  const websiteTableByName = new Map(websiteSnapshot.tables.map((table) => [table.en_name, table]));
  const portalSample = websiteSamplesByTable
    .get(websiteTableByName.get('portal_minor').id)
    .at(0).data;

  upsert(database, 'portal_minor', {
    website_id: 1,
    server_id: Number(portalSample.server_id),
    website_name: portalSample.website_name,
    website_url: portalSample.website_url,
    document_root: portalSample.document_root,
    is_active: Number(portalSample.is_active),
    sort_order: Number(portalSample.sort_order),
    index_page: portalSample.index_page,
  }, 'website_id');

  upsert(database, 'dict_systems', {
    sys_sr_id: 1,
    website_id: 1,
    en_name: 'telecom_boss_app',
    zh_name: '比奇堡電信商品官網',
    description: '以資訊系統中繼資料與電信業務資料庫支援的官方商品展示網站',
    sort_order: 1,
    site_url: '/',
    Relational_work: null,
  }, 'sys_sr_id');

  upsert(database, 'dict_databases', {
    id: 1,
    system_id: 1,
    en_name: websiteSnapshot.database.en_name,
    zh_name: websiteSnapshot.database.zh_name,
    description: websiteSnapshot.database.description,
    sort_order: websiteSnapshot.database.sort_order,
    site_prefix: 'metadata',
  });
  upsert(database, 'dict_databases', {
    id: 2,
    system_id: 1,
    en_name: telecomSnapshot.database.en_name,
    zh_name: telecomSnapshot.database.zh_name,
    description: telecomSnapshot.database.description,
    sort_order: telecomSnapshot.database.sort_order,
    site_prefix: 'operations',
  });
  database.prepare('UPDATE dict_systems SET Relational_work = ? WHERE sys_sr_id = ?').run(2, 1);

  const workTabTable = websiteTableByName.get('work_tab_design');
  for (const sample of websiteSamplesByTable.get(workTabTable.id) ?? []) {
    upsert(database, 'work_tab_design', {
      tab_id: Number(sample.data.tab_id),
      tab_name: sample.data.tab_name,
      tab_module: sample.data.tab_module,
      sort_order: Number(sample.data.sort_order),
    }, 'tab_id');
  }

  for (const group of telecomSnapshot.groups) {
    upsert(database, 'dict_table_groups', {
      id: group.id,
      db_id: 2,
      en_name: group.en_name,
      zh_name: group.zh_name,
      description: group.description,
      sort_order: group.sort_order,
    });
  }

  for (const table of telecomSnapshot.tables) {
    upsert(database, 'dict_tables', {
      id: table.id,
      db_id: 2,
      en_name: table.en_name,
      zh_name: table.zh_name,
      table_type: table.table_type,
      description: table.description,
      sort_order: table.sort_order,
      group_id: table.group_id || null,
      subgroup_id: table.subgroup_id || null,
      tab_module: '數據管理面板',
    });
  }

  for (const column of telecomSnapshot.columns) {
    upsert(database, 'dict_columns', {
      id: column.id,
      table_id: column.table_id,
      en_name: column.en_name,
      zh_name: column.zh_name,
      alias_name: column.alias_name,
      data_type: column.data_type,
      data_length: column.data_length,
      is_pk: column.is_pk,
      is_index: column.is_index,
      is_unique: column.is_unique,
      is_fk: column.is_fk,
      is_nullable: column.is_nullable,
      default_val: column.default_val,
      sort_order: column.sort_order,
      notes: column.notes,
    });
  }

  for (const relation of telecomSnapshot.relations) {
    upsert(database, 'dict_relations', {
      id: relation.id,
      db_id: 2,
      from_table_id: relation.from_table_id,
      from_col: relation.from_col,
      to_table_id: relation.to_table_id,
      to_col: relation.to_col,
      cardinality: relation.cardinality,
      label: relation.label,
    });
  }

  const tableById = new Map(telecomSnapshot.tables.map((table) => [table.id, table]));
  const columnsByTable = Map.groupBy(telecomSnapshot.columns, ({ table_id }) => table_id);
  const columnByTableAndName = new Map(
    telecomSnapshot.columns.map((column) => [`${column.table_id}.${column.en_name}`, column]),
  );
  for (const relation of telecomSnapshot.relations) {
    const parentTable = tableById.get(relation.from_table_id);
    const childColumn = columnByTableAndName.get(`${relation.to_table_id}.${relation.to_col}`);
    const valueColumn = columnByTableAndName.get(`${relation.from_table_id}.${relation.from_col}`);
    const labelColumn = preferredLabelColumn(
      columnsByTable.get(relation.from_table_id),
      valueColumn,
    );
    upsert(database, 'dict_fk_selects', {
      id: relation.id,
      table_id: relation.to_table_id,
      column_id: childColumn.id,
      source: 'telecom_boss',
      value_id: valueColumn.id,
      label_id: labelColumn.id,
      label2_id: null,
      derive_json: JSON.stringify({ database: 'telecom_boss', table: parentTable.en_name }),
      depends_col_id: null,
      is_active: 1,
      sort_order: 0,
      notes: relation.label,
    });
  }
}

function metadataReport(database) {
  return {
    moduleCount: database
      .prepare('SELECT COUNT(*) AS count FROM dict_table_groups WHERE db_id = 2')
      .get().count,
    tableCount: database
      .prepare('SELECT COUNT(*) AS count FROM dict_tables WHERE db_id = 2')
      .get().count,
    columnCount: database.prepare(`
      SELECT COUNT(*) AS count
      FROM dict_columns AS columns
      JOIN dict_tables AS tables ON tables.id = columns.table_id
      WHERE tables.db_id = 2
    `).get().count,
    relationCount: database
      .prepare('SELECT COUNT(*) AS count FROM dict_relations WHERE db_id = 2')
      .get().count,
    foreignKeySelectCount: database.prepare(`
      SELECT COUNT(*) AS count
      FROM dict_fk_selects AS selects
      JOIN dict_tables AS tables ON tables.id = selects.table_id
      WHERE tables.db_id = 2
    `).get().count,
  };
}

export async function seedMetadataDatabase({
  databasePath,
  websiteSnapshotPath,
  telecomSnapshotPath,
}) {
  const resolvedDatabasePath = resolve(databasePath);
  await requireDatabase(resolvedDatabasePath, 'Metadata');
  const [websiteSnapshot, telecomSnapshot] = await Promise.all([
    readJson(resolve(websiteSnapshotPath), 'website_db'),
    readJson(resolve(telecomSnapshotPath), 'telecom_boss'),
  ]);

  if (websiteSnapshot.format !== 'yk-schema-db' || websiteSnapshot.database?.en_name !== 'website_db') {
    throw new DatabaseSeedError('Metadata seed requires a website_db yk-schema-db snapshot');
  }
  try {
    compileTelecomSchema(telecomSnapshot);
  } catch (error) {
    throw new DatabaseSeedError(`Invalid telecom metadata snapshot: ${error.message}`, { cause: error });
  }

  const database = openSqliteDatabase(resolvedDatabasePath);
  try {
    assertMigration(database, 'create_metadata_schema', 'Metadata');
    runInTransaction(database, () => seedMetadataRows(database, websiteSnapshot, telecomSnapshot));
    return metadataReport(database);
  } catch (error) {
    if (error instanceof DatabaseSeedError) throw error;
    throw new DatabaseSeedError(`Metadata seed failed: ${error.message}`, { cause: error });
  } finally {
    database.close();
  }
}

function topologicallySortedSampleTables(snapshot) {
  const sampleTableIds = new Set(snapshot.sample_data.map(({ table_id }) => table_id));
  const children = new Map([...sampleTableIds].map((id) => [id, new Set()]));
  const indegree = new Map([...sampleTableIds].map((id) => [id, 0]));

  for (const relation of snapshot.relations) {
    if (!sampleTableIds.has(relation.from_table_id) || !sampleTableIds.has(relation.to_table_id)) continue;
    if (children.get(relation.from_table_id).has(relation.to_table_id)) continue;
    children.get(relation.from_table_id).add(relation.to_table_id);
    indegree.set(relation.to_table_id, indegree.get(relation.to_table_id) + 1);
  }

  const sourceOrder = new Map(snapshot.tables.map(({ id }, index) => [id, index]));
  const queue = [...sampleTableIds]
    .filter((id) => indegree.get(id) === 0)
    .sort((left, right) => sourceOrder.get(left) - sourceOrder.get(right));
  const result = [];
  while (queue.length > 0) {
    const tableId = queue.shift();
    result.push(tableId);
    for (const childId of children.get(tableId)) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) {
        queue.push(childId);
        queue.sort((left, right) => sourceOrder.get(left) - sourceOrder.get(right));
      }
    }
  }

  if (result.length !== sampleTableIds.size) {
    throw new DatabaseSeedError('Sample rows contain a cyclic table dependency');
  }
  return result;
}

function convertSampleValue(value, column, decimalScaleByColumn, tableName) {
  if (value === null) return null;
  const context = `${tableName}.${column.en_name}`;
  if (column.data_type === 'DECIMAL') {
    const scaled = BigInt(scaleDecimalValue(value, decimalScaleByColumn[context], context));
    return scaled <= BigInt(Number.MAX_SAFE_INTEGER) && scaled >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(scaled)
      : scaled;
  }
  if (INTEGER_TYPES.has(column.data_type)) {
    if (!/^-?\d+$/.test(String(value))) {
      throw new DatabaseSeedError(`Invalid integer seed value for ${context}: ${value}`);
    }
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : BigInt(value);
  }
  return String(value);
}

function seedTelecomRows(database, snapshot, decimalScaleByColumn) {
  const tableById = new Map(snapshot.tables.map((table) => [table.id, table]));
  const columnsByTable = Map.groupBy(snapshot.columns, ({ table_id }) => table_id);
  const samplesByTable = Map.groupBy(snapshot.sample_data, ({ table_id }) => table_id);

  for (const tableId of topologicallySortedSampleTables(snapshot)) {
    const table = tableById.get(tableId);
    const columnByName = new Map(columnsByTable.get(tableId).map((column) => [column.en_name, column]));
    const samples = [...samplesByTable.get(tableId)].sort((left, right) => left.row_index - right.row_index);
    for (const sample of samples) {
      const row = {};
      for (const [columnName, value] of Object.entries(sample.data)) {
        const column = columnByName.get(columnName);
        if (!column) throw new DatabaseSeedError(`Unknown seed column: ${table.en_name}.${columnName}`);
        row[columnName] = convertSampleValue(value, column, decimalScaleByColumn, table.en_name);
      }
      upsert(database, table.en_name, row);
    }
  }
}

function seedDevelopmentAccessRows(database) {
  upsert(database, 'permissions', {
    id: 10,
    permission_code: 'customer.sensitive.read',
    permission_name: '檢視客戶敏感聯絡資料',
    module_name: 'customer_sales',
    description: '檢視完整客戶聯絡方式；每次存取皆需留下專屬稽核事件。',
  });
  upsert(database, 'permissions', {
    id: 11,
    permission_code: 'role.manage',
    permission_name: '管理角色指派',
    module_name: 'access_control',
    description: '指派或移除後台人員角色。',
  });
  upsert(database, 'permissions', {
    id: 12,
    permission_code: 'audit.read',
    permission_name: '檢視稽核紀錄',
    module_name: 'access_control',
    description: '以唯讀方式查詢遮罩後的稽核紀錄。',
  });
  upsert(database, 'roles', {
    id: 5,
    role_code: 'AUDITOR',
    role_name: '稽核人員',
    description: '唯讀檢視安全稽核紀錄。',
    is_active: 1,
  });

  const staffUsers = [
    {
      id: 1,
      staff_no: 'DEV-ADMIN',
      email: 'admin@example.test',
      display_name: '開發系統管理員',
      auth_provider: 'OTHER',
      provider_subject: 'dev:admin',
      department: '資訊部',
      is_active: 1,
    },
    {
      id: 2,
      staff_no: 'DEV-CS',
      email: 'customer-service@example.test',
      display_name: '開發客服人員',
      auth_provider: 'OTHER',
      provider_subject: 'dev:customer-service',
      department: '客服部',
      is_active: 1,
    },
    {
      id: 3,
      staff_no: 'DEV-TECH',
      email: 'technician@example.test',
      display_name: '開發技術人員',
      auth_provider: 'OTHER',
      provider_subject: 'dev:technician',
      department: '技術部',
      is_active: 1,
    },
    {
      id: 4,
      staff_no: 'DEV-BILL',
      email: 'billing@example.test',
      display_name: '開發帳務人員',
      auth_provider: 'OTHER',
      provider_subject: 'dev:billing',
      department: '帳務部',
      is_active: 1,
    },
    {
      id: 5,
      staff_no: 'DEV-AUDIT',
      email: 'auditor@example.test',
      display_name: '開發稽核人員',
      auth_provider: 'OTHER',
      provider_subject: 'dev:auditor',
      department: '內部稽核',
      is_active: 1,
    },
  ];
  for (const staffUser of staffUsers) upsert(database, 'staff_users', staffUser);

  for (const [index, staffUser] of staffUsers.entries()) {
    const roleId = index + 1;
    upsert(database, 'user_roles', {
      id: roleId,
      assignment_key: `${staffUser.id}:${roleId}`,
      staff_user_id: staffUser.id,
      role_id: roleId,
      granted_by: 1,
    });
  }

  const permissionsByRole = new Map([
    [1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    [2, [1, 2, 4]],
    [3, [1, 5]],
    [4, [1, 6]],
    [5, [12]],
  ]);
  let grantId = 1;
  for (const [roleId, permissionIds] of permissionsByRole) {
    for (const permissionId of permissionIds) {
      upsert(database, 'role_permissions', {
        id: grantId,
        grant_key: `${roleId}:${permissionId}`,
        role_id: roleId,
        permission_id: permissionId,
      });
      grantId += 1;
    }
  }
}

export async function seedTelecomDatabase({ databasePath, snapshotPath }) {
  const resolvedDatabasePath = resolve(databasePath);
  await requireDatabase(resolvedDatabasePath, 'Telecom');
  const snapshot = await readJson(resolve(snapshotPath), 'telecom_boss');
  let compilation;
  try {
    compilation = compileTelecomSchema(snapshot);
  } catch (error) {
    throw new DatabaseSeedError(`Invalid telecom seed snapshot: ${error.message}`, { cause: error });
  }

  const database = openSqliteDatabase(resolvedDatabasePath);
  try {
    assertMigration(database, 'create_telecom_schema', 'Telecom');
    let catalogBackfill = null;
    runInTransaction(database, () => {
      seedTelecomRows(database, snapshot, compilation.decimalScaleByColumn);
      seedDevelopmentAccessRows(database);
      if (hasMigration(database, 'create_catalog_v2_schema')) {
        catalogBackfill = backfillCatalogV2(database);
      }
    });

    const sampleTables = new Set(snapshot.sample_data.map(({ table_id }) => table_id));
    const tableById = new Map(snapshot.tables.map((table) => [table.id, table]));
    const sampleRowCount = [...sampleTables].reduce((total, tableId) => {
      const tableName = tableById.get(tableId).en_name;
      return total + database
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`)
        .get().count;
    }, 0);
    return {
      sampleRowCount,
      servicePlanCount: database.prepare('SELECT COUNT(*) AS count FROM service_plans').get().count,
      ...(catalogBackfill ? { catalogBackfill } : {}),
    };
  } catch (error) {
    if (error instanceof DatabaseSeedError) throw error;
    throw new DatabaseSeedError(`Telecom seed failed: ${error.message}`, { cause: error });
  } finally {
    database.close();
  }
}
