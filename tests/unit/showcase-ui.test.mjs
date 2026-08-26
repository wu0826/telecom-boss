import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogRequestPath,
  categoryFromSearch,
  productCardPreview,
} from '../../src/web/assets/product-catalog.mjs';

const categories = [
  { slug: 'services-broadband', name: '寬頻服務' },
  { slug: 'network-equipment', name: '網路設備' },
];

test('catalog query only restores a category published by the public product list', () => {
  assert.equal(categoryFromSearch('?category=services-broadband', categories), 'services-broadband');
  assert.equal(categoryFromSearch('?category=unknown-category', categories), null);
  assert.equal(categoryFromSearch('?category=services-broadband&category=network-equipment', categories), null);
  assert.equal(categoryFromSearch('?not-category=services-broadband', categories), null);
});

test('catalog request keeps locale fixed and only appends an allowlisted category', () => {
  assert.equal(catalogRequestPath(null, categories), '/api/v1/catalog/products?locale=zh-TW');
  assert.equal(
    catalogRequestPath('services-broadband', categories),
    '/api/v1/catalog/products?locale=zh-TW&category=services-broadband',
  );
  assert.equal(catalogRequestPath('unknown-category', categories), '/api/v1/catalog/products?locale=zh-TW');
});

test('product card preview keeps the catalog view concise and routes context safely', () => {
  const preview = productCardPreview({
    slug: 'plan-ftth-300m-2610dfb2',
    name: '社區網路 FTTH 300M',
    category: { slug: 'services-broadband', name: '寬頻服務' },
    content: { summary: '適合家庭影音與多裝置同步。' },
    pricing: { kind: 'PLAN', lowestMonthlyAmount: '396.00' },
    promotions: [{ title: '首裝優惠' }],
  });

  assert.deepEqual(preview, {
    category: '寬頻服務',
    detailHref: '/products/detail.html?product=plan-ftth-300m-2610dfb2',
    facts: ['每月最低 NT$ 396', '首裝優惠'],
    purpose: '適合家庭影音與多裝置同步。',
    quoteHref: '/?intent=quote&product=plan-ftth-300m-2610dfb2#apply',
    title: '社區網路 FTTH 300M',
  });
});

test('product card preview uses a public one-time price when no monthly plan price exists', () => {
  const preview = productCardPreview({
    slug: 'public-router',
    name: '公開展示路由器',
    category: { slug: 'network-equipment', name: '網路設備' },
    content: { summary: null },
    pricing: { kind: 'STOCK', lowestMonthlyAmount: null, sellingPrice: '899.00' },
    promotions: [],
  });

  assert.deepEqual(preview.facts, ['公開售價 NT$ 899']);
});

test('product card preview retains a non-whole reviewed amount and skips a blank promotion title', () => {
  const preview = productCardPreview({
    slug: 'public-accessory',
    name: '公開展示配件',
    category: { slug: 'network-equipment', name: '網路設備' },
    content: { summary: '適合需要加購網路配件的使用情境。' },
    pricing: { kind: 'STOCK', lowestMonthlyAmount: null, sellingPrice: '899.50' },
    promotions: [{ title: ' ', description: '公開加購優惠' }],
  });

  assert.deepEqual(preview.facts, ['公開售價 NT$ 899.50', '公開加購優惠']);
});
