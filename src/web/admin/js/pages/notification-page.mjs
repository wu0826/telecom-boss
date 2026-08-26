import {
  AdminApiError,
  getAdminNotifications,
  getAdminSession,
} from '../api-client.mjs?v=20260824-outage-inline-editor';

const DESTINATION_PERMISSIONS = new Map([
  ['#operations', 'operations.manage'],
  ['#billing', 'billing.manage'],
  ['#inventory', 'inventory.manage'],
  ['#products', 'catalog.manage'],
]);

const TYPE_LABELS = new Map([
  ['OVERDUE_INVOICE', '逾期帳單'],
  ['OPEN_WORK', '待處理工單'],
  ['LOW_STOCK', '低庫存'],
  ['EXPIRING_PROMOTION', '即將到期促銷'],
]);

const SEVERITY_LABELS = new Map([
  ['CRITICAL', '優先處理'],
  ['WARNING', '請注意'],
  ['INFO', '提醒'],
]);

const TYPE_DESTINATIONS = new Map([
  ['OVERDUE_INVOICE', '#billing'],
  ['OPEN_WORK', '#operations'],
  ['LOW_STOCK', '#inventory'],
  ['EXPIRING_PROMOTION', '#products'],
]);

function readableCount(total, hasMore) {
  const count = Number.isSafeInteger(total) && total >= 0 ? total : 0;
  return hasMore ? `${Math.min(count, 50)}+` : String(count);
}

function text(value, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function isAuthorizedNotificationHref(href, permissions) {
  const permission = DESTINATION_PERMISSIONS.get(href);
  return Boolean(permission && new Set(Array.isArray(permissions) ? permissions : []).has(permission));
}

function permittedNotificationTypes(permissions) {
  const permissionSet = new Set(Array.isArray(permissions) ? permissions : []);
  return new Set(
    [...DESTINATION_PERMISSIONS.entries()]
      .filter(([, permission]) => permissionSet.has(permission))
      .map(([href]) => href),
  );
}

function setBadge(toggle, badge, total, hasMore) {
  const count = readableCount(total, hasMore);
  badge.textContent = count;
  badge.hidden = count === '0';
  toggle.setAttribute('aria-label', count === '0' ? '營運通知，目前沒有待處理項目' : `營運通知，目前 ${count} 項`);
}

function notificationGroup(document, type, notifications, onNavigate) {
  const group = document.createElement('section');
  group.className = 'notification-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', TYPE_LABELS.get(type) ?? '營運通知');
  const heading = document.createElement('h3');
  heading.textContent = `${TYPE_LABELS.get(type) ?? '營運通知'}（${notifications.length}）`;
  const list = document.createElement('div');
  list.className = 'notification-group__list';
  for (const notification of notifications) {
    const item = document.createElement('article');
    item.className = `notification-item notification-item--${String(notification.severity ?? 'INFO').toLowerCase()}`;
    item.setAttribute('role', 'listitem');
    const content = document.createElement('div');
    const headingRow = document.createElement('div');
    headingRow.className = 'notification-item__heading';
    const title = document.createElement('strong');
    title.textContent = text(notification.title);
    const severity = document.createElement('span');
    severity.className = 'notification-item__severity';
    severity.textContent = SEVERITY_LABELS.get(notification.severity) ?? '提醒';
    headingRow.append(title, severity);
    const reference = document.createElement('span');
    reference.className = 'notification-item__reference';
    reference.textContent = text(notification.reference);
    const detail = document.createElement('p');
    detail.textContent = text(notification.detail);
    const occurredAt = document.createElement('time');
    occurredAt.dateTime = text(notification.occurredAt, '');
    occurredAt.textContent = text(notification.occurredAt);
    content.append(headingRow, reference, detail, occurredAt);
    const link = document.createElement('a');
    link.className = 'notification-item__action';
    link.href = notification.href;
    link.textContent = '前往處理';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void onNavigate(notification.href);
    });
    item.append(content, link);
    list.append(item);
  }
  group.append(heading, list);
  return group;
}

function normalizeNotifications(data, permissions) {
  const allowedDestinations = permittedNotificationTypes(permissions);
  const notifications = Array.isArray(data?.notifications) ? data.notifications : [];
  return notifications.filter((notification) => (
    notification
    && typeof notification === 'object'
    && TYPE_LABELS.has(notification.type)
    && typeof notification.href === 'string'
    && TYPE_DESTINATIONS.get(notification.type) === notification.href
    && allowedDestinations.has(notification.href)
    && isAuthorizedNotificationHref(notification.href, permissions)
  ));
}

export function createNotificationPage({
  document,
  toggle,
  badge,
  panel,
  closeButton,
  status,
  results,
  requestNotifications = getAdminNotifications,
  requestSession = getAdminSession,
  onNavigate = () => {},
  onSessionExpired = () => {},
  onPermissionsChanged = () => {},
}) {
  let permissions = [];
  let enabled = false;
  let requestVersion = 0;

  function close({ restoreFocus = true } = {}) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  }

  function clearResults(message = '') {
    results.replaceChildren();
    results.setAttribute('aria-busy', 'false');
    status.textContent = message;
  }

  function render(data) {
    const notifications = normalizeNotifications(data, permissions);
    results.replaceChildren();
    if (notifications.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = '目前沒有需要處理的營運通知。';
      results.append(empty);
      return 0;
    }
    const groups = new Map();
    for (const notification of notifications) {
      const group = groups.get(notification.type) ?? [];
      group.push(notification);
      groups.set(notification.type, group);
    }
    for (const type of TYPE_LABELS.keys()) {
      const group = groups.get(type);
      if (group) results.append(notificationGroup(document, type, group, navigate));
    }
    return notifications.length;
  }

  async function load() {
    if (!enabled) return;
    const version = ++requestVersion;
    results.setAttribute('aria-busy', 'true');
    status.textContent = '正在整理目前角色可處理的營運通知…';
    try {
      const data = await requestNotifications();
      if (!enabled || version !== requestVersion) return;
      const renderedCount = render(data);
      setBadge(toggle, badge, data?.total, data?.hasMore === true);
      status.textContent = renderedCount === 0
        ? '目前角色沒有待處理的營運通知。'
        : `資料截至 ${text(data?.asOf)}；共 ${readableCount(data?.total, data?.hasMore === true)} 項受權通知。`;
    } catch (error) {
      if (!enabled || version !== requestVersion) return;
      if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
        clearResults('工作階段已失效，請重新登入。');
        await onSessionExpired();
        return;
      }
      results.replaceChildren();
      const failure = document.createElement('p');
      failure.className = 'notification-error';
      failure.textContent = '通知暫時無法載入。請關閉後重新開啟通知面板。';
      results.append(failure);
      status.textContent = '通知載入失敗；沒有顯示舊資料。';
      setBadge(toggle, badge, 0, false);
    } finally {
      if (version === requestVersion) results.setAttribute('aria-busy', 'false');
    }
  }

  async function navigate(href) {
    try {
      const session = await requestSession();
      permissions = Array.isArray(session?.permissions) ? session.permissions : [];
      if (!isAuthorizedNotificationHref(href, permissions)) {
        results.replaceChildren();
        setBadge(toggle, badge, 0, false);
        status.textContent = '你的權限已變更，未開啟目標工作區。';
        await onPermissionsChanged(permissions);
        return;
      }
      close({ restoreFocus: false });
      onNavigate(href);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
        clearResults('工作階段已失效，請重新登入。');
        await onSessionExpired();
        return;
      }
      results.replaceChildren();
      setBadge(toggle, badge, 0, false);
      status.textContent = '無法確認目前權限，未開啟目標工作區。';
    }
  }

  toggle.addEventListener('click', () => {
    if (panel.hidden) {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      closeButton.focus();
      void load();
    } else {
      close();
    }
  });
  closeButton.addEventListener('click', () => close());
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  });

  return {
    configure(nextPermissions) {
      permissions = Array.isArray(nextPermissions) ? nextPermissions : [];
      enabled = [...DESTINATION_PERMISSIONS.values()].some((permission) => permissions.includes(permission));
      requestVersion += 1;
      close({ restoreFocus: false });
      clearResults();
      toggle.disabled = !enabled;
      setBadge(toggle, badge, 0, false);
      if (enabled) void load();
    },
    clear() {
      enabled = false;
      permissions = [];
      requestVersion += 1;
      close({ restoreFocus: false });
      clearResults();
      toggle.disabled = true;
      setBadge(toggle, badge, 0, false);
    },
  };
}
