import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inquiryContextCopy,
  inquiryContextFromSearch,
} from '../../src/web/assets/inquiry-context.mjs';

test('quote context only accepts one known intent and one safe product slug', () => {
  assert.deepEqual(
    inquiryContextFromSearch('?intent=quote&product=plan-ftth-300m-2610dfb2'),
    { intent: 'quote', productSlug: 'plan-ftth-300m-2610dfb2' },
  );
  assert.deepEqual(
    inquiryContextFromSearch('?intent=coverage'),
    { intent: 'coverage', productSlug: null },
  );
  assert.deepEqual(
    inquiryContextFromSearch('?intent=unknown&product=not/allowed'),
    { intent: null, productSlug: null },
  );
  assert.deepEqual(
    inquiryContextFromSearch('?intent=quote&intent=coverage&product=first&product=second'),
    { intent: null, productSlug: null },
  );
});

test('quote context copy stays reviewed when the URL has no accepted value', () => {
  assert.equal(inquiryContextCopy('coverage'), '你正在確認可用涵蓋與方案。');
  assert.equal(inquiryContextCopy('enterprise'), '你想諮詢企業網路服務。');
  assert.equal(inquiryContextCopy(null), '我們會依你的需求協助確認下一步。');
});
