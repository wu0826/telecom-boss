import assert from 'node:assert/strict';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

test('admin entry serves an accessible login and protected application shell', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [slashResponse, noSlashResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin`),
  ]);
  const html = await slashResponse.text();

  assert.equal(slashResponse.status, 200);
  assert.equal(noSlashResponse.status, 200);
  assert.equal(slashResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /href="#admin-main"/);
  assert.match(html, /id="development-login"/);
  assert.match(html, /id="development-account"/);
  assert.match(html, /id="admin-shell"/);
  assert.match(html, /id="admin-navigation"/);
  assert.match(html, /id="admin-main"/);
  assert.match(html, /id="global-search-form"[^>]+role="search"/);
  assert.match(html, /id="global-search-input"[^>]+maxlength="100"/);
  assert.match(html, /id="global-search-results"[^>]+role="listbox"/);
  assert.match(html, /id="dashboard-cards"[^>]+role="list"/);
  assert.match(html, /id="dashboard-status"[^>]+role="status"/);
  assert.match(html, /id="dashboard-refresh"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-controls="admin-navigation"/);
  assert.doesNotMatch(html, /\son(?:click|load|error)=/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
});

test('desktop global search uses permission-gated fixed module requests and safe keyboard controls', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [pageResponse, appResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/js/pages/global-search-page.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await appResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /globalSearchModulesForPermissions/);
  assert.match(script, /customer\.read/);
  assert.match(script, /catalog\.manage/);
  assert.match(script, /operations\.manage/);
  assert.match(script, /billing\.manage/);
  assert.match(script, /getAdminCustomers/);
  assert.match(script, /getAdminCatalogProducts/);
  assert.match(script, /getAdminWorkOrders/);
  assert.match(script, /getAdminInvoices/);
  assert.match(script, /inquiryId/);
  assert.match(script, /customerId/);
  assert.match(script, /productId/);
  assert.match(script, /setTimeout/);
  assert.match(script, /正在搜尋可存取資料/);
  assert.match(script, /沒有找到符合條件的可存取資料/);
  assert.match(script, /搜尋暫時無法完成/);
  assert.match(script, /ArrowDown/);
  assert.match(script, /Escape/);
  assert.match(script, /workspace-title.*focus\(\)/s);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('admin dashboard UI has bounded safe rendering and recoverable states', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/js/pages/dashboard-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/dashboard/);
  assert.match(script, /aria-busy/);
  assert.match(script, /AUTHENTICATION_REQUIRED/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop operational-report workspace uses only the fixed report API and exposes accessible states', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, appResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/report-page.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /admin-app\.mjs\?v=20260824-outage-inline-editor/);
  assert.match(html, /components\.css\?v=20260818-production-auth/);
  assert.match(html, /id="report-page"[^>]+hidden/);
  assert.match(html, /id="report-filter-form"/);
  assert.match(html, /id="report-from"[^>]+type="date"/);
  assert.match(html, /id="report-to"[^>]+type="date"/);
  assert.match(html, /id="report-refresh"/);
  assert.match(html, /id="report-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="report-results"[^>]+role="list"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await appResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /report-page\.mjs\?v=20260824-outage-inline-editor/);
  assert.match(script, /api-client\.mjs\?v=20260824-outage-inline-editor/);
  assert.doesNotMatch(script, /api-client\.mjs\?v=20260817-customer-export/);
  assert.match(script, /\/api\/v1\/admin\/reports\/operational/);
  assert.match(script, /getAdminOperationalReports/);
  assert.match(script, /sourceTotals/);
  assert.match(script, /itemLimit/);
  assert.match(script, /AUTHENTICATION_REQUIRED/);
  assert.match(script, /INVALID_QUERY/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop notification center uses the permission-filtered API and safe accessible controls', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/notification-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  assert.equal(pageResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /id="notification-toggle"[^>]+aria-controls="notification-panel"[^>]+aria-expanded="false"/);
  assert.match(html, /id="notification-badge"[^>]+aria-live="polite"/);
  assert.match(html, /id="notification-panel"[^>]+role="dialog"[^>]+aria-labelledby="notification-panel-title"[^>]+hidden/);
  assert.match(html, /id="notification-close"/);
  assert.match(html, /id="notification-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="notification-results"[^>]+role="list"[^>]+aria-busy="false"/);
  const pageScript = await pageResponse.text();
  const appScript = await appResponse.text();
  const pageApiVersion = pageScript.match(/api-client\.mjs\?v=([^'"]+)/)?.[1];
  const appApiVersion = appScript.match(/api-client\.mjs\?v=([^'"]+)/)?.[1];
  assert.ok(pageApiVersion);
  assert.equal(pageApiVersion, appApiVersion);
  const script = `${pageScript}\n${await clientResponse.text()}\n${appScript}`;
  assert.match(script, /\/api\/v1\/admin\/notifications/);
  assert.match(script, /getAdminNotifications/);
  assert.match(script, /isAuthorizedNotificationHref/);
  assert.match(appScript, /notificationPage\.configure\(nextPermissions\)/);
  assert.match(pageScript, /failure\.className = 'notification-error';[\s\S]*?status\.textContent = '通知載入失敗；沒有顯示舊資料。';\s*setBadge\(toggle, badge, 0, false\);/);
  assert.match(pageScript, /results\.replaceChildren\(\);\s*setBadge\(toggle, badge, 0, false\);\s*status\.textContent = '無法確認目前權限，未開啟目標工作區。';/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop system workspace presents safe health and recovery guidance without browser controls', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/system-page.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  assert.equal(pageResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /id="system-page"[^>]+hidden/);
  assert.match(html, /id="system-refresh"/);
  assert.match(html, /id="system-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="system-results"[^>]+role="list"[^>]+aria-busy="false"/);
  assert.match(html, /id="system-recovery"/);
  const pageScript = await pageResponse.text();
  const appScript = await appResponse.text();
  assert.match(appScript, /label: '系統健康', href: '#system', permissions: \['access\.manage', 'audit\.read'\]/);
  assert.match(appScript, /createSystemPage/);
  assert.match(appScript, /systemPage\.hide\(\)/);
  assert.match(pageScript, /getSystemHealth/);
  assert.match(pageScript, /label: '服務'/);
  assert.match(pageScript, /replaceChildren/);
  assert.match(pageScript, /textContent/);
  assert.match(pageScript, /npm run db:migrate/);
  assert.doesNotMatch(pageScript, /<button|fetch\([^)]*(?:migrate|restore|backup)|\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie|database\/data|database\/backups/);
});

test('desktop inquiry workspace provides query-preserving list and safe detail hooks', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/inquiry-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="inquiry-page"[^>]+hidden/);
  assert.match(html, /id="inquiry-filter-form"/);
  assert.match(html, /id="inquiry-results"/);
  assert.match(html, /id="inquiry-detail"/);
  assert.match(html, /id="inquiry-workflow-form"[^>]+hidden/);
  assert.match(html, /id="inquiry-assignee"/);
  assert.match(html, /id="inquiry-next-status"/);
  assert.match(html, /id="inquiry-conversion-form"[^>]+hidden/);
  assert.match(html, /id="inquiry-conversion-submit"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/inquiries/);
  assert.match(script, /parseListState/);
  assert.match(script, /serializeListState/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /AUTHENTICATION_REQUIRED/);
  assert.match(script, /INQUIRY_CONFLICT/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /updateAdminInquiry/);
  assert.match(script, /convertAdminInquiry/);
  assert.match(script, /replaceChildren/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop customer workspace exposes permission-aware safe create and edit hooks', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/customer-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="customer-page"[^>]+hidden/);
  assert.match(html, /id="customer-filter-form"/);
  assert.match(html, /id="customer-export"/);
  assert.match(html, /id="customer-export-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="customer-create-form"/);
  assert.match(html, /id="customer-profile-form"/);
  assert.match(html, /id="customer-contact-form"/);
  assert.match(html, /id="customer-location-form"/);
  assert.match(html, /id="customer-sensitive"[^>]+hidden/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/customers/);
  assert.match(script, /\/api\/v1\/admin\/customers\/export\.csv/);
  assert.match(script, /downloadAdminCustomerExport/);
  assert.match(script, /URL\.createObjectURL/);
  assert.match(script, /PERMISSION_DENIED/);
  assert.match(script, /sensitivePermission/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop catalog workspace exposes safe plan preview and publication hooks', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/plan-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="plan-page"[^>]+hidden/);
  assert.match(html, /id="plan-filter-form"/);
  assert.match(html, /id="plan-create-form"/);
  assert.match(html, /id="plan-edit-form"/);
  assert.match(html, /id="plan-preview"/);
  assert.match(html, /id="plan-publish"/);
  assert.match(html, /id="plan-unpublish"/);
  assert.match(html, /id="plan-delete"/);
  assert.match(html, /id="plan-price-form"/);
  assert.match(html, /id="plan-price-list"/);
  assert.match(html, /id="plan-price-status"[^>]+role="status"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/catalog\/plans/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /expectedUpdatedAt/);
  assert.match(script, /getAdminPlanPrices/);
  assert.match(script, /saveAdminPlanPrice/);
  assert.match(script, /AUTHENTICATION_REQUIRED/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop Catalog V2 workspace exposes category editing and guarded product deletion hooks', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, appResponse, componentsResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/product-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
    fetch(`${application.origin}/admin/js/components.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="product-page"[^>]+hidden/);
  assert.match(html, /id="product-filter-form"/);
  assert.match(html, /id="product-category-tree"/);
  assert.match(html, /id="product-category-create-form"/);
  assert.match(html, /id="product-category-edit-form"/);
  assert.match(html, /id="product-category-edit-form"[\s\S]+name="expectedVersion"/);
  assert.match(html, /id="product-category-move-form"/);
  assert.match(html, /id="product-create-form"/);
  assert.match(html, /id="product-detail"[^>]+tabindex="-1"[^>]+hidden/);
  assert.match(html, /id="product-edit-form"/);
  assert.match(html, /id="product-publish"/);
  assert.match(html, /id="product-archive"/);
  assert.match(html, /class="danger-button"[^>]+id="product-delete"/);
  assert.match(html, /id="product-action-dialog"[^>]+aria-labelledby="product-action-dialog-title"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}\n${await appResponse.text()}\n${await componentsResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/catalog-v2\/categories/);
  assert.match(script, /\/api\/v1\/admin\/catalog-v2\/products/);
  assert.match(script, /updateAdminCatalogCategory/);
  assert.match(script, /deleteAdminCatalogProduct/);
  assert.match(script, /只有草稿或已封存商品可以永久刪除/);
  assert.match(script, /createDialogController/);
  assert.match(script, /dialog\.addEventListener\('cancel'/);
  assert.match(script, /field === 'primaryCategoryId'\s*\?\s*product\.primaryCategory\?\.id/);
  assert.match(script, /showFormErrors/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop Catalog V2 content editor provides guarded tabs, field repair, and a safe preview projection', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, componentsResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/product-content-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/components.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="product-content-editor"[^>]+hidden/);
  assert.match(html, /id="product-content-tabs"[^>]+role="tablist"/);
  assert.match(html, /id="product-content-form"/);
  assert.match(html, /id="product-section-form"/);
  assert.match(html, /id="product-spec-form"/);
  assert.match(html, /id="product-media-form"/);
  assert.match(html, /id="product-brand-form"/);
  assert.match(html, /id="product-brand-link-form"/);
  assert.match(html, /id="product-content-preview"/);
  assert.match(html, /id="product-content-status"[^>]+role="status"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}\n${await componentsResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/catalog-v2\/products/);
  assert.match(script, /\/content\//);
  assert.match(script, /\/sections\//);
  assert.match(script, /\/media/);
  assert.match(script, /\/brands/);
  assert.match(script, /createTabsController/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /showFormErrors/);
  assert.match(script, /updateAdminCatalogProductContent\(currentProduct\.id, payload\.locale, \{\s*title: payload\.title,/s);
  assert.doesNotMatch(script, /\{ \.\.\.payload, expectedVersion: existingVersion \}/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop order workspace exposes safe draft, list, and linked-detail hooks', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/order-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="order-page"[^>]+hidden/);
  assert.match(html, /id="order-create-form"/);
  assert.match(html, /id="order-results-body"/);
  assert.match(html, /id="order-detail"/);
  assert.match(html, /id="order-submit"/);
  assert.match(html, /id="order-approve"/);
  assert.match(html, /id="order-cancel"/);
  assert.match(html, /id="order-work-order-link"[^>]+hidden/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/orders/);
  assert.match(script, /crypto\.randomUUID/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /transitionAdminOrder/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop operations workspace exposes synchronized work-order queue, calendar, kanban views, and guarded actions', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/work-order-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="work-order-page"[^>]+hidden/);
  assert.match(html, /id="work-order-filter-form"/);
  assert.match(html, /name="from"[^>]+type="date"/);
  assert.match(html, /name="to"[^>]+type="date"/);
  assert.match(html, /id="work-order-view-tabs"[^>]+role="tablist"/);
  assert.match(html, /id="work-order-view-queue"[^>]+aria-controls="work-order-groups"/);
  assert.match(html, /id="work-order-groups"[^>]+aria-labelledby="work-order-view-queue"/);
  assert.match(html, /data-work-order-view="queue"/);
  assert.match(html, /data-work-order-view="calendar"/);
  assert.match(html, /data-work-order-view="kanban"/);
  assert.match(html, /id="work-order-groups"/);
  assert.match(html, /id="work-order-create-form"/);
  assert.match(html, /id="work-order-detail"/);
  assert.match(html, /id="work-order-assign-form"/);
  assert.match(html, /id="work-order-schedule-form"/);
  assert.match(html, /id="work-order-complete-form"/);
  assert.equal(pageResponse.status, 200);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}\n${await appResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/work-orders/);
  assert.match(script, /buildWorkOrderRequestSearch/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /renderCalendar/);
  assert.match(script, /renderKanban/);
  assert.match(script, /workOrderId/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop subscription workspace links source, line account, work orders, and history safely', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/subscription-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="subscription-page"[^>]+hidden/);
  assert.match(html, /id="subscription-filter-form"/);
  assert.match(html, /id="subscription-results-body"/);
  assert.match(html, /id="subscription-detail"/);
  assert.match(html, /id="subscription-tabs"[^>]+role="tablist"/);
  assert.match(html, /id="subscription-account-form"/);
  assert.match(html, /id="subscription-history"/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/subscriptions/);
  assert.match(script, /credentialConfigured/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /credentialSecretRef\s*[:=]\s*[^'"\n]*\.serviceAccount/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop outage workspace exposes impacted services and privacy-safe announcement draft', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/outage-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="outage-page"[^>]+hidden/);
  assert.match(html, /id="outage-create-form"/);
  assert.match(html, /id="outage-results-body"/);
  assert.match(html, /id="outage-membership-form"/);
  assert.match(html, /id="outage-public-draft"/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}\n${await appResponse.text()}`;
  assert.match(script, /outage-page\.mjs\?v=20260824-outage-inline-editor/);
  assert.match(script, /\/api\/v1\/admin\/outages/);
  assert.match(script, /publicAnnouncementDraft/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.match(script, /outage-transition-editor/);
  assert.match(script, /createElement\('textarea'\)/);
  assert.doesNotMatch(script, /globalThis\.prompt/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop billing workspace generates, batches, issues, and voids invoices safely', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/invoice-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="invoice-page"[^>]+hidden/);
  assert.match(html, /id="invoice-generate-form"/);
  assert.match(html, /id="invoice-batch-form"/);
  assert.match(html, /id="invoice-results-body"/);
  assert.match(html, /id="invoice-detail"/);
  assert.match(html, /id="invoice-items"/);
  assert.match(html, /id="payment-form"/);
  assert.match(html, /id="payment-history"/);
  assert.match(html, /id="adjustment-form"/);
  assert.match(html, /id="billing-approval-list"/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/invoices/);
  assert.match(script, /\/api\/v1\/admin\/payments/);
  assert.match(script, /\/api\/v1\/admin\/billing-adjustments/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop inventory workspace exposes balances, movements, and equipment-safe forms', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/inventory-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="inventory-page"[^>]+hidden/);
  assert.match(html, /id="inventory-balance-body"/);
  assert.match(html, /id="inventory-movement-form"/);
  assert.match(html, /id="inventory-item-form"/);
  assert.match(html, /id="inventory-warehouse-form"/);
  assert.match(html, /id="inventory-movement-list"/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/inventory/);
  assert.match(script, /LOW_STOCK/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop content workspace previews, schedules, and publishes plain text safely', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, publicResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/content-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/assets/app.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="content-page"[^>]+hidden/);
  assert.match(html, /id="content-form"/);
  assert.match(html, /data-content-fields="announcements"/);
  assert.match(html, /data-content-fields="pages"/);
  assert.match(html, /data-content-fields="banners"/);
  assert.match(html, /id="content-preview"/);
  const script = `${await pageResponse.text()}\n${await clientResponse.text()}\n${await publicResponse.text()}`;
  assert.match(script, /\/api\/v1\/admin\/content/);
  assert.match(script, /\/api\/v1\/content/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('desktop access workspace separates role management from read-only audit exploration', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [htmlResponse, pageResponse, clientResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin/`),
    fetch(`${application.origin}/admin/js/pages/access-page.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  const html = await htmlResponse.text();
  assert.match(html, /id="access-page"[^>]+hidden/);
  assert.match(html, /id="access-staff-list"/);
  assert.match(html, /id="access-role-matrix"/);
  assert.match(html, /id="access-create-form"/);
  assert.match(html, /id="access-create-errors"[^>]+role="alert"[^>]+hidden/);
  assert.match(html, /id="access-create-staff-no"/);
  assert.match(html, /data-error-field="roleIds"/);
  assert.match(html, /id="access-delete"[^>]+class="danger-button"[^>]+hidden/);
  assert.match(html, /id="access-delete-dialog"[^>]+aria-labelledby="access-delete-dialog-title"/);
  assert.match(html, /id="access-delete-confirm"/);
  assert.match(html, /name="providerSubject"/);
  assert.match(html, /id="access-create-roles"/);
  assert.match(html, /id="access-role-form"/);
  assert.match(html, /id="audit-filter-form"/);
  assert.match(html, /id="audit-detail"[^>]+tabindex="-1"/);
  const pageScript = await pageResponse.text();
  const appScript = await appResponse.text();
  const script = `${pageScript}\n${await clientResponse.text()}`;
  const pageApiVersion = pageScript.match(/api-client\.mjs\?v=([^'\"]+)/)?.[1];
  const appApiVersion = appScript.match(/api-client\.mjs\?v=([^'\"]+)/)?.[1];
  assert.ok(pageApiVersion);
  assert.equal(pageApiVersion, appApiVersion);
  assert.match(script, /\/api\/v1\/admin\/access/);
  assert.match(script, /method:\s*'POST'/);
  assert.match(script, /method:\s*'DELETE'/);
  assert.match(script, /\/api\/v1\/admin\/audit/);
  assert.match(script, /deleteAdminStaff/);
  assert.match(script, /createDialogController/);
  assert.match(script, /createSubmissionGate/);
  assert.match(script, /showFormErrors/);
  assert.match(script, /replaceChildren/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|localStorage|sessionStorage|document\.cookie/);
});

test('admin shell assets stay inside the web root and avoid unsafe DOM/session storage APIs', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [cssResponse, appResponse, clientResponse, secretResponse] = await Promise.all([
    fetch(`${application.origin}/admin/css/admin.css`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
    fetch(`${application.origin}/admin/js/api-client.mjs`),
    fetch(`${application.origin}/admin/package.json`),
  ]);

  assert.equal(cssResponse.status, 200);
  assert.equal(appResponse.status, 200);
  assert.equal(clientResponse.status, 200);
  assert.equal(secretResponse.status, 404);
  const scripts = `${await appResponse.text()}\n${await clientResponse.text()}`;
  assert.doesNotMatch(scripts, /\.innerHTML\s*=/);
  assert.doesNotMatch(scripts, /localStorage|sessionStorage|document\.cookie/);
  assert.match(scripts, /textContent/);
  assert.match(scripts, /\/api\/v1\/admin\/auth\/session/);
  assert.match(scripts, /x-csrf-token/i);
});

test('admin page modules share one api client instance so CSRF state is not split', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [shellResponse, appResponse] = await Promise.all([
    fetch(`${application.origin}/admin`),
    fetch(`${application.origin}/admin/js/admin-app.mjs`),
  ]);
  assert.equal(shellResponse.status, 200);
  assert.equal(appResponse.status, 200);
  const shell = await shellResponse.text();
  assert.match(shell, /比奇堡電信/);
  assert.match(shell, /Bikini-bottom-telecom-logo\.png/);
  assert.doesNotMatch(shell, /洋基電信|YANKEES TELECOM/);
  const appScript = await appResponse.text();
  const pageSpecifiers = [...appScript.matchAll(/from '\.\/(pages\/[^']+\.mjs\?v=[^']+)'/g)]
    .map((match) => match[1]);
  assert.ok(pageSpecifiers.length > 0);

  const pageResponses = await Promise.all(pageSpecifiers.map((specifier) => (
    fetch(`${application.origin}/admin/js/${specifier}`)
  )));
  for (const response of pageResponses) assert.equal(response.status, 200);
  const moduleScripts = [appScript, ...await Promise.all(pageResponses.map((response) => response.text()))];
  const apiClientVersions = moduleScripts.flatMap((script) => (
    [...script.matchAll(/api-client\.mjs\?v=([^'\"]+)/g)].map((match) => match[1])
  ));

  assert.ok(apiClientVersions.length > 1);
  assert.deepEqual([...new Set(apiClientVersions)], [apiClientVersions[0]]);
  const cacheVersions = [
    shell.match(/admin-app\.mjs\?v=([^'\"]+)/)?.[1],
    ...pageSpecifiers.map((specifier) => specifier.match(/\?v=(.+)$/)?.[1]),
    ...apiClientVersions,
    ...moduleScripts.flatMap((script) => (
      [...script.matchAll(/product-content-page\.mjs\?v=([^'\"]+)/g)].map((match) => match[1])
    )),
  ];
  assert.ok(cacheVersions.every(Boolean));
  assert.deepEqual([...new Set(cacheVersions)], [cacheVersions[0]]);
});

test('admin session API remains protected when the static shell is public', async (t) => {
  const application = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const [response, bootstrapResponse] = await Promise.all([
    fetch(`${application.origin}/api/v1/admin/auth/session`),
    fetch(`${application.origin}/api/v1/admin/auth/bootstrap`),
  ]);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(bootstrapResponse.status, 200);
  assert.deepEqual((await bootstrapResponse.json()).data, { authenticated: false, capabilities: { passwordLogin: true, developmentLogin: true } });
});
