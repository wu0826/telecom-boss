import {
  AdminApiError,
  clearAdminSession,
  getAdminBootstrap,
  getAdminSession,
  getDevelopmentUsers,
  getSystemHealth,
  loginDevelopmentUser,
  loginPasswordUser,
  logoutAdmin,
} from './api-client.mjs?v=20260824-outage-inline-editor';
import { createDialogController } from './components.mjs';
import { showFormErrors } from './form-controller.mjs';
import { createDashboardPage } from './pages/dashboard-page.mjs?v=20260824-outage-inline-editor';
import { createOperationalReportPage } from './pages/report-page.mjs?v=20260824-outage-inline-editor';
import { createNotificationPage } from './pages/notification-page.mjs?v=20260824-outage-inline-editor';
import { createSystemPage } from './pages/system-page.mjs?v=20260824-outage-inline-editor';
import { createCustomerPage } from './pages/customer-page.mjs?v=20260824-outage-inline-editor';
import { createInquiryPage } from './pages/inquiry-page.mjs?v=20260824-outage-inline-editor';
import { createPlanPage } from './pages/plan-page.mjs?v=20260824-outage-inline-editor';
import { createProductPage } from './pages/product-page.mjs?v=20260824-outage-inline-editor';
import { createOrderPage } from './pages/order-page.mjs?v=20260824-outage-inline-editor';
import { createWorkOrderPage } from './pages/work-order-page.mjs?v=20260824-outage-inline-editor';
import { createGlobalSearch } from './pages/global-search-page.mjs?v=20260824-outage-inline-editor';
import { createSubscriptionPage } from './pages/subscription-page.mjs?v=20260824-outage-inline-editor';
import { createOutagePage } from './pages/outage-page.mjs?v=20260824-outage-inline-editor';
import { createInvoicePage } from './pages/invoice-page.mjs?v=20260824-outage-inline-editor';
import { createInventoryPage } from './pages/inventory-page.mjs?v=20260824-outage-inline-editor';
import { createContentPage } from './pages/content-page.mjs?v=20260824-outage-inline-editor';
import { createAccessPage } from './pages/access-page.mjs?v=20260824-outage-inline-editor';

const MODULES = [
  { label: '儀表板', href: '#dashboard', permissions: [] },
  { label: '營運報表', href: '#reports', permissions: ['customer.read', 'operations.manage', 'billing.manage', 'inventory.manage', 'catalog.manage'] },
  { label: '系統健康', href: '#system', permissions: ['access.manage', 'audit.read'] },
  { label: '客戶與業務', href: '#inquiries', permissions: ['customer.read', 'customer.write'] },
  { label: '客戶管理', href: '#customers', permissions: ['customer.read', 'customer.write'] },
  { label: '方案與行銷', href: '#catalog', permissions: ['catalog.manage'] },
  { label: '商品上架', href: '#products', permissions: ['catalog.manage'] },
  { label: '訂單與合約', href: '#orders', permissions: ['order.manage'] },
  { label: '服務合約', href: '#subscriptions', permissions: ['order.manage'] },
  { label: '裝機與維運', href: '#operations', permissions: ['operations.manage'] },
  { label: '障礙事件', href: '#outages', permissions: ['operations.manage'] },
  { label: '帳務與收款', href: '#billing', permissions: ['billing.manage'] },
  { label: '庫存與設備', href: '#inventory', permissions: ['inventory.manage'] },
  { label: '網站內容', href: '#content', permissions: ['content.manage'] },
  { label: '存取與稽核', href: '#access', permissions: ['access.manage', 'audit.read'] },
];

const elements = Object.fromEntries([
  'admin-main', 'admin-navigation', 'admin-topbar', 'admin-workspace', 'current-user-name',
  'breadcrumb-current', 'current-user-role', 'dashboard-cards', 'dashboard-page',
  'dashboard-refresh', 'dashboard-status',
  'report-page', 'report-filter-form', 'report-from', 'report-to', 'report-refresh', 'report-clear',
  'report-status', 'report-results',
  'system-page', 'system-refresh', 'system-status', 'system-results', 'system-recovery',
  'development-account', 'development-login', 'development-login-tools', 'development-login-form',
  'development-login-button', 'login-identifier', 'login-password', 'global-status',
  'global-search-form', 'global-search-input', 'global-search-results', 'global-search-status',
  'notification-toggle', 'notification-badge', 'notification-panel', 'notification-close',
  'notification-status', 'notification-results',
  'health-status', 'login-button', 'login-form', 'login-status', 'logout-button',
  'login-errors', 'logout-cancel', 'logout-confirm', 'logout-dialog',
  'inquiry-assignee-filter', 'inquiry-channel-filter', 'inquiry-clear', 'inquiry-detail',
  'inquiry-assignee', 'inquiry-expected-updated-at',
  'inquiry-detail-close', 'inquiry-detail-fields', 'inquiry-detail-status',
  'inquiry-direction', 'inquiry-filter-form', 'inquiry-from-filter', 'inquiry-list-status',
  'inquiry-next', 'inquiry-page', 'inquiry-page-size', 'inquiry-page-summary',
  'inquiry-plan-filter', 'inquiry-previous', 'inquiry-q', 'inquiry-refresh',
  'inquiry-results', 'inquiry-results-body', 'inquiry-sort', 'inquiry-status-filter',
  'inquiry-to-filter', 'navigation-toggle', 'permission-count', 'permission-navigation',
  'inquiry-next-status', 'inquiry-workflow-form', 'inquiry-workflow-status',
  'inquiry-workflow-submit',
  'inquiry-conversion-form', 'inquiry-conversion-mode', 'inquiry-existing-customer-field',
  'inquiry-create-location', 'inquiry-conversion-location-fields',
  'inquiry-conversion-submit', 'inquiry-conversion-status',
  'customer-page', 'customer-refresh', 'customer-filter-form', 'customer-results',
  'customer-results-body', 'customer-list-status', 'customer-export', 'customer-export-status', 'customer-clear', 'customer-create-panel',
  'customer-create-form', 'customer-create-status', 'customer-detail', 'customer-detail-status',
  'customer-detail-close', 'customer-profile-form', 'customer-sensitive', 'customer-contact-list',
  'customer-contact-form', 'customer-location-list', 'customer-location-form',
  'plan-page', 'plan-refresh', 'plan-filter-form', 'plan-results', 'plan-results-body',
  'plan-list-status', 'plan-clear', 'plan-create-form', 'plan-create-status', 'plan-detail',
  'plan-detail-status', 'plan-detail-close', 'plan-edit-form', 'plan-preview', 'plan-publish',
  'plan-unpublish', 'plan-delete',
  'plan-price-list', 'plan-price-form', 'plan-price-status', 'plan-price-reset',
  'plan-price-delete',
  'product-page', 'product-refresh', 'product-filter-form', 'product-clear', 'product-list-status',
  'product-results', 'product-results-body', 'product-category-tree', 'product-category-status',
  'product-category-selected', 'product-category-create-form', 'product-category-create-errors',
  'product-category-create-status', 'product-category-edit-form', 'product-category-edit-errors',
  'product-category-edit-status', 'product-category-move-form', 'product-category-move-errors',
  'product-category-move-status', 'product-category-parent', 'product-category-move-parent',
  'product-create-form', 'product-create-errors', 'product-create-status', 'product-create-category',
  'product-detail', 'product-detail-close', 'product-detail-status', 'product-edit-form',
  'product-edit-errors', 'product-edit-category', 'product-preview', 'product-publish', 'product-archive',
  'product-delete', 'product-action-dialog', 'product-action-dialog-message', 'product-action-dialog-help',
  'product-action-cancel', 'product-action-confirm',
  'order-page', 'order-refresh', 'order-results', 'order-results-body', 'order-list-status',
  'order-create-form', 'order-create-status', 'order-detail', 'order-detail-fields',
  'order-detail-items', 'order-detail-status', 'order-detail-close', 'order-use-references',
  'order-submit', 'order-approve', 'order-cancel', 'order-work-order-link',
  'work-order-page', 'work-order-refresh', 'work-order-clear', 'work-order-filter-form', 'work-order-view-tabs',
  'work-order-groups', 'work-order-list-status', 'work-order-create-form',
  'work-order-create-status', 'work-order-detail', 'work-order-detail-fields',
  'work-order-detail-status', 'work-order-detail-close', 'work-order-history',
  'work-order-assign-form', 'work-order-schedule-form', 'work-order-start',
  'work-order-complete-form', 'work-order-cancel-form',
  'subscription-page', 'subscription-refresh', 'subscription-clear',
  'subscription-filter-form', 'subscription-results', 'subscription-results-body',
  'subscription-list-status', 'subscription-detail', 'subscription-detail-status',
  'subscription-detail-close', 'subscription-tabs', 'subscription-overview-fields',
  'subscription-source-links', 'subscription-account-form', 'subscription-account-status',
  'subscription-history', 'subscription-lifecycle-actions',
  'outage-page', 'outage-refresh', 'outage-clear', 'outage-filter-form',
  'outage-results', 'outage-results-body', 'outage-list-status', 'outage-create-form',
  'outage-create-status', 'outage-detail', 'outage-detail-status', 'outage-detail-close',
  'outage-detail-fields', 'outage-membership-form', 'outage-memberships',
  'outage-public-draft', 'outage-workflow-actions',
  'invoice-page', 'invoice-refresh', 'invoice-clear', 'invoice-filter-form',
  'invoice-results', 'invoice-results-body', 'invoice-list-status',
  'invoice-generate-form', 'invoice-generate-status', 'invoice-batch-form',
  'invoice-batch-status', 'invoice-detail', 'invoice-detail-close',
  'invoice-detail-status', 'invoice-detail-fields', 'invoice-items', 'invoice-actions',
  'payment-form', 'payment-status', 'payment-history', 'adjustment-form',
  'adjustment-status', 'adjustment-history', 'billing-approval',
  'billing-approval-refresh', 'billing-approval-status', 'billing-approval-list',
  'inventory-page', 'inventory-refresh', 'inventory-status', 'inventory-balance-body',
  'inventory-item-list', 'inventory-warehouse-list', 'inventory-movement-list',
  'inventory-movement-form', 'inventory-movement-status', 'inventory-item-form',
  'inventory-item-status', 'inventory-warehouse-form', 'inventory-warehouse-status',
  'content-page', 'content-refresh', 'content-status', 'content-form', 'content-form-title',
  'content-cancel-edit', 'content-list', 'content-preview',
  'access-page', 'access-refresh', 'access-status', 'access-administration',
  'access-create-panel', 'access-create-form', 'access-create-errors', 'access-create-roles',
  'access-delete-zone', 'access-delete', 'access-delete-help', 'access-delete-dialog',
  'access-delete-message', 'access-delete-cancel', 'access-delete-confirm',
  'access-staff-list', 'access-role-matrix', 'access-profile-form', 'access-role-form',
  'audit-section', 'audit-filter-form', 'audit-list', 'audit-detail',
  'summary-permissions', 'summary-role', 'workspace-eyebrow', 'workspace-title',
  'workspace-welcome',
].map((id) => [id, document.getElementById(id)]));

let currentPermissions = [];
let currentUserId = null;

function setText(element, value) {
  element.textContent = value ?? '';
}

function visibleModules(permissions) {
  const permissionSet = new Set(permissions);
  return MODULES.filter((module) => (
    module.permissions.length === 0
    || module.permissions.some((permission) => permissionSet.has(permission))
  ));
}

function closeNavigation() {
  document.body.removeAttribute('data-navigation-open');
  elements['navigation-toggle'].setAttribute('aria-expanded', 'false');
  elements['navigation-toggle'].setAttribute('aria-label', '開啟後台選單');
}

function renderNavigation(permissions) {
  const modules = visibleModules(permissions);
  elements['permission-navigation'].replaceChildren();
  for (const module of modules) {
    const link = document.createElement('a');
    link.href = module.href;
    link.textContent = module.label;
    elements['permission-navigation'].append(link);

  }
  setText(elements['permission-count'], `目前顯示 ${modules.length} 個模組`);
}

function renderAuthenticated(session) {
  currentPermissions = session.permissions;
  currentUserId = session.user.id;
  const roleNames = session.roles.map((role) => role.name).join('、') || '未指派角色';
  elements['development-login'].hidden = true;
  elements['admin-topbar'].hidden = false;
  elements['admin-navigation'].hidden = false;
  elements['admin-workspace'].hidden = false;
  setText(elements['current-user-name'], session.user.displayName);
  setText(elements['current-user-role'], roleNames);
  setText(elements['summary-role'], roleNames);
  setText(elements['summary-permissions'], `${session.permissions.length} 項`);
  setText(elements['workspace-welcome'], `${session.user.displayName}，以下功能已依目前角色開放。`);
  renderNavigation(session.permissions);
  globalSearch.configure(session.permissions);
  notificationPage.configure(session.permissions);
  setText(elements['global-status'], `已使用 ${session.user.displayName} 登入`);
  elements['workspace-title'].focus();
  void renderRoute();
  void refreshHealth();
}

function renderLogin(message = '請使用員工編號或公司信箱登入。') {
  clearAdminSession();
  globalSearch.clear();
  notificationPage.clear();
  currentUserId = null;
  closeNavigation();
  elements['admin-topbar'].hidden = true;
  elements['admin-navigation'].hidden = true;
  elements['admin-workspace'].hidden = true;
  elements['development-login'].hidden = false;
  dashboardPage.clear();
  reportPage.hide();
  systemPage.hide();
  inquiryPage.hide();
  customerPage.hide();
  planPage.hide();
  productPage.hide();
  orderPage.hide();
  workOrderPage.hide();
  subscriptionPage.hide();
  outagePage.hide();
  invoicePage.hide();
  inventoryPage.hide();
  contentPage.hide();
  accessPage.hide();
  setText(elements['login-status'], message);
  elements['login-identifier'].focus();
}

async function loadDevelopmentUsers() {
  elements['development-account'].disabled = true;
  elements['development-login-button'].disabled = true;
  elements['development-login-tools'].hidden = true;
  try {
    const { users } = await getDevelopmentUsers();
    elements['development-account'].replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = '請選擇測試帳號';
    elements['development-account'].append(prompt);
    for (const user of users) {
      const option = document.createElement('option');
      option.value = String(user.id);
      option.textContent = `${user.displayName}｜${user.department ?? '未設定部門'}`;
      elements['development-account'].append(option);
    }
    elements['development-account'].disabled = false;
    elements['development-login-button'].disabled = false;
    elements['development-login-tools'].hidden = false;
  } catch (error) {
    if (!(error instanceof AdminApiError && error.code === 'DEVELOPMENT_LOGIN_DISABLED')) {
      setText(elements['login-status'], '正式登入可用；開發測試帳號載入失敗。');
    }
  }
}

async function refreshHealth() {
  try {
    await getSystemHealth();
    elements['health-status'].classList.add('is-healthy');
    setText(elements['health-status'], '● 系統正常');
  } catch {
    elements['health-status'].classList.remove('is-healthy');
    setText(elements['health-status'], '！系統狀態異常');
  }
}

const dashboardPage = createDashboardPage({
  document,
  region: elements['dashboard-cards'],
  status: elements['dashboard-status'],
  refreshButton: elements['dashboard-refresh'],
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const reportPage = createOperationalReportPage({
  document,
  page: elements['report-page'],
  form: elements['report-filter-form'],
  fromInput: elements['report-from'],
  toInput: elements['report-to'],
  refreshButton: elements['report-refresh'],
  clearButton: elements['report-clear'],
  status: elements['report-status'],
  region: elements['report-results'],
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const systemPage = createSystemPage({
  document,
  page: elements['system-page'],
  refreshButton: elements['system-refresh'],
  status: elements['system-status'],
  results: elements['system-results'],
  recovery: elements['system-recovery'],
});

const globalSearch = createGlobalSearch({
  document,
  form: elements['global-search-form'],
  input: elements['global-search-input'],
  results: elements['global-search-results'],
  status: elements['global-search-status'],
  onNavigate(href) {
    location.hash = href;
  },
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const notificationPage = createNotificationPage({
  document,
  toggle: elements['notification-toggle'],
  badge: elements['notification-badge'],
  panel: elements['notification-panel'],
  closeButton: elements['notification-close'],
  status: elements['notification-status'],
  results: elements['notification-results'],
  onNavigate(href) {
    location.hash = href;
  },
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
  async onPermissionsChanged(nextPermissions) {
    currentPermissions = nextPermissions;
    renderNavigation(nextPermissions);
    globalSearch.configure(nextPermissions);
    notificationPage.configure(nextPermissions);
    await renderRoute();
  },
});

const inquiryPage = createInquiryPage({
  document,
  location,
  history,
  page: elements['inquiry-page'],
  form: elements['inquiry-filter-form'],
  results: elements['inquiry-results'],
  resultsBody: elements['inquiry-results-body'],
  listStatus: elements['inquiry-list-status'],
  pageSummary: elements['inquiry-page-summary'],
  previousButton: elements['inquiry-previous'],
  nextButton: elements['inquiry-next'],
  refreshButton: elements['inquiry-refresh'],
  clearButton: elements['inquiry-clear'],
  detail: elements['inquiry-detail'],
  detailFields: elements['inquiry-detail-fields'],
  detailStatus: elements['inquiry-detail-status'],
  detailClose: elements['inquiry-detail-close'],
  workflowForm: elements['inquiry-workflow-form'],
  assigneeSelect: elements['inquiry-assignee'],
  nextStatusSelect: elements['inquiry-next-status'],
  expectedUpdatedAtInput: elements['inquiry-expected-updated-at'],
  workflowSubmit: elements['inquiry-workflow-submit'],
  workflowStatus: elements['inquiry-workflow-status'],
  conversionForm: elements['inquiry-conversion-form'],
  conversionMode: elements['inquiry-conversion-mode'],
  existingCustomerField: elements['inquiry-existing-customer-field'],
  createLocationCheckbox: elements['inquiry-create-location'],
  conversionLocationFields: elements['inquiry-conversion-location-fields'],
  conversionSubmit: elements['inquiry-conversion-submit'],
  conversionStatus: elements['inquiry-conversion-status'],
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const customerPage = createCustomerPage({
  document,
  page: elements['customer-page'],
  filterForm: elements['customer-filter-form'],
  results: elements['customer-results'],
  resultsBody: elements['customer-results-body'],
  listStatus: elements['customer-list-status'],
  refreshButton: elements['customer-refresh'],
  exportButton: elements['customer-export'],
  exportStatus: elements['customer-export-status'],
  clearButton: elements['customer-clear'],
  createPanel: elements['customer-create-panel'],
  createForm: elements['customer-create-form'],
  createStatus: elements['customer-create-status'],
  detail: elements['customer-detail'],
  detailStatus: elements['customer-detail-status'],
  detailClose: elements['customer-detail-close'],
  profileForm: elements['customer-profile-form'],
  sensitiveButton: elements['customer-sensitive'],
  contactList: elements['customer-contact-list'],
  contactForm: elements['customer-contact-form'],
  locationList: elements['customer-location-list'],
  locationForm: elements['customer-location-form'],
  async onSessionExpired() {
    renderLogin('工作階段已失效，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const planPage = createPlanPage({
  document,
  page: elements['plan-page'],
  filterForm: elements['plan-filter-form'],
  results: elements['plan-results'],
  resultsBody: elements['plan-results-body'],
  listStatus: elements['plan-list-status'],
  refreshButton: elements['plan-refresh'],
  clearButton: elements['plan-clear'],
  createForm: elements['plan-create-form'],
  createStatus: elements['plan-create-status'],
  detail: elements['plan-detail'],
  detailStatus: elements['plan-detail-status'],
  detailClose: elements['plan-detail-close'],
  editForm: elements['plan-edit-form'],
  preview: elements['plan-preview'],
  publishButton: elements['plan-publish'],
  unpublishButton: elements['plan-unpublish'],
  deleteButton: elements['plan-delete'],
  priceList: elements['plan-price-list'],
  priceForm: elements['plan-price-form'],
  priceStatus: elements['plan-price-status'],
  priceResetButton: elements['plan-price-reset'],
  priceDeleteButton: elements['plan-price-delete'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const productPage = createProductPage({
  document,
  page: elements['product-page'],
  refreshButton: elements['product-refresh'],
  filterForm: elements['product-filter-form'],
  clearButton: elements['product-clear'],
  listStatus: elements['product-list-status'],
  results: elements['product-results'],
  resultsBody: elements['product-results-body'],
  categoryTree: elements['product-category-tree'],
  categoryStatus: elements['product-category-status'],
  categorySelected: elements['product-category-selected'],
  categoryCreateForm: elements['product-category-create-form'],
  categoryCreateErrors: elements['product-category-create-errors'],
  categoryCreateStatus: elements['product-category-create-status'],
  categoryEditForm: elements['product-category-edit-form'],
  categoryEditErrors: elements['product-category-edit-errors'],
  categoryEditStatus: elements['product-category-edit-status'],
  categoryMoveForm: elements['product-category-move-form'],
  categoryMoveErrors: elements['product-category-move-errors'],
  categoryMoveStatus: elements['product-category-move-status'],
  categoryParentSelect: elements['product-category-parent'],
  categoryMoveParentSelect: elements['product-category-move-parent'],
  createForm: elements['product-create-form'],
  createErrors: elements['product-create-errors'],
  createStatus: elements['product-create-status'],
  createCategorySelect: elements['product-create-category'],
  detail: elements['product-detail'],
  detailClose: elements['product-detail-close'],
  detailStatus: elements['product-detail-status'],
  editForm: elements['product-edit-form'],
  editErrors: elements['product-edit-errors'],
  editCategorySelect: elements['product-edit-category'],
  preview: elements['product-preview'],
  publishButton: elements['product-publish'],
  archiveButton: elements['product-archive'],
  deleteButton: elements['product-delete'],
  actionDialog: elements['product-action-dialog'],
  actionDialogMessage: elements['product-action-dialog-message'],
  actionDialogHelp: elements['product-action-dialog-help'],
  actionCancelButton: elements['product-action-cancel'],
  actionConfirmButton: elements['product-action-confirm'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const orderPage = createOrderPage({
  document,
  page: elements['order-page'],
  refreshButton: elements['order-refresh'],
  results: elements['order-results'],
  resultsBody: elements['order-results-body'],
  listStatus: elements['order-list-status'],
  createForm: elements['order-create-form'],
  createStatus: elements['order-create-status'],
  detail: elements['order-detail'],
  detailFields: elements['order-detail-fields'],
  detailItems: elements['order-detail-items'],
  detailStatus: elements['order-detail-status'],
  detailClose: elements['order-detail-close'],
  useReferencesButton: elements['order-use-references'],
  submitButton: elements['order-submit'],
  approveButton: elements['order-approve'],
  cancelButton: elements['order-cancel'],
  workOrderLink: elements['order-work-order-link'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const workOrderPage = createWorkOrderPage({
  document,
  location,
  history,
  page: elements['work-order-page'],
  filterForm: elements['work-order-filter-form'],
  refreshButton: elements['work-order-refresh'],
  clearButton: elements['work-order-clear'],
  viewTabs: elements['work-order-view-tabs'],
  groups: elements['work-order-groups'],
  listStatus: elements['work-order-list-status'],
  createForm: elements['work-order-create-form'],
  createStatus: elements['work-order-create-status'],
  detail: elements['work-order-detail'],
  detailFields: elements['work-order-detail-fields'],
  historyList: elements['work-order-history'],
  detailStatus: elements['work-order-detail-status'],
  detailClose: elements['work-order-detail-close'],
  assignForm: elements['work-order-assign-form'],
  scheduleForm: elements['work-order-schedule-form'],
  startButton: elements['work-order-start'],
  completeForm: elements['work-order-complete-form'],
  cancelForm: elements['work-order-cancel-form'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const subscriptionPage = createSubscriptionPage({
  document,
  page: elements['subscription-page'],
  filterForm: elements['subscription-filter-form'],
  refreshButton: elements['subscription-refresh'],
  clearButton: elements['subscription-clear'],
  results: elements['subscription-results'],
  resultsBody: elements['subscription-results-body'],
  listStatus: elements['subscription-list-status'],
  detail: elements['subscription-detail'],
  detailStatus: elements['subscription-detail-status'],
  detailClose: elements['subscription-detail-close'],
  tabs: elements['subscription-tabs'],
  panels: new Map([
    ['overview', document.getElementById('subscription-overview-panel')],
    ['sources', document.getElementById('subscription-sources-panel')],
    ['account', document.getElementById('subscription-account-panel')],
    ['history', document.getElementById('subscription-history-panel')],
  ]),
  overviewFields: elements['subscription-overview-fields'],
  sourceLinks: elements['subscription-source-links'],
  accountForm: elements['subscription-account-form'],
  accountStatus: elements['subscription-account-status'],
  historyList: elements['subscription-history'],
  lifecycleActions: elements['subscription-lifecycle-actions'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const outagePage = createOutagePage({
  document,
  page: elements['outage-page'],
  filterForm: elements['outage-filter-form'],
  refreshButton: elements['outage-refresh'],
  clearButton: elements['outage-clear'],
  results: elements['outage-results'],
  resultsBody: elements['outage-results-body'],
  listStatus: elements['outage-list-status'],
  createForm: elements['outage-create-form'],
  createStatus: elements['outage-create-status'],
  detail: elements['outage-detail'],
  detailStatus: elements['outage-detail-status'],
  detailClose: elements['outage-detail-close'],
  detailFields: elements['outage-detail-fields'],
  membershipForm: elements['outage-membership-form'],
  membershipList: elements['outage-memberships'],
  publicDraft: elements['outage-public-draft'],
  workflowActions: elements['outage-workflow-actions'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const invoicePage = createInvoicePage({
  document,
  page: elements['invoice-page'],
  refreshButton: elements['invoice-refresh'],
  clearButton: elements['invoice-clear'],
  filterForm: elements['invoice-filter-form'],
  results: elements['invoice-results'],
  resultsBody: elements['invoice-results-body'],
  listStatus: elements['invoice-list-status'],
  generateForm: elements['invoice-generate-form'],
  generateStatus: elements['invoice-generate-status'],
  batchForm: elements['invoice-batch-form'],
  batchStatus: elements['invoice-batch-status'],
  detail: elements['invoice-detail'],
  detailClose: elements['invoice-detail-close'],
  detailStatus: elements['invoice-detail-status'],
  detailFields: elements['invoice-detail-fields'],
  itemsBody: elements['invoice-items'],
  actions: elements['invoice-actions'],
  paymentForm: elements['payment-form'],
  paymentStatus: elements['payment-status'],
  paymentHistory: elements['payment-history'],
  adjustmentForm: elements['adjustment-form'],
  adjustmentStatus: elements['adjustment-status'],
  adjustmentHistory: elements['adjustment-history'],
  approval: elements['billing-approval'],
  approvalRefresh: elements['billing-approval-refresh'],
  approvalStatus: elements['billing-approval-status'],
  approvalList: elements['billing-approval-list'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const inventoryPage = createInventoryPage({
  document,
  page: elements['inventory-page'],
  refreshButton: elements['inventory-refresh'],
  status: elements['inventory-status'],
  balanceBody: elements['inventory-balance-body'],
  itemList: elements['inventory-item-list'],
  warehouseList: elements['inventory-warehouse-list'],
  movementList: elements['inventory-movement-list'],
  movementForm: elements['inventory-movement-form'],
  movementStatus: elements['inventory-movement-status'],
  itemForm: elements['inventory-item-form'],
  itemStatus: elements['inventory-item-status'],
  warehouseForm: elements['inventory-warehouse-form'],
  warehouseStatus: elements['inventory-warehouse-status'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const contentPage = createContentPage({
  document,
  page: elements['content-page'],
  refreshButton: elements['content-refresh'],
  status: elements['content-status'],
  form: elements['content-form'],
  formTitle: elements['content-form-title'],
  cancelButton: elements['content-cancel-edit'],
  list: elements['content-list'],
  preview: elements['content-preview'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

const accessPage = createAccessPage({
  document,
  page: elements['access-page'],
  status: elements['access-status'],
  refreshButton: elements['access-refresh'],
  administration: elements['access-administration'],
  createPanel: elements['access-create-panel'],
  createForm: elements['access-create-form'],
  createErrors: elements['access-create-errors'],
  createRoles: elements['access-create-roles'],
  staffList: elements['access-staff-list'],
  roleMatrix: elements['access-role-matrix'],
  profileForm: elements['access-profile-form'],
  roleForm: elements['access-role-form'],
  deleteZone: elements['access-delete-zone'],
  deleteButton: elements['access-delete'],
  deleteHelp: elements['access-delete-help'],
  deleteDialog: elements['access-delete-dialog'],
  deleteMessage: elements['access-delete-message'],
  deleteCancelButton: elements['access-delete-cancel'],
  deleteConfirmButton: elements['access-delete-confirm'],
  auditSection: elements['audit-section'],
  auditForm: elements['audit-filter-form'],
  auditList: elements['audit-list'],
  auditDetail: elements['audit-detail'],
  async onSessionExpired() {
    renderLogin('工作階段已逾時，請重新登入。');
    await loadDevelopmentUsers();
  },
});

function updateNavigationCurrent(hash) {
  for (const link of elements['permission-navigation'].querySelectorAll('a')) {
    if (link.getAttribute('href') === hash) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderRoute() {
  contentPage.hide();
  accessPage.hide();
  productPage.hide();
  reportPage.hide();
  systemPage.hide();
  const requestedHash = location.hash || '#dashboard';
  const [routeHash, routeQuery = ''] = requestedHash.split('?');
  const routeParams = new URLSearchParams(routeQuery);
  const showInquiries = routeHash === '#inquiries' && currentPermissions.includes('customer.read');
  const showReports = routeHash === '#reports' && [
    'customer.read', 'operations.manage', 'billing.manage', 'inventory.manage', 'catalog.manage',
  ].some((permission) => currentPermissions.includes(permission));
  const showSystem = routeHash === '#system'
    && (currentPermissions.includes('access.manage') || currentPermissions.includes('audit.read'));
  const showCustomers = routeHash === '#customers' && currentPermissions.includes('customer.read');
  const showCatalog = routeHash === '#catalog' && currentPermissions.includes('catalog.manage');
  const showProducts = routeHash === '#products' && currentPermissions.includes('catalog.manage');
  const showOrders = routeHash === '#orders' && currentPermissions.includes('order.manage');
  const showSubscriptions = routeHash === '#subscriptions' && currentPermissions.includes('order.manage');
  const showOperations = routeHash === '#operations' && currentPermissions.includes('operations.manage');
  const showOutages = routeHash === '#outages' && currentPermissions.includes('operations.manage');
  const showBilling = routeHash === '#billing' && currentPermissions.includes('billing.manage');
  const showInventory = routeHash === '#inventory' && currentPermissions.includes('inventory.manage');
  const showContent = routeHash === '#content' && currentPermissions.includes('content.manage');
  const showAccess = routeHash === '#access'
    && (currentPermissions.includes('access.manage') || currentPermissions.includes('audit.read'));
  if (showSystem) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '系統健康');
    setText(elements['workspace-eyebrow'], 'READ-ONLY OPERATIONS');
    setText(elements['workspace-title'], '系統健康與復原資訊');
    updateNavigationCurrent('#system');
    await systemPage.show();
  } else if (showReports) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '營運報表');
    setText(elements['workspace-eyebrow'], 'RECONCILED OPERATIONS');
    setText(elements['workspace-title'], '營運風險與資料對帳');
    updateNavigationCurrent('#reports');
    await reportPage.show();
  } else if (showInquiries) {
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '申裝洽詢');
    setText(elements['workspace-eyebrow'], 'CUSTOMER INTAKE');
    setText(elements['workspace-title'], '申裝洽詢管理');
    updateNavigationCurrent('#inquiries');
    await inquiryPage.show({
      writePermission: currentPermissions.includes('customer.write'),
      inquiryId: routeParams.get('inquiryId'),
    });
  } else if (showCustomers) {
    inquiryPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '客戶管理');
    setText(elements['workspace-eyebrow'], 'CUSTOMER DIRECTORY');
    setText(elements['workspace-title'], '客戶與服務地址');
    updateNavigationCurrent('#customers');
    await customerPage.show({
      writePermission: currentPermissions.includes('customer.write'),
      sensitivePermission: currentPermissions.includes('customer.sensitive.read'),
      customerId: routeParams.get('customerId'),
    });
  } else if (showProducts) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '商品上架');
    setText(elements['workspace-eyebrow'], 'CATALOG V2 PUBLISHING');
    setText(elements['workspace-title'], '商品上架與分類管理');
    updateNavigationCurrent('#products');
    await productPage.show({ productId: routeParams.get('productId') });
  } else if (showCatalog) {
    inquiryPage.hide();
    customerPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '方案管理');
    setText(elements['workspace-eyebrow'], 'PRODUCT CATALOG');
    setText(elements['workspace-title'], '電信方案與公開預覽');
    updateNavigationCurrent('#catalog');
    await planPage.show();
  } else if (showOrders) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '訂單與合約');
    setText(elements['workspace-eyebrow'], 'SALES ORDERS');
    setText(elements['workspace-title'], '訂單草稿與價格快照');
    updateNavigationCurrent('#orders');
    await orderPage.show({
      orderPermission: currentPermissions.includes('order.manage'),
      approvalPermission: currentPermissions.includes('operations.manage'),
      orderId: routeParams.get('orderId'),
    });
  } else if (showSubscriptions) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '服務合約');
    setText(elements['workspace-eyebrow'], 'SERVICE LIFECYCLE');
    setText(elements['workspace-title'], '合約生命週期與線路帳號');
    updateNavigationCurrent('#subscriptions');
    await subscriptionPage.show({ subscriptionId: routeParams.get('subscriptionId') });
  } else if (showOperations) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '裝機與維運');
    setText(elements['workspace-eyebrow'], 'FIELD OPERATIONS');
    setText(elements['workspace-title'], '工單佇列與現場執行');
    updateNavigationCurrent('#operations');
    await workOrderPage.show({ workOrderId: routeParams.get('workOrderId') });
  } else if (showOutages) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '障礙事件');
    setText(elements['workspace-eyebrow'], 'NETWORK INCIDENTS');
    setText(elements['workspace-title'], '障礙影響與恢復追蹤');
    updateNavigationCurrent('#outages');
    await outagePage.show({ outageId: routeParams.get('outageId') });
  } else if (showBilling) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '帳務與收款');
    setText(elements['workspace-eyebrow'], 'BILLING OPERATIONS');
    setText(elements['workspace-title'], '帳單產生、開立與作廢');
    updateNavigationCurrent('#billing');
    await invoicePage.show({
      invoiceId: routeParams.get('invoiceId'),
      approvalPermission: currentPermissions.includes('access.manage'),
    });
  } else if (showInventory) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '庫存與設備');
    setText(elements['workspace-eyebrow'], 'INVENTORY CONTROL');
    setText(elements['workspace-title'], '庫存、倉庫與客戶設備');
    updateNavigationCurrent('#inventory');
    await inventoryPage.show();
  } else if (showContent) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '網站內容');
    setText(elements['workspace-eyebrow'], 'CONTENT STUDIO');
    setText(elements['workspace-title'], '網站內容與公開排程');
    updateNavigationCurrent('#content');
    await contentPage.show({ canPublish: currentPermissions.includes('access.manage') });
  } else if (showAccess) {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = true;
    setText(elements['breadcrumb-current'], '存取與稽核');
    setText(elements['workspace-eyebrow'], 'ACCESS & AUDIT');
    setText(elements['workspace-title'], '人員、角色與稽核紀錄');
    updateNavigationCurrent('#access');
    await accessPage.show({
      canManageAccess: currentPermissions.includes('access.manage'),
      canManageRoles: currentPermissions.includes('role.manage'),
      canReadAudit: currentPermissions.includes('audit.read'),
      currentUserId,
    });
  } else {
    inquiryPage.hide();
    customerPage.hide();
    planPage.hide();
    orderPage.hide();
    workOrderPage.hide();
    subscriptionPage.hide();
    outagePage.hide();
    invoicePage.hide();
    inventoryPage.hide();
    elements['dashboard-page'].hidden = false;
    setText(elements['breadcrumb-current'], '儀表板');
    setText(elements['workspace-eyebrow'], 'OPERATIONS OVERVIEW');
    setText(elements['workspace-title'], '今日營運總覽');
    updateNavigationCurrent('#dashboard');
    await dashboardPage.load();
  }
  const detailParameters = [
    'inquiryId', 'customerId', 'productId', 'orderId', 'subscriptionId', 'workOrderId', 'outageId', 'invoiceId',
  ];
  if (!detailParameters.some((name) => /^\d+$/.test(routeParams.get(name) ?? ''))) {
    elements['workspace-title'].focus();
  }
}

elements['login-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const identifier = elements['login-identifier'].value.trim();
  const password = elements['login-password'].value;
  if (!identifier || !password) {
    showFormErrors({
      form: elements['login-form'],
      summary: elements['login-errors'],
      errors: [
        ...(!identifier ? [{ field: 'identifier', message: '請輸入員工編號或公司信箱。' }] : []),
        ...(!password ? [{ field: 'password', message: '請輸入密碼。' }] : []),
      ],
      allowedFields: ['identifier', 'password'],
    });
    return;
  }
  elements['login-button'].disabled = true;
  setText(elements['login-status'], '正在驗證帳號…');
  try {
    await loginPasswordUser(identifier, password);
    elements['login-password'].value = '';
    renderAuthenticated(await getAdminSession());
  } catch (error) {
    elements['login-password'].value = '';
    setText(elements['login-status'], error instanceof AdminApiError ? error.message : '登入失敗，請稍後重試。');
    showFormErrors({
      form: elements['login-form'],
      summary: elements['login-errors'],
      errors: error instanceof AdminApiError && error.details.length
        ? error.details
        : [{ field: 'password', message: '帳號或密碼錯誤。' }],
      allowedFields: ['identifier', 'password'],
    });
  } finally {
    elements['login-button'].disabled = false;
  }
});

elements['development-login-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const staffUserId = Number(elements['development-account'].value);
  if (!Number.isSafeInteger(staffUserId) || staffUserId < 1) return;
  elements['development-login-button'].disabled = true;
  try {
    await loginDevelopmentUser(staffUserId);
    renderAuthenticated(await getAdminSession());
  } catch (error) {
    setText(elements['login-status'], error instanceof AdminApiError ? error.message : '開發登入失敗。');
  } finally {
    elements['development-login-button'].disabled = false;
  }
});

const logoutDialog = createDialogController({
  dialog: elements['logout-dialog'],
  initialFocus: elements['logout-cancel'],
});
elements['logout-button'].addEventListener('click', () => logoutDialog.open(elements['logout-button']));
elements['logout-confirm'].addEventListener('click', async () => {
  elements['logout-confirm'].disabled = true;
  try {
    await logoutAdmin();
    logoutDialog.close();
    renderLogin('已安全登出。');
    await loadDevelopmentUsers();
  } catch {
    setText(elements['global-status'], '登出失敗，請重新整理後再試。');
  } finally {
    elements['logout-confirm'].disabled = false;
  }
});

elements['navigation-toggle'].addEventListener('click', () => {
  const isOpen = document.body.toggleAttribute('data-navigation-open');
  elements['navigation-toggle'].setAttribute('aria-expanded', String(isOpen));
  elements['navigation-toggle'].setAttribute('aria-label', isOpen ? '關閉後台選單' : '開啟後台選單');
});
elements['permission-navigation'].addEventListener('click', closeNavigation);
window.addEventListener('hashchange', () => {
  if (!elements['admin-workspace'].hidden) void renderRoute();
});

try {
  const bootstrap = await getAdminBootstrap();
  if (bootstrap.authenticated) renderAuthenticated(bootstrap);
  else renderLogin('尚未登入。');
  if (!bootstrap.authenticated) await loadDevelopmentUsers();
} catch (error) {
  renderLogin('無法確認工作階段。');
  await loadDevelopmentUsers();
}
