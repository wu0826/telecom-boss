import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('../../src/server/admin/', import.meta.url);

async function filesRecursively(url) {
  const directory = await readdir(url, { withFileTypes: true });
  const files = [];
  for (const entry of directory) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url);
    if (entry.isDirectory()) files.push(...await filesRecursively(child));
    else if (entry.name.endsWith('.mjs')) files.push(child);
  }
  return files;
}

test('admin write repositories use rollback-aware result transactions', async () => {
  const files = await filesRecursively(ROOT);
  const violations = [];
  for (const file of files) {
    if (!file.pathname.endsWith('-repository.mjs') && !file.pathname.endsWith('/order-workflow.mjs')) continue;
    const source = await readFile(file, 'utf8');
    if (!/\b(?:INSERT|UPDATE|DELETE)\b/i.test(source)) continue;
    if (source.includes('runInTransaction(')) violations.push(file.pathname);
  }
  assert.deepEqual(violations, []);
});

test('known late-conflict flows are protected by rollback-aware transactions', async () => {
  const targets = [
    'billing/payment-repository.mjs',
    'inventory/inventory-repository.mjs',
    'inquiries/inquiry-conversion-repository.mjs',
    'operations/outage-repository.mjs',
    'orders/order-repository.mjs',
    'products/product-repository.mjs',
    'products/content-repository.mjs',
    'subscriptions/subscription-repository.mjs',
  ];
  for (const target of targets) {
    const source = await readFile(new URL(target, ROOT), 'utf8');
    assert.match(source, /runAtomicResult\(database, async/, target);
  }
});
