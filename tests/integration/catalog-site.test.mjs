import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { migrateMetadataDatabase } from '../../src/server/db/metadata-migration.mjs';
import { migrateTelecomDatabase } from '../../src/server/db/telecom-migration.mjs';
import { seedMetadataDatabase, seedTelecomDatabase } from '../../src/server/db/seed.mjs';
import { startApplicationServer } from '../../src/server/http/server.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const WEBSITE_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'website_db.schema.json');
const TELECOM_SNAPSHOT_PATH = join(PROJECT_ROOT, 'database', 'snapshots', 'telecom_boss.schema.json');

async function seededServer(t) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'telecom-catalog-'));
  const metadataDatabasePath = join(temporaryDirectory, 'website_db.sqlite');
  const telecomDatabasePath = join(temporaryDirectory, 'telecom_boss.sqlite');
  await migrateMetadataDatabase({
    databasePath: metadataDatabasePath,
    snapshotPath: WEBSITE_SNAPSHOT_PATH,
  });
  await migrateTelecomDatabase({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  await seedMetadataDatabase({
    databasePath: metadataDatabasePath,
    websiteSnapshotPath: WEBSITE_SNAPSHOT_PATH,
    telecomSnapshotPath: TELECOM_SNAPSHOT_PATH,
  });
  await seedTelecomDatabase({
    databasePath: telecomDatabasePath,
    snapshotPath: TELECOM_SNAPSHOT_PATH,
  });

  const application = await startApplicationServer({
    host: '127.0.0.1',
    port: 0,
    metadataDatabasePath,
    telecomDatabasePath,
  });
  t.after(async () => {
    await application.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  return application;
}

test('catalog API returns public plans, prices, promotions, and gift equipment', async (t) => {
  const application = await seededServer(t);
  const response = await fetch(`${application.origin}/api/v1/catalog`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.brand, {
    name: '比奇堡電信',
    tagline: '社區網路，穩定連結每一天',
  });
  assert.deepEqual(body.plans.map(({ code }) => code), [
    'VDSL2-100M',
    'FTTH-300M',
    'FTTH-500M',
  ]);

  const [hundred, threeHundred, fiveHundred] = body.plans;
  assert.equal(hundred.downloadMbps, 100);
  assert.equal(hundred.lowestMonthlyAmount, '288.00');
  assert.deepEqual(hundred.prices.map(({ amount }) => amount), ['288.00', '333.00']);
  assert.equal(threeHundred.downloadMbps, 300);
  assert.equal(threeHundred.lowestMonthlyAmount, '396.00');
  assert.equal(fiveHundred.downloadMbps, 500);
  assert.equal(fiveHundred.lowestMonthlyAmount, '423.00');
  for (const plan of [threeHundred, fiveHundred]) {
    assert.equal(plan.promotions.length, 1);
    assert.deepEqual(plan.promotions[0].gift, {
      quantity: 1,
      modelCode: 'TPLINK-A6',
      brand: 'TP-Link',
      modelName: 'Archer A6',
    });
  }

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /created_at|updated_at|unit_cost|gift_equipment_model_id/);
});

test('catalog endpoint rejects unsupported methods', async (t) => {
  const application = await seededServer(t);
  const response = await fetch(`${application.origin}/api/v1/catalog`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('official product site shell and assets are served from the bounded web root', async (t) => {
  const application = await seededServer(t);
  const htmlResponse = await fetch(`${application.origin}/`);
  const html = await htmlResponse.text();

  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(htmlResponse.headers.get('content-security-policy'), /script-src 'self'/);
  const logoResponse = await fetch(`${application.origin}/assets/images/Bikini-bottom-telecom-logo.png`);
  assert.equal(logoResponse.status, 200);
  assert.equal(logoResponse.headers.get('content-type'), 'image/png');
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /比奇堡電信/);
  assert.match(html, /Bikini-bottom-telecom-logo\.png/);
  assert.doesNotMatch(html, /brand__logo__footer/);
  assert.match(html, /網路方案/);
  assert.match(html, /PRODUCT COMPARISON/);
  assert.match(html, /立即申裝/);
  assert.match(html, /id="inquiry-form"/);
  assert.match(html, /id="plan-dialog"/);
  assert.match(html, /name="consent"/);
  assert.match(html, /name="company"/);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<main[^>]+id="main-content"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-controls="site-navigation"/);
  assert.match(html, /href="\/services\/fiber-broadband\.html"/);
  assert.match(html, /href="\/services\/enterprise-connectivity\.html"/);
  assert.match(html, /href="\/services\/subscription-rental\.html"/);
  assert.match(html, /href="\/services\/low-voltage-engineering\.html"/);
  assert.match(html, /href="\/services\/av-integration\.html"/);
  assert.match(html, /href="\/products\/catalog\.html"/);
  assert.doesNotMatch(html, /\son(?:click|load|error)=/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);

  const [cssResponse, scriptResponse, secretResponse] = await Promise.all([
    fetch(`${application.origin}/assets/styles/app.css`),
    fetch(`${application.origin}/assets/app.mjs`),
    fetch(`${application.origin}/package.json`),
  ]);
  assert.equal(cssResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(secretResponse.status, 404);

  const script = await scriptResponse.text();
  assert.match(script, /\/api\/v1\/catalog\/products/);
  assert.match(script, /get\('catalog'\)\s*===\s*'legacy'/);
  assert.match(script, /openProductDetail/);
  assert.match(script, /stale-link|商品目前未開放/);
  assert.match(script, /\/api\/v1\/catalog\/plans\//);
  assert.match(script, /\/api\/v1\/inquiries/);
  assert.match(script, /Idempotency-Key/);
  assert.match(script, /inquiryContextFromSearch/);
  assert.match(script, /restoreInquiryContext/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
});
