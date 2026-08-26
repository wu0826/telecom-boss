import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  openSqliteDatabase,
  prepareDatabaseTarget,
  runInTransaction,
} from './sqlite.mjs';

const EXPECTED_REFERENCE_COUNTS = {
  tables: 12,
  columns: 106,
};

const METADATA_SCHEMA_SQL = `
  CREATE TABLE _schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  CREATE TABLE portal_minor (
    website_id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    website_name TEXT NOT NULL UNIQUE CHECK (length(trim(website_name)) BETWEEN 1 AND 50),
    website_url TEXT CHECK (website_url IS NULL OR length(website_url) <= 200),
    document_root TEXT CHECK (document_root IS NULL OR length(document_root) <= 200),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    index_page TEXT
  ) STRICT;

  CREATE INDEX idx_portal_minor_server ON portal_minor(server_id);
  CREATE INDEX idx_portal_minor_active_sort ON portal_minor(is_active, sort_order);

  CREATE TABLE website_path (
    website_id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    website_name TEXT NOT NULL UNIQUE CHECK (length(trim(website_name)) BETWEEN 1 AND 50),
    website_url TEXT CHECK (website_url IS NULL OR length(website_url) <= 200),
    document_root TEXT CHECK (document_root IS NULL OR length(document_root) <= 200),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    index_page TEXT
  ) STRICT;

  CREATE INDEX idx_website_path_server ON website_path(server_id);
  CREATE INDEX idx_website_path_active_sort ON website_path(is_active, sort_order);

  CREATE TABLE dict_systems (
    sys_sr_id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER,
    en_name TEXT,
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    site_url TEXT CHECK (site_url IS NULL OR length(site_url) <= 255),
    Relational_work INTEGER,
    CONSTRAINT uq_dict_systems_parent_name UNIQUE (website_id, en_name),
    CONSTRAINT fk_dict_systems_website FOREIGN KEY (website_id)
      REFERENCES portal_minor(website_id) ON DELETE SET NULL,
    CONSTRAINT fk_dict_systems_database FOREIGN KEY (Relational_work)
      REFERENCES dict_databases(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE INDEX idx_dict_systems_website ON dict_systems(website_id);
  CREATE INDEX idx_dict_systems_database ON dict_systems(Relational_work);
  CREATE INDEX idx_dict_systems_sort ON dict_systems(sort_order);

  CREATE TABLE dict_databases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id INTEGER,
    en_name TEXT NOT NULL CHECK (length(trim(en_name)) > 0),
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    site_prefix TEXT,
    CONSTRAINT uq_dict_databases_parent_name UNIQUE (system_id, en_name),
    CONSTRAINT fk_dict_databases_system FOREIGN KEY (system_id)
      REFERENCES dict_systems(sys_sr_id) ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX idx_dict_databases_system ON dict_databases(system_id);
  CREATE INDEX idx_dict_databases_sort ON dict_databases(sort_order);

  CREATE TABLE dict_table_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db_id INTEGER,
    en_name TEXT NOT NULL CHECK (length(trim(en_name)) > 0),
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_dict_table_groups_parent_name UNIQUE (db_id, en_name),
    CONSTRAINT fk_dict_table_groups_database FOREIGN KEY (db_id)
      REFERENCES dict_databases(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_dict_table_groups_database ON dict_table_groups(db_id);
  CREATE INDEX idx_dict_table_groups_sort ON dict_table_groups(db_id, sort_order);

  CREATE TABLE dict_table_subgroups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    en_name TEXT NOT NULL CHECK (length(trim(en_name)) > 0),
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_dict_table_subgroups_parent_name UNIQUE (group_id, en_name),
    CONSTRAINT fk_dict_table_subgroups_group FOREIGN KEY (group_id)
      REFERENCES dict_table_groups(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_dict_table_subgroups_group ON dict_table_subgroups(group_id);
  CREATE INDEX idx_dict_table_subgroups_sort ON dict_table_subgroups(group_id, sort_order);

  CREATE TABLE dict_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db_id INTEGER,
    en_name TEXT NOT NULL CHECK (en_name GLOB '[A-Za-z]*'),
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    table_type TEXT NOT NULL DEFAULT 'table' CHECK (table_type IN ('table', 'log', 'view')),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    group_id INTEGER,
    subgroup_id INTEGER,
    tab_module TEXT,
    CONSTRAINT uq_dict_tables_database_name UNIQUE (db_id, en_name),
    CONSTRAINT fk_dict_tables_database FOREIGN KEY (db_id)
      REFERENCES dict_databases(id) ON DELETE CASCADE,
    CONSTRAINT fk_dict_tables_group FOREIGN KEY (group_id)
      REFERENCES dict_table_groups(id) ON DELETE SET NULL,
    CONSTRAINT fk_dict_tables_subgroup FOREIGN KEY (subgroup_id)
      REFERENCES dict_table_subgroups(id) ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX idx_dict_tables_database ON dict_tables(db_id);
  CREATE INDEX idx_dict_tables_group ON dict_tables(group_id);
  CREATE INDEX idx_dict_tables_subgroup ON dict_tables(subgroup_id);
  CREATE INDEX idx_dict_tables_sort ON dict_tables(db_id, group_id, sort_order);

  CREATE TABLE dict_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER,
    en_name TEXT NOT NULL CHECK (en_name GLOB '[A-Za-z]*'),
    zh_name TEXT NOT NULL CHECK (length(trim(zh_name)) > 0),
    alias_name TEXT,
    data_type TEXT NOT NULL,
    data_length TEXT,
    is_pk INTEGER NOT NULL DEFAULT 0 CHECK (is_pk IN (0, 1)),
    is_index INTEGER NOT NULL DEFAULT 0 CHECK (is_index IN (0, 1)),
    is_unique INTEGER NOT NULL DEFAULT 0 CHECK (is_unique IN (0, 1)),
    is_fk INTEGER NOT NULL DEFAULT 0 CHECK (is_fk IN (0, 1)),
    is_nullable INTEGER NOT NULL DEFAULT 1 CHECK (is_nullable IN (0, 1)),
    default_val TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    CONSTRAINT uq_dict_columns_table_name UNIQUE (table_id, en_name),
    CONSTRAINT fk_dict_columns_table FOREIGN KEY (table_id)
      REFERENCES dict_tables(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_dict_columns_table ON dict_columns(table_id);
  CREATE INDEX idx_dict_columns_sort ON dict_columns(table_id, sort_order);

  CREATE TABLE dict_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db_id INTEGER NOT NULL,
    from_table_id INTEGER NOT NULL,
    from_col TEXT NOT NULL,
    to_table_id INTEGER NOT NULL,
    to_col TEXT NOT NULL,
    cardinality TEXT,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_dict_relations_edge UNIQUE (
      db_id, from_table_id, from_col, to_table_id, to_col
    ),
    CONSTRAINT fk_dict_relations_database FOREIGN KEY (db_id)
      REFERENCES dict_databases(id) ON DELETE CASCADE,
    CONSTRAINT fk_dict_relations_from_table FOREIGN KEY (from_table_id)
      REFERENCES dict_tables(id) ON DELETE CASCADE,
    CONSTRAINT fk_dict_relations_to_table FOREIGN KEY (to_table_id)
      REFERENCES dict_tables(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_dict_relations_database ON dict_relations(db_id);
  CREATE INDEX idx_dict_relations_from_table ON dict_relations(from_table_id);
  CREATE INDEX idx_dict_relations_to_table ON dict_relations(to_table_id);

  CREATE TABLE dict_fk_selects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER NOT NULL,
    column_id INTEGER NOT NULL,
    source TEXT,
    value_id INTEGER,
    label_id INTEGER,
    label2_id INTEGER,
    derive_json TEXT CHECK (derive_json IS NULL OR json_valid(derive_json)),
    depends_col_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_dict_fk_selects_target UNIQUE (table_id, column_id),
    CONSTRAINT fk_dict_fk_selects_table FOREIGN KEY (table_id)
      REFERENCES dict_tables(id) ON DELETE CASCADE,
    CONSTRAINT fk_dict_fk_selects_column FOREIGN KEY (column_id)
      REFERENCES dict_columns(id) ON DELETE CASCADE,
    CONSTRAINT fk_dict_fk_selects_value FOREIGN KEY (value_id)
      REFERENCES dict_columns(id) ON DELETE SET NULL,
    CONSTRAINT fk_dict_fk_selects_label FOREIGN KEY (label_id)
      REFERENCES dict_columns(id) ON DELETE SET NULL,
    CONSTRAINT fk_dict_fk_selects_label2 FOREIGN KEY (label2_id)
      REFERENCES dict_columns(id) ON DELETE SET NULL,
    CONSTRAINT fk_dict_fk_selects_depends FOREIGN KEY (depends_col_id)
      REFERENCES dict_columns(id) ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX idx_dict_fk_selects_table ON dict_fk_selects(table_id);
  CREATE INDEX idx_dict_fk_selects_column ON dict_fk_selects(column_id);
  CREATE INDEX idx_dict_fk_selects_value ON dict_fk_selects(value_id);
  CREATE INDEX idx_dict_fk_selects_label ON dict_fk_selects(label_id);
  CREATE INDEX idx_dict_fk_selects_label2 ON dict_fk_selects(label2_id);
  CREATE INDEX idx_dict_fk_selects_depends ON dict_fk_selects(depends_col_id);

  CREATE TABLE work_tab_design (
    tab_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_name TEXT NOT NULL UNIQUE CHECK (length(trim(tab_name)) BETWEEN 1 AND 100),
    tab_module TEXT NOT NULL UNIQUE CHECK (
      tab_module IN (
        '欄位設計面板',
        '關聯圖面板',
        '表格屬性面板',
        '互動式關聯圖面板',
        '數據管理面板'
      )
    ),
    sort_order INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE INDEX idx_work_tab_design_sort ON work_tab_design(sort_order);

  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    SKU TEXT NOT NULL UNIQUE CHECK (length(trim(SKU)) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255),
    description TEXT,
    price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  CREATE INDEX idx_products_name ON products(name);
  CREATE INDEX idx_products_active ON products(is_active);
`;

export class MetadataMigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MetadataMigrationError';
  }
}

async function validateSnapshot(snapshotPath) {
  let snapshot;

  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch (error) {
    throw new MetadataMigrationError(`Unable to read metadata snapshot: ${snapshotPath}`, {
      cause: error,
    });
  }

  if (snapshot.format !== 'yk-schema-db' || snapshot.database?.en_name !== 'website_db') {
    throw new MetadataMigrationError('Metadata snapshot must be a website_db yk-schema-db document');
  }

  if (
    snapshot.tables?.length !== EXPECTED_REFERENCE_COUNTS.tables
    || snapshot.columns?.length !== EXPECTED_REFERENCE_COUNTS.columns
  ) {
    throw new MetadataMigrationError(
      `Metadata snapshot counts must be ${EXPECTED_REFERENCE_COUNTS.tables} tables and ${EXPECTED_REFERENCE_COUNTS.columns} columns`,
    );
  }

  return snapshot;
}

export async function migrateMetadataDatabase({ databasePath, snapshotPath, backupPath = null }) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedSnapshotPath = resolve(snapshotPath);
  const resolvedBackupPath = backupPath ? resolve(backupPath) : null;
  const snapshot = await validateSnapshot(resolvedSnapshotPath);

  if (!resolvedDatabasePath.endsWith('.sqlite')) {
    throw new MetadataMigrationError('databasePath must end with .sqlite');
  }

  let createdBackup;
  try {
    createdBackup = await prepareDatabaseTarget({
      databasePath: resolvedDatabasePath,
      backupPath: resolvedBackupPath,
      databaseLabel: 'metadata',
    });
  } catch (error) {
    throw new MetadataMigrationError(error.message, { cause: error });
  }
  await mkdir(dirname(resolvedDatabasePath), { recursive: true });

  let database;
  try {
    database = openSqliteDatabase(resolvedDatabasePath);
    database.exec('PRAGMA journal_mode = WAL');
    runInTransaction(database, () => {
      database.exec(METADATA_SCHEMA_SQL);
      database.prepare(`
        INSERT INTO _schema_migrations (version, name)
        VALUES (?, ?)
      `).run(1, 'create_metadata_schema');
    });
  } catch (error) {
    throw new MetadataMigrationError('Metadata database migration failed', { cause: error });
  } finally {
    database?.close();
  }

  return {
    databaseName: snapshot.database.en_name,
    databasePath: resolvedDatabasePath,
    backupPath: createdBackup,
    referenceTableCount: snapshot.tables.length,
    referenceColumnCount: snapshot.columns.length,
  };
}
