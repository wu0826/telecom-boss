import assert from 'node:assert/strict';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

test('fiber broadband is a standalone public service page with shared quote navigation', async (t) => {
  const application = await startSeededApplication(t);
  const [pageResponse, shellResponse, styleResponse] = await Promise.all([
    fetch(`${application.origin}/services/fiber-broadband.html`),
    fetch(`${application.origin}/assets/showcase-shell.mjs`),
    fetch(`${application.origin}/assets/styles/showcase.css`),
  ]);

  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  const page = await pageResponse.text();
  assert.match(page, /data-showcase-page="fiber-broadband"/);
  assert.match(page, /id="main-content"/);
  assert.match(page, /光纖寬頻/);
  assert.match(page, /data-quote-link[^>]+data-quote-intent="coverage"/);
  assert.match(page, /href="\/products\/catalog\.html"/);
  assert.match(page, /\/assets\/showcase-shell\.mjs/);
  assert.doesNotMatch(page, /\son(?:click|load|error)=/i);

  assert.equal(shellResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  const shell = await shellResponse.text();
  assert.match(shell, /比奇堡電信/);
  assert.match(shell, /Bikini-bottom-telecom-logo\.png/);
  assert.doesNotMatch(shell, /洋基電信|YANKEES TELECOM/);
  assert.match(shell, /site-header/);
  assert.match(shell, /site-footer/);
  assert.match(shell, /URLSearchParams/);
  assert.match(shell, /intent/);
  assert.match(shell, /product/);
  assert.doesNotMatch(shell, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('remaining service pages share the shell without turning service copy into product claims', async (t) => {
  const application = await startSeededApplication(t);
  const pages = [
    ['enterprise-connectivity.html', 'enterprise', '企業網路'],
    ['subscription-rental.html', 'rental', '訂閱式設備租賃'],
    ['low-voltage-engineering.html', 'site-survey', '弱電工程'],
    ['av-integration.html', 'site-survey', '會議與教學多媒體'],
  ];

  for (const [filename, intent, title] of pages) {
    const response = await fetch(`${application.origin}/services/${filename}`);
    assert.equal(response.status, 200, filename);
    const page = await response.text();
    assert.match(page, new RegExp(`<title>${title}｜比奇堡電信</title>`));
    assert.match(page, new RegExp(`data-quote-intent="${intent}"`));
    assert.match(page, /id="showcase-breadcrumb"/);
    assert.match(page, /\/assets\/showcase-shell\.mjs/);
    assert.match(page, /class="showcase-faq"/);
    assert.match(page, /href="\/products\/catalog\.html"/);
    assert.doesNotMatch(page, /(?:fetch\(|\/api\/v1\/|NT\$|\son(?:click|load|error)=)/i);
  }
});

test('product catalog is an independent public page with accessible result states', async (t) => {
  const application = await startSeededApplication(t);
  const [response, scriptResponse] = await Promise.all([
    fetch(`${application.origin}/products/catalog.html`),
    fetch(`${application.origin}/assets/product-catalog.mjs`),
  ]);

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /<title>商品目錄｜比奇堡電信<\/title>/);
  assert.match(page, /id="catalog-results"/);
  assert.match(page, /id="catalog-status"[^>]+aria-live="polite"/);
  assert.match(page, /id="catalog-error"/);
  assert.match(page, /id="catalog-retry"/);
  assert.match(page, /\/assets\/product-catalog\.mjs/);
  assert.doesNotMatch(page, /(?:\/api\/v1\/|\son(?:click|load|error)=)/i);

  assert.equal(scriptResponse.status, 200);
  const script = await scriptResponse.text();
  assert.match(script, /\/api\/v1\/catalog\/products/);
  assert.match(script, /URLSearchParams/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('product detail template and fixed plan entries stay separate from public product data', async (t) => {
  const application = await startSeededApplication(t);
  const pages = [
    ['/products/detail.html', null],
    ['/products/services-broadband/plan-vdsl2-100m.html', 'plan-vdsl2-100m-f2b1ce43'],
    ['/products/services-broadband/plan-ftth-300m.html', 'plan-ftth-300m-2610dfb2'],
    ['/products/services-broadband/plan-ftth-500m.html', 'plan-ftth-500m-a43261d4'],
  ];

  for (const [path, productSlug] of pages) {
    const response = await fetch(`${application.origin}${path}`);
    assert.equal(response.status, 200, path);
    const page = await response.text();
    assert.match(page, /id="product-detail-results"/);
    assert.match(page, /id="product-detail-status"[^>]+aria-live="polite"/);
    assert.match(page, /\/assets\/product-detail\.mjs/);
    assert.doesNotMatch(page, /(?:\/api\/v1\/|\son(?:click|load|error)=)/i);
    if (productSlug) assert.match(page, new RegExp(`data-product-slug="${productSlug}"`));
  }
});
