import assert from 'node:assert/strict';
import test from 'node:test';

import {
  productDetailView,
  productSlugFromSearch,
} from '../../src/web/assets/product-detail.mjs';

test('product detail accepts exactly one safe public product slug from the URL', () => {
  assert.equal(productSlugFromSearch('?product=plan-ftth-300m-2610dfb2'), 'plan-ftth-300m-2610dfb2');
  assert.equal(productSlugFromSearch('?product=not/allowed'), null);
  assert.equal(productSlugFromSearch('?product=first&product=second'), null);
  assert.equal(productSlugFromSearch('?category=services-broadband'), null);
});

test('product detail projects only bounded safe presentation fields from the public DTO', () => {
  const detail = productDetailView({
    slug: 'plan-ftth-300m-2610dfb2',
    name: '社區網路 FTTH 300M',
    type: 'SERVICE_PLAN',
    category: { slug: 'services-broadband', name: '寬頻服務' },
    content: {
      title: 'FTTH 300M 家用光纖',
      summary: '適合家庭影音與多裝置同步。',
      bodyText: '先確認涵蓋，再安排安裝。',
    },
    media: [
      { url: '/assets/fiber.svg', altText: '光纖服務示意圖', isPrimary: true },
      { url: 'javascript:alert(1)', altText: '不安全圖片', isPrimary: false },
    ],
    pricing: {
      kind: 'PLAN',
      lowestMonthlyAmount: '396.00',
      sellingPrice: null,
      prices: [
        { label: '標準月租', amount: '396.00' },
        { label: '次月優惠', amount: '350.00' },
        { label: '第三期', amount: '333.00' },
        { label: '不應顯示', amount: '300.00' },
      ],
    },
    promotions: [{ name: 'FTTH 首裝優惠', description: '首裝贈無線路由器', gift: { brand: 'TP-Link', modelName: 'Archer A6' } }],
    specifications: Array.from({ length: 6 }, (_, index) => ({
      key: `spec-${index}`,
      groupLabel: '連線能力',
      label: `規格 ${index + 1}`,
      value: String(index + 1),
      unit: 'Mbps',
    })),
    sections: [{ key: 'overview', title: '服務重點', bodyText: '保留公開說明文字。' }],
    brands: [{ name: '洋基展示品牌', description: '公開品牌資訊。', websiteUrl: 'https://example.test/' }],
    cost: 'should never be rendered',
    audit: { hidden: true },
  });

  assert.deepEqual(detail, {
    audience: '想先比較公開月租與申裝條件的使用者。',
    brands: [{
      description: '公開品牌資訊。',
      name: '洋基展示品牌',
      websiteUrl: 'https://example.test/',
    }],
    category: '寬頻服務',
    description: '先確認涵蓋，再安排安裝。',
    media: { altText: '光纖服務示意圖', url: '/assets/fiber.svg' },
    name: 'FTTH 300M 家用光纖',
    prices: [
      { amount: '396', label: '標準月租' },
      { amount: '350', label: '次月優惠' },
      { amount: '333', label: '第三期' },
    ],
    promotions: [{ description: '首裝贈無線路由器', gift: '贈 TP-Link Archer A6', name: 'FTTH 首裝優惠' }],
    quoteHref: '/?intent=quote&product=plan-ftth-300m-2610dfb2#apply',
    sections: [{ bodyText: '保留公開說明文字。', title: '服務重點' }],
    serviceRoute: {
      href: '/services/fiber-broadband.html',
      text: '查看寬頻服務介紹',
    },
    specifications: [
      { groupLabel: '連線能力', label: '規格 1', value: '1 Mbps' },
      { groupLabel: '連線能力', label: '規格 2', value: '2 Mbps' },
      { groupLabel: '連線能力', label: '規格 3', value: '3 Mbps' },
      { groupLabel: '連線能力', label: '規格 4', value: '4 Mbps' },
      { groupLabel: '連線能力', label: '規格 5', value: '5 Mbps' },
    ],
    summary: '適合家庭影音與多裝置同步。',
  });
  assert.doesNotMatch(JSON.stringify(detail), /cost|audit|javascript/i);
});
