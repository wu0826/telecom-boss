import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseListState,
  serializeListState,
} from '../../src/web/admin/js/list-state.mjs';
import {
  createSubmissionGate,
  normalizeFieldErrors,
} from '../../src/web/admin/js/form-controller.mjs';
import {
  activateTab,
  nextDialogFocusIndex,
  statusPresentation,
} from '../../src/web/admin/js/components.mjs';
import { createDirtyTracker } from '../../src/web/admin/js/form-controller.mjs';
import { validateStaffCreation } from '../../src/web/admin/js/pages/access-page.mjs';
import {
  buildWorkOrderRequestSearch,
  parseWorkOrderViewState,
  serializeWorkOrderViewState,
} from '../../src/web/admin/js/pages/work-order-page.mjs';
import {
  globalSearchModulesForPermissions,
  normalizeGlobalSearchQuery,
} from '../../src/web/admin/js/pages/global-search-page.mjs';
import {
  buildCustomerExportSearch,
  requiresCustomerExportRelogin,
} from '../../src/web/admin/js/pages/customer-page.mjs';
import { AdminApiError, downloadAdminCustomerExport } from '../../src/web/admin/js/api-client.mjs';
import { buildOperationalReportSearch } from '../../src/web/admin/js/pages/report-page.mjs';
import { isAuthorizedNotificationHref } from '../../src/web/admin/js/pages/notification-page.mjs';
import { normalizeSystemHealth } from '../../src/web/admin/js/pages/system-page.mjs';

const LIST_OPTIONS = {
  allowedFilters: ['status', 'assignee'],
  allowedSorts: ['createdAt', 'status'],
  defaultSort: 'createdAt',
};

test('list state parses bounded allowlisted URL values and ignores unknown fields', () => {
  const state = parseListState(
    '?q=%20%E7%8E%8B%E5%B0%8F%E6%98%8E%20&status=NEW&assignee=2&private=x&page=-3&pageSize=999&sort=unsafe&direction=sideways',
    LIST_OPTIONS,
  );
  assert.deepEqual(state, {
    keyword: '王小明',
    filters: { status: 'NEW', assignee: '2' },
    page: 1,
    pageSize: 20,
    sort: 'createdAt',
    direction: 'desc',
  });
});

test('list state serializes deterministically and restores the same state', () => {
  const state = {
    keyword: 'FTTH',
    filters: { status: 'QUALIFIED', assignee: '' },
    page: 3,
    pageSize: 50,
    sort: 'status',
    direction: 'asc',
  };
  const search = serializeListState(state, LIST_OPTIONS);
  assert.equal(search, '?q=FTTH&status=QUALIFIED&page=3&pageSize=50&sort=status&direction=asc');
  assert.deepEqual(parseListState(search, LIST_OPTIONS), {
    ...state,
    filters: { status: 'QUALIFIED' },
  });
});

test('work-order view state keeps only bounded filters and restores a selected desktop view', () => {
  const state = parseWorkOrderViewState(
    '?q=%20%E5%AE%89%E8%A3%9D%20&status=SCHEDULED&assignedStaffUserId=3&from=2026-07-22&to=2026-07-24&view=calendar&unsafe=drop',
  );
  assert.deepEqual(state, {
    keyword: '安裝',
    status: 'SCHEDULED',
    assignedStaffUserId: '3',
    from: '2026-07-22',
    to: '2026-07-24',
    view: 'calendar',
  });
  assert.equal(
    serializeWorkOrderViewState(state),
    '?q=%E5%AE%89%E8%A3%9D&status=SCHEDULED&assignedStaffUserId=3&from=2026-07-22&to=2026-07-24&view=calendar',
  );
  assert.equal(
    buildWorkOrderRequestSearch(state),
    '?q=%E5%AE%89%E8%A3%9D&status=SCHEDULED&assignedStaffUserId=3&from=2026-07-21T16%3A00%3A00.000Z&to=2026-07-24T16%3A00%3A00.000Z',
  );
});

test('work-order view state rejects unknown views, invalid staff identifiers, and date ranges beyond 31 days', () => {
  const state = parseWorkOrderViewState(
    `?q=${'x'.repeat(120)}&status=unsafe&assignedStaffUserId=-1&from=2026-07-01&to=2026-08-31&view=unsafe`,
  );
  assert.deepEqual(state, {
    keyword: 'x'.repeat(100),
    status: '',
    assignedStaffUserId: '',
    from: '2026-07-01',
    to: '2026-07-31',
    view: 'queue',
  });
});

test('global search exposes only fixed modules that the current role may read', () => {
  assert.deepEqual(
    globalSearchModulesForPermissions(['billing.manage']).map(({ id, label }) => ({ id, label })),
    [{ id: 'invoices', label: '帳單' }],
  );
  assert.deepEqual(
    globalSearchModulesForPermissions(['operations.manage']).map(({ id, label }) => ({ id, label })),
    [
      { id: 'work-orders', label: '工單' },
      { id: 'outages', label: '障礙事件' },
    ],
  );
  assert.deepEqual(globalSearchModulesForPermissions(['audit.read']), []);
});

test('global search normalizes an allowed query without exceeding the API limit', () => {
  assert.equal(normalizeGlobalSearchQuery('  FTTH  '), 'FTTH');
  assert.equal(normalizeGlobalSearchQuery('x'.repeat(120)), 'x'.repeat(100));
  assert.equal(normalizeGlobalSearchQuery(null), '');
});

test('customer export keeps only active reviewed filters in the bounded API query', () => {
  assert.equal(
    buildCustomerExportSearch({
      q: `  FTTH ${'x'.repeat(120)}  `,
      customerType: 'BUSINESS',
      status: 'ACTIVE',
    }),
    `?${new URLSearchParams({ q: `FTTH ${'x'.repeat(95)}`, customerType: 'BUSINESS', status: 'ACTIVE' })}`,
  );
  assert.equal(
    buildCustomerExportSearch({ q: 'Name', customerType: 'UNSAFE', status: 'UNKNOWN' }),
    '?q=Name',
  );
});

test('customer export returns to safe login after authentication or export permission loss', () => {
  assert.equal(requiresCustomerExportRelogin(new AdminApiError(401, 'AUTHENTICATION_REQUIRED', 'expired')), true);
  assert.equal(requiresCustomerExportRelogin(new AdminApiError(403, 'PERMISSION_DENIED', 'revoked')), true);
  assert.equal(requiresCustomerExportRelogin(new AdminApiError(422, 'INVALID_QUERY', 'invalid')), false);
});

test('customer export converts malformed error envelopes into a safe actionable failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('null', {
    status: 502,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(
      () => downloadAdminCustomerExport('?status=ACTIVE'),
      (error) => error instanceof AdminApiError
        && error.code === 'EXPORT_FAILED'
        && error.message === '客戶匯出失敗，未建立檔案。',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('operational report filters serialize only complete bounded date ranges', () => {
  assert.equal(buildOperationalReportSearch({ from: '2026-07-01', to: '2026-07-31' }), '?from=2026-07-01&to=2026-07-31');
  assert.equal(buildOperationalReportSearch({ from: '', to: '' }), '');
  assert.throws(
    () => buildOperationalReportSearch({ from: '2026-07-01', to: '' }),
    /開始與結束日期必須同時提供。/,
  );
  assert.throws(
    () => buildOperationalReportSearch({ from: '2026-07-31', to: '2026-07-01' }),
    /結束日期不可早於開始日期。/,
  );
  assert.throws(
    () => buildOperationalReportSearch({ from: '2026-07-01', to: '2026-08-01' }),
    /日期區間不可超過 31 天。/,
  );
});

test('notification links use only their matching currently authorized workspace', () => {
  assert.equal(isAuthorizedNotificationHref('#operations', ['operations.manage']), true);
  assert.equal(isAuthorizedNotificationHref('#billing', ['operations.manage']), false);
  assert.equal(isAuthorizedNotificationHref('#inventory?all=true', ['inventory.manage']), false);
  assert.equal(isAuthorizedNotificationHref('https://example.test', ['catalog.manage']), false);
});

test('system health projection keeps only reviewed database states and timestamp', () => {
  assert.deepEqual(normalizeSystemHealth({
    status: 'ok',
    databases: { metadata: 'ok', telecom: 'unavailable' },
    checkedAt: '2026-08-17T03:00:00.000Z',
    databasePath: 'must-not-render',
  }), {
    overall: '需要處理',
    checkedAt: '2026-08-17T03:00:00.000Z',
    databases: [
      { key: 'metadata', label: '網站中繼資料庫', status: '正常' },
      { key: 'telecom', label: '營運資料庫', status: '暫時無法使用' },
    ],
  });
  assert.deepEqual(normalizeSystemHealth({ status: 'unexpected', databases: {}, checkedAt: 'bad' }), {
    overall: '需要處理',
    checkedAt: '未提供',
    databases: [
      { key: 'metadata', label: '網站中繼資料庫', status: '狀態未確認' },
      { key: 'telecom', label: '營運資料庫', status: '狀態未確認' },
    ],
  });
});

test('submission gate rejects duplicate work and resets after success or failure', async () => {
  let release;
  const gate = createSubmissionGate();
  const first = gate.run(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(gate.pending, true);
  assert.deepEqual(await gate.run(async () => 'duplicate'), { accepted: false });
  release('saved');
  assert.deepEqual(await first, { accepted: true, value: 'saved' });
  assert.equal(gate.pending, false);
  await assert.rejects(() => gate.run(async () => { throw new Error('failed'); }), /failed/);
  assert.equal(gate.pending, false);
});

test('field errors are normalized through an explicit field allowlist', () => {
  assert.deepEqual(normalizeFieldErrors([
    { field: 'phone', message: '電話格式不正確' },
    { field: 'role', message: '角色不可用' },
    { field: 'identityHash', message: 'private' },
    { field: 'phone', message: '' },
  ], ['phone', 'role']), [
    { field: 'phone', message: '電話格式不正確' },
    { field: 'role', message: '角色不可用' },
  ]);
});

test('staff creation validation identifies every invalid field with an actionable correction', () => {
  assert.deepEqual(validateStaffCreation({
    staffNo: 'dev ops',
    email: 'invalid-email',
    displayName: '',
    department: '部'.repeat(101),
    authProvider: 'PASSWORD',
    providerSubject: 'contains whitespace',
    roleIds: [],
  }), [
    { field: 'staffNo', message: '請使用 2 至 32 碼大寫英數字、連字號或底線，例如 DEV-OPS。' },
    { field: 'email', message: '請輸入完整 Email，例如 name@example.com。' },
    { field: 'displayName', message: '請輸入顯示名稱，最多 100 字。' },
    { field: 'department', message: '部門最多 100 字，請縮短內容。' },
    { field: 'authProvider', message: '請選擇 GOOGLE、LDAP 或 OTHER。' },
    { field: 'providerSubject', message: '不可包含空白；本機測試可使用 dev:operations。' },
    { field: 'roleIds', message: '請至少選擇一個已啟用的初始角色。' },
  ]);
});

test('status presentation always pairs tone with readable text', () => {
  assert.deepEqual(statusPresentation('COMPLETED'), { tone: 'success', label: '已完成' });
  assert.deepEqual(statusPresentation('IN_PROGRESS'), { tone: 'progress', label: '處理中' });
  assert.deepEqual(statusPresentation('OVERDUE'), { tone: 'danger', label: '已逾期' });
  assert.deepEqual(statusPresentation('CUSTOM_STATE'), { tone: 'neutral', label: 'CUSTOM STATE' });
});

test('dialog focus index wraps forward and backward', () => {
  assert.equal(nextDialogFocusIndex(2, 3, false), 0);
  assert.equal(nextDialogFocusIndex(0, 3, true), 2);
  assert.equal(nextDialogFocusIndex(1, 3, false), 2);
});

test('tab activation exposes exactly one panel and maintains roving tabindex', () => {
  const tabs = [
    { attributes: new Map(), focusCalled: false },
    { attributes: new Map(), focusCalled: false },
  ].map((tab) => ({
    ...tab,
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { this.focusCalled = true; },
  }));
  const panels = [{ hidden: false }, { hidden: true }];

  assert.equal(activateTab({ tabs, panels, selectedIndex: 1, focus: true }), true);
  assert.deepEqual(tabs.map((tab) => tab.attributes.get('aria-selected')), ['false', 'true']);
  assert.deepEqual(tabs.map((tab) => tab.attributes.get('tabindex')), ['-1', '0']);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
  assert.equal(tabs[1].focusCalled, true);
  assert.equal(activateTab({ tabs, panels, selectedIndex: 4 }), false);
});

test('dirty tracker warns before leaving and resets after save', () => {
  const listeners = new Map();
  const form = { addEventListener(type, listener) { listeners.set(type, listener); } };
  const prompts = [];
  const tracker = createDirtyTracker({
    form,
    confirmLeave(message) { prompts.push(message); return false; },
  });

  assert.equal(tracker.confirmNavigation(), true);
  listeners.get('input')();
  assert.equal(tracker.dirty, true);
  assert.equal(tracker.confirmNavigation(), false);
  assert.equal(prompts.length, 1);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  tracker.handleBeforeUnload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
  tracker.markSaved();
  assert.equal(tracker.dirty, false);
});
