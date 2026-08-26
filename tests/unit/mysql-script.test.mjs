import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { splitMysqlScript, summarizeMysqlScript } from '../../src/server/db/mysql-script.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const UP = join(ROOT, 'database', 'migrations', 'mysql', '002_catalog_v2_up.sql');
const DOWN = join(ROOT, 'database', 'migrations', 'mysql', '002_catalog_v2_down.sql');

test('MySQL script parser preserves trigger bodies while honoring DELIMITER', async () => {
  const sql = await readFile(UP, 'utf8');
  const statements = splitMysqlScript(sql);

  assert.equal(statements.length, 15);
  assert.equal(statements.filter((statement) => /CREATE\s+TRIGGER/i.test(statement)).length, 2);
  const trigger = statements.find((statement) => /trg_catalog_categories_insert_depth/i.test(statement));
  assert.match(trigger, /SIGNAL SQLSTATE '45000'/);
  assert.match(trigger, /END IF;/);
  assert.doesNotMatch(trigger, /DELIMITER/i);
});

test('Catalog V2 MySQL up/down plans are symmetric at object level', async () => {
  const [up, down] = await Promise.all([readFile(UP, 'utf8'), readFile(DOWN, 'utf8')]);
  const upSummary = summarizeMysqlScript(up);
  const downSummary = summarizeMysqlScript(down);

  assert.equal(upSummary.createTableCount, 10);
  assert.equal(upSummary.createTriggerCount, 2);
  assert.equal(downSummary.dropTableCount, 10);
  assert.equal(downSummary.dropTriggerCount, 2);
  assert.match(upSummary.sha256, /^[a-f0-9]{64}$/);
  assert.match(downSummary.sha256, /^[a-f0-9]{64}$/);
});
