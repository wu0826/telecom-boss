import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  migrateTelecomTarget,
  TELECOM_MIGRATIONS,
} from '../../src/server/db/migration-runner.mjs';

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');
const EXPORT_SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'export-csmu-catalog-schema.mjs');

const CATALOG_TABLES = [
  'catalog_categories',
  'catalog_products',
  'catalog_product_categories',
  'catalog_product_content',
  'catalog_product_sections',
  'catalog_product_media',
  'catalog_product_specs',
  'catalog_brands',
  'catalog_product_brands',
  'catalog_promotion_products',
];

const EXPECTED_CROSSWALK = {
  catalog_categories: 'project_cate_nav1',
  catalog_products: 'project_master',
  catalog_product_categories: '正規化新增',
  catalog_product_content: 'project_content',
  catalog_product_sections: 'product_overview',
  catalog_product_media: 'product_pic',
  catalog_product_specs: 'product_spec',
  catalog_brands: 'product_brand',
  catalog_product_brands: 'product_brand_map',
  catalog_promotion_products: '正規化新增',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exportSchema(databasePath, outputPath) {
  const { stdout } = await execFile(process.execPath, [
    EXPORT_SCRIPT_PATH,
    databasePath,
    outputPath,
  ]);
  return JSON.parse(stdout);
}

test('CSMU Catalog V2 artifact is deterministic, crosswalked, and read-only against its source schema', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-csmu-catalog-schema-'));
  const databasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  const firstOutputPath = join(temporaryDirectory, 'first.schema.json');
  const secondOutputPath = join(temporaryDirectory, 'second.schema.json');
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await migrateTelecomTarget({
    databasePath,
    snapshotPath: SNAPSHOT_PATH,
    migrations: TELECOM_MIGRATIONS,
  });
  const sourceBefore = await readFile(databasePath);

  const [firstReport, secondReport] = await Promise.all([
    exportSchema(databasePath, firstOutputPath),
    exportSchema(databasePath, secondOutputPath),
  ]);
  const [firstArtifact, secondArtifact] = await Promise.all([
    readFile(firstOutputPath),
    readFile(secondOutputPath),
  ]);

  assert.deepEqual(firstArtifact, secondArtifact);
  assert.equal(sha256(await readFile(databasePath)), sha256(sourceBefore));
  assert.deepEqual(firstReport, {
    outputPath: firstOutputPath,
    database: 'yankees_service_cms',
    tableCount: 10,
    columnCount: 102,
    relationCount: 12,
    sampleDataCount: 0,
  });
  assert.equal(secondReport.database, 'yankees_service_cms');

  const artifact = JSON.parse(firstArtifact);
  assert.equal(artifact.format, 'yk-schema-db');
  assert.equal(artifact.scope, 'database');
  assert.equal(artifact.database.en_name, 'yankees_service_cms');
  assert.match(artifact.database.description, /僅供本機產生/);
  assert.deepEqual(artifact.tables.map((table) => table.en_name), CATALOG_TABLES);
  assert.deepEqual(artifact.sample_data, []);
  assert.deepEqual(artifact.form_fields, []);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const table of artifact.tables) {
      assert.match(table.description, new RegExp(EXPECTED_CROSSWALK[table.en_name]));
      assert.match(table.description, /索引|唯一|FK|primary|排序/i);
      const exportedColumns = artifact.columns
        .filter((column) => column.table_id === table.id)
        .map((column) => column.en_name);
      const sourceColumns = database.prepare(`PRAGMA table_info("${table.en_name}")`).all()
        .map((column) => column.name);
      assert.deepEqual(exportedColumns, sourceColumns);
    }
  } finally {
    database.close();
  }
});
