import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DATABASE_PATH = resolve('database/data/catalog_admin.sqlite');
const DEFAULT_OUTPUT_PATH = resolve('database/exports/telecom_catalog_admin.schema.json');

const EXPORT_TARGETS = Object.freeze({
  telecom_catalog_admin: Object.freeze({
    database: Object.freeze({
      en_name: 'telecom_catalog_admin',
      zh_name: '電信商品上架管理資料庫',
      description: '參考 CSMU 專案資料庫導覽架構，供前端網頁管理商品分類、內容、圖片、規格、品牌與發布狀態；不含任何業務資料。',
      sort_order: 5,
    }),
    crosswalk: null,
  }),
  yankees_service_cms: Object.freeze({
    database: Object.freeze({
      en_name: 'yankees_service_cms',
      zh_name: '洋基服務商品 CMS（Catalog V2 匯出）',
      description: '僅供本機產生與審核的 Catalog V2 CSMU 相容 schema 產物；不含業務資料、不會寫入遠端。匯入前必須取得新鮮 CSMU 匯出、完成語意差異比對、建立備份並取得明確核准。',
      sort_order: 5,
    }),
    crosswalk: Object.freeze({
      catalog_categories: 'project_db.project_cate_nav1 → project_large_nav2 → project_medium_nav3 → project_small_nav4；將四張固定導覽表正規化為單一自關聯分類樹。',
      catalog_products: 'project_db.project_master；yankees_service_cms.product_master；以穩定商品代碼與 slug 統一主檔，並保留發布生命週期。',
      catalog_product_categories: '正規化新增的商品－分類多對多關聯；取代固定層級欄位與重複導覽對應。',
      catalog_product_content: 'project_db.project_content；yankees_service_cms.product_description；以語系唯一的內容與 SEO 欄位取代單一長文欄位。',
      catalog_product_sections: 'yankees_service_cms.product_overview；以可排序、具類型的純文字區塊呈現商品介紹。',
      catalog_product_media: 'yankees_service_cms.product_pic；加入用途、替代文字、主圖唯一性與安全網址限制。',
      catalog_product_specs: 'yankees_service_cms.product_spec；以商品、語系與規格代碼的結構化唯一列保存。',
      catalog_brands: 'yankees_service_cms.product_brand；抽成可重複使用的品牌主檔。',
      catalog_product_brands: 'yankees_service_cms.product_brand_map；保留多對多關聯與單一主要品牌。',
      catalog_promotion_products: '正規化新增的促銷－商品關聯；沿用 telecom_boss.promotions 的營運真實來源。',
    }),
  }),
});

const TABLE_DEFINITIONS = Object.freeze([
  {
    enName: 'catalog_categories',
    zhName: '商品分類',
    groupId: 1,
    description: '前端商品導覽的單一分類樹；最多四層，禁止循環。',
    invariants: 'category_code、slug 唯一；parent_id 與 sort_order 支援樹狀排序。',
  },
  {
    enName: 'catalog_products',
    zhName: '上架商品主檔',
    groupId: 1,
    description: '前端商品與服務的發布主檔，保存草稿、排程、上架與封存狀態。',
    invariants: 'product_code、slug 唯一；來源只能是方案、庫存品項或一般商品三者之一。',
  },
  {
    enName: 'catalog_product_categories',
    zhName: '商品分類關聯',
    groupId: 1,
    description: '商品與分類的多對多關聯，並指定一個主要分類。',
    invariants: 'product_id + category_id 唯一；每個商品最多一個主要分類。',
  },
  {
    enName: 'catalog_product_content',
    zhName: '商品內容與 SEO',
    groupId: 2,
    description: '依語系保存商品標題、摘要、內文與搜尋引擎欄位。',
    invariants: 'product_id + locale 唯一。',
  },
  {
    enName: 'catalog_product_sections',
    zhName: '商品內容區塊',
    groupId: 2,
    description: '依順序組合商品介紹、特色與注意事項區塊。',
    invariants: 'product_id + locale + section_key 唯一。',
  },
  {
    enName: 'catalog_product_media',
    zhName: '商品媒體',
    groupId: 2,
    description: '保存商品主圖、圖庫、圖示與橫幅的網址、替代文字與排序。',
    invariants: '每個商品最多一張主圖；網址只允許站內絕對路徑或 HTTPS。',
  },
  {
    enName: 'catalog_product_specs',
    zhName: '商品規格',
    groupId: 2,
    description: '依語系與規格群組保存結構化商品規格。',
    invariants: 'product_id + spec_key + locale 唯一。',
  },
  {
    enName: 'catalog_brands',
    zhName: '品牌主檔',
    groupId: 3,
    description: '前端可重複使用的品牌名稱、說明、網站與標誌。',
    invariants: 'brand_code、slug 唯一。',
  },
  {
    enName: 'catalog_product_brands',
    zhName: '商品品牌關聯',
    groupId: 3,
    description: '商品與品牌的多對多關聯，並指定主要品牌。',
    invariants: 'product_id + brand_id 唯一；每個商品最多一個主要品牌。',
  },
  {
    enName: 'catalog_promotion_products',
    zhName: '活動適用商品',
    groupId: 3,
    description: '促銷活動與前端上架商品的關聯。',
    invariants: 'promotion_id + product_id 唯一。',
  },
]);

const GROUPS = Object.freeze([
  {
    id: 1,
    en_name: 'catalog_core',
    zh_name: '商品目錄',
    description: '商品分類、上架主檔與分類關聯。',
    sort_order: 1,
  },
  {
    id: 2,
    en_name: 'content_publishing',
    zh_name: '內容發布',
    description: '商品內容、區塊、圖片與規格。',
    sort_order: 2,
  },
  {
    id: 3,
    en_name: 'brand_marketing',
    zh_name: '品牌與行銷',
    description: '品牌資料與促銷商品關聯。',
    sort_order: 3,
  },
]);

const EXTERNAL_REFERENCES = Object.freeze({
  'catalog_products.service_plan_id': 'telecom_boss.service_plans.id',
  'catalog_products.stock_item_id': 'telecom_boss.stock_items.id',
  'catalog_products.created_by_staff_user_id': 'telecom_boss.staff_users.id',
  'catalog_products.updated_by_staff_user_id': 'telecom_boss.staff_users.id',
  'catalog_categories.created_by_staff_user_id': 'telecom_boss.staff_users.id',
  'catalog_categories.updated_by_staff_user_id': 'telecom_boss.staff_users.id',
  'catalog_promotion_products.promotion_id': 'telecom_boss.promotions.id',
});

const BOOLEAN_FIELDS = new Set([
  'is_active',
  'is_featured',
  'is_primary',
]);

const DATETIME_FIELDS = new Set([
  'created_at',
  'updated_at',
  'publish_from',
  'publish_until',
]);

const LENGTH_BY_FIELD = Object.freeze({
  category_code: 50,
  slug: 120,
  category_name: 120,
  product_code: 50,
  product_name: 200,
  product_type: 30,
  status: 30,
  locale: 10,
  title: 200,
  summary: 500,
  seo_title: 70,
  seo_description: 160,
  section_key: 80,
  section_type: 30,
  media_type: 30,
  media_usage: 30,
  url: 500,
  alt_text: 250,
  spec_key: 80,
  group_key: 80,
  group_label: 120,
  spec_label: 120,
  spec_value: 500,
  unit: 30,
  brand_code: 50,
  brand_name: 120,
  website_url: 500,
  logo_url: 500,
});

const ZH_NAME_BY_FIELD = Object.freeze({
  id: '自動序號',
  parent_id: '上層分類序號',
  category_code: '分類代碼',
  slug: '網址識別碼',
  category_name: '分類名稱',
  description: '說明',
  sort_order: '排序',
  is_active: '是否啟用',
  created_by_staff_user_id: '建立人員序號',
  updated_by_staff_user_id: '更新人員序號',
  created_at: '建立時間',
  updated_at: '更新時間',
  row_version: '資料版本',
  product_code: '商品代碼',
  product_name: '商品名稱',
  product_type: '商品類型',
  service_plan_id: '服務方案來源序號',
  stock_item_id: '庫存品項來源序號',
  status: '發布狀態',
  is_featured: '是否精選',
  publish_from: '開始上架時間',
  publish_until: '結束上架時間',
  product_id: '商品序號',
  category_id: '分類序號',
  is_primary: '是否主要',
  locale: '語系',
  title: '標題',
  summary: '摘要',
  body_text: '內文',
  seo_title: 'SEO 標題',
  seo_description: 'SEO 說明',
  section_key: '區塊代碼',
  section_type: '區塊類型',
  media_type: '媒體類型',
  media_usage: '媒體用途',
  url: '媒體網址',
  alt_text: '替代文字',
  spec_key: '規格代碼',
  group_key: '規格群組代碼',
  group_label: '規格群組名稱',
  spec_label: '規格名稱',
  spec_value: '規格值',
  unit: '單位',
  brand_code: '品牌代碼',
  brand_name: '品牌名稱',
  website_url: '品牌網站',
  logo_url: '品牌標誌網址',
  brand_id: '品牌序號',
  promotion_id: '促銷活動序號',
});

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  if (/strftime\(/i.test(value)) return 'CURRENT_TIMESTAMP';
  return String(value).replace(/^'(.*)'$/, '$1');
}

function inferColumnType(column) {
  if (DATETIME_FIELDS.has(column.name)) {
    return { dataType: 'DATETIME', dataLength: null };
  }
  if (BOOLEAN_FIELDS.has(column.name)) {
    return { dataType: 'BOOLEAN', dataLength: null };
  }
  if (column.type === 'INTEGER') {
    return {
      dataType: column.name === 'sort_order' || column.name === 'row_version' ? 'INT' : 'BIGINT',
      dataLength: null,
    };
  }
  if (column.name === 'body_text') {
    return { dataType: 'LONGTEXT', dataLength: null };
  }
  if (column.name === 'description') {
    return { dataType: 'TEXT', dataLength: null };
  }
  return {
    dataType: 'VARCHAR',
    dataLength: LENGTH_BY_FIELD[column.name] ?? 255,
  };
}

function collectIndexedColumns(database, tableName) {
  const indexed = new Set();
  const uniqueSingles = new Set();
  for (const index of database.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all()) {
    const columns = database
      .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
      .all()
      .map(({ name }) => name)
      .filter(Boolean);
    for (const columnName of columns) indexed.add(columnName);
    if (
      Number(index.unique) === 1
      && Number(index.partial) === 0
      && columns.length === 1
    ) {
      uniqueSingles.add(columns[0]);
    }
  }
  return { indexed, uniqueSingles };
}

function collectForeignKeys(database, tableName) {
  return database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`).all()
    .map((foreignKey) => ({
      sourceColumn: foreignKey.from,
      targetTable: foreignKey.table,
      targetColumn: foreignKey.to,
    }));
}

function exportTarget(targetName) {
  const target = EXPORT_TARGETS[targetName];
  if (!target) {
    throw new Error(`Unsupported export target: ${targetName}`);
  }
  return target;
}

function buildSchema(database, targetName = 'telecom_catalog_admin') {
  const target = exportTarget(targetName);
  const selectedTableNames = new Set(TABLE_DEFINITIONS.map(({ enName }) => enName));
  const existingTableNames = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(({ name }) => name),
  );
  for (const tableName of selectedTableNames) {
    if (!existingTableNames.has(tableName)) {
      throw new Error(`Missing Catalog V2 table: ${tableName}`);
    }
    const rowCount = Number(
      database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get().count,
    );
    if (rowCount !== 0) {
      throw new Error(`Refusing to export data: ${tableName} contains ${rowCount} row(s)`);
    }
  }

  const tableIdByName = new Map();
  const tables = TABLE_DEFINITIONS.map((definition, index) => {
    const id = 50_001 + index;
    tableIdByName.set(definition.enName, id);
    return {
      id,
      group_id: definition.groupId,
      subgroup_id: 0,
      en_name: definition.enName,
      zh_name: definition.zhName,
      table_type: 'table',
      description: target.crosswalk
        ? `${definition.description} ${definition.invariants} CSMU 對照：${target.crosswalk[definition.enName]}`
        : `${definition.description} ${definition.invariants}`,
      sort_order: index + 1,
    };
  });

  let nextColumnId = 60_001;
  const columns = [];
  const relations = [];
  let nextRelationId = 70_001;

  for (const definition of TABLE_DEFINITIONS) {
    const tableName = definition.enName;
    const tableId = tableIdByName.get(tableName);
    const tableColumns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
    const primaryKeyColumns = tableColumns.filter((column) => Number(column.pk) > 0);
    const foreignKeys = collectForeignKeys(database, tableName);
    const foreignKeyByColumn = new Map(
      foreignKeys.map((foreignKey) => [foreignKey.sourceColumn, foreignKey]),
    );
    const { indexed, uniqueSingles } = collectIndexedColumns(database, tableName);

    for (const [index, column] of tableColumns.entries()) {
      const { dataType, dataLength } = inferColumnType(column);
      const isPrimaryKey = Number(column.pk) > 0;
      const isSingleIntegerPrimaryKey = (
        isPrimaryKey
        && primaryKeyColumns.length === 1
        && column.type === 'INTEGER'
      );
      const foreignKey = foreignKeyByColumn.get(column.name);
      const isInternalForeignKey = foreignKey && selectedTableNames.has(foreignKey.targetTable);
      const externalReference = EXTERNAL_REFERENCES[`${tableName}.${column.name}`];
      const notes = [];
      if (isSingleIntegerPrimaryKey) notes.push('AUTO_INCREMENT 主鍵');
      else if (isPrimaryKey) notes.push(`複合主鍵第 ${Number(column.pk)} 欄`);
      if (externalReference) {
        notes.push(`外部來源參照：${externalReference}；不建立跨資料庫 FK`);
      }
      if (column.name === 'row_version') notes.push('樂觀鎖版本，每次更新加 1');

      columns.push({
        id: nextColumnId,
        table_id: tableId,
        en_name: column.name,
        zh_name: ZH_NAME_BY_FIELD[column.name] ?? column.name,
        alias_name: '',
        data_type: dataType,
        data_length: dataLength,
        is_pk: isPrimaryKey ? 1 : 0,
        is_index: isPrimaryKey || indexed.has(column.name) || isInternalForeignKey ? 1 : 0,
        is_unique: isSingleIntegerPrimaryKey || uniqueSingles.has(column.name) ? 1 : 0,
        is_fk: isInternalForeignKey ? 1 : 0,
        is_nullable: isPrimaryKey || Number(column.notnull) === 1 ? 0 : 1,
        is_auto: isSingleIntegerPrimaryKey ? 1 : 0,
        default_val: normalizeDefault(column.dflt_value),
        notes: notes.join('；'),
        sort_order: index + 1,
      });
      nextColumnId += 1;

      if (isInternalForeignKey) {
        relations.push({
          id: nextRelationId,
          from_table_id: tableIdByName.get(foreignKey.targetTable),
          from_col: foreignKey.targetColumn,
          to_table_id: tableId,
          to_col: foreignKey.sourceColumn,
          cardinality: '||--o{',
          label: `${foreignKey.targetTable}.${foreignKey.targetColumn} 關聯 ${tableName}.${foreignKey.sourceColumn}`,
        });
        nextRelationId += 1;
      }
    }
  }

  return {
    format: 'yk-schema-db',
    version: 1,
    scope: 'database',
    database: target.database,
    groups: GROUPS,
    subgroups: [],
    tables,
    columns,
    relations,
    sample_data: [],
    form_fields: [],
  };
}

export async function exportCatalogAdminSchema({
  databasePath = DEFAULT_DATABASE_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
  targetName = 'telecom_catalog_admin',
} = {}) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedOutputPath = resolve(outputPath);
  const database = new DatabaseSync(resolvedDatabasePath, { readOnly: true });
  let schema;
  try {
    schema = buildSchema(database, targetName);
  } finally {
    database.close();
  }
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  return {
    outputPath: resolvedOutputPath,
    database: schema.database.en_name,
    tableCount: schema.tables.length,
    columnCount: schema.columns.length,
    relationCount: schema.relations.length,
    sampleDataCount: schema.sample_data.length,
  };
}

async function main() {
  const report = await exportCatalogAdminSchema({
    databasePath: process.argv[2] ?? DEFAULT_DATABASE_PATH,
    outputPath: process.argv[3] ?? DEFAULT_OUTPUT_PATH,
    targetName: process.argv[4] ?? 'telecom_catalog_admin',
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
