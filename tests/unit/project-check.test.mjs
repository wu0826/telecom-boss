import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProjectCheckError, validateProject } from '../../scripts/check.mjs';

async function createFixture({ includeTelecomSnapshot = true, dependencies = { mysql2: '3.23.2' } } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'telecom-boss-check-'));
  const snapshotDir = join(rootDir, 'database', 'snapshots');

  await mkdir(snapshotDir, { recursive: true });
  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', dependencies }),
    'utf8',
  );
  await writeFile(
    join(snapshotDir, 'website_db.schema.json'),
    JSON.stringify({
      format: 'yk-schema-db',
      database: { en_name: 'website_db' },
      groups: Array.from({ length: 6 }),
      tables: Array.from({ length: 12 }),
      columns: Array.from({ length: 106 }),
      relations: [],
      sample_data: Array.from({ length: 7 }),
    }),
    'utf8',
  );

  if (includeTelecomSnapshot) {
    await writeFile(
      join(snapshotDir, 'telecom_boss.schema.json'),
      JSON.stringify({
        format: 'yk-schema-db',
        database: { en_name: 'telecom_boss' },
        groups: Array.from({ length: 8 }),
        tables: Array.from({ length: 39 }),
        columns: Array.from({ length: 421 }),
        relations: Array.from({ length: 64 }),
        sample_data: Array.from({ length: 24 }),
      }),
      'utf8',
    );
  }

  return rootDir;
}

test('validateProject accepts the approved mysql2 runtime dependency and expected snapshots', async (t) => {
  const rootDir = await createFixture();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const report = await validateProject(rootDir);

  assert.equal(report.isValid, true);
  assert.deepEqual(report.website, {
    groups: 6,
    tables: 12,
    columns: 106,
    relations: 0,
    sampleRows: 7,
  });
  assert.deepEqual(report.telecom, {
    groups: 8,
    tables: 39,
    columns: 421,
    relations: 64,
    sampleRows: 24,
  });
  assert.equal(report.thirdPartyDependencyCount, 1);
});

test('validateProject rejects a missing required snapshot', async (t) => {
  const rootDir = await createFixture({ includeTelecomSnapshot: false });
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  await assert.rejects(
    () => validateProject(rootDir),
    (error) => error instanceof ProjectCheckError && /telecom_boss\.schema\.json/.test(error.message),
  );
});

test('validateProject rejects unapproved third-party dependencies', async (t) => {
  const rootDir = await createFixture({ dependencies: { express: '^5.0.0' } });
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  await assert.rejects(
    () => validateProject(rootDir),
    (error) => error instanceof ProjectCheckError && /third-party dependencies/i.test(error.message),
  );
});
