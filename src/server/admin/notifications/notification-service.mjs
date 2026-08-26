import { readAdminNotifications } from './notification-repository.mjs';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';
const DAY_MS = 24 * 60 * 60 * 1_000;
const PROMOTION_WINDOW_DAYS = 7;
export const NOTIFICATION_ITEM_LIMIT = 50;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const NOTIFICATION_DEFINITIONS = Object.freeze([
  {
    type: 'OVERDUE_INVOICE',
    permission: 'billing.manage',
    href: '#billing',
    title: '逾期帳單待處理',
    typeRank: 0,
  },
  {
    type: 'OPEN_WORK',
    permission: 'operations.manage',
    href: '#operations',
    title: '待處理工單',
    typeRank: 1,
  },
  {
    type: 'LOW_STOCK',
    permission: 'inventory.manage',
    href: '#inventory',
    title: '低庫存項目',
    typeRank: 2,
  },
  {
    type: 'EXPIRING_PROMOTION',
    permission: 'catalog.manage',
    href: '#products',
    title: '即將到期促銷',
    typeRank: 3,
  },
]);

const SEVERITY_RANKS = new Map([
  ['CRITICAL', 0],
  ['WARNING', 1],
  ['INFO', 2],
]);

export class AdminNotificationError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminNotificationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function taipeiDate(now) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid notification clock value');
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(date)
      .filter(({ type }) => ['year', 'month', 'day'].includes(type))
      .map(({ type, value }) => [type, Number(value)]),
  );
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function assertNoQueryParameters(params) {
  if (!(params instanceof URLSearchParams)) throw new TypeError('Notification query parameters must be URLSearchParams');
  const field = params.keys().next().value;
  if (field !== undefined) {
    throw new AdminNotificationError(422, 'INVALID_QUERY', '通知查詢條件無效。', [{
      field,
      message: '通知不接受篩選、排序或筆數參數。',
    }]);
  }
}

function workSeverity(priority) {
  if (priority === 'URGENT') return 'CRITICAL';
  if (priority === 'HIGH') return 'WARNING';
  return 'INFO';
}

function mapRows(definition, rows) {
  if (definition.type === 'OVERDUE_INVOICE') {
    return rows.map((row) => ({
      id: `invoice:${row.invoice_no}`,
      type: definition.type,
      severity: 'CRITICAL',
      title: definition.title,
      reference: row.invoice_no,
      detail: `到期日 ${row.due_date}；帳單仍有未清餘額。`,
      occurredAt: `${row.due_date}T00:00:00.000Z`,
      href: definition.href,
      typeRank: definition.typeRank,
    }));
  }
  if (definition.type === 'OPEN_WORK') {
    return rows.map((row) => ({
      id: `work-order:${row.work_order_no}`,
      type: definition.type,
      severity: workSeverity(row.priority),
      title: definition.title,
      reference: row.work_order_no,
      detail: `${row.work_type}／${row.priority}／${row.status}`,
      occurredAt: row.created_at,
      href: definition.href,
      typeRank: definition.typeRank,
    }));
  }
  if (definition.type === 'LOW_STOCK') {
    return rows.map((row) => ({
      id: `stock:${row.sku}:${row.warehouse_code}`,
      type: definition.type,
      severity: 'WARNING',
      title: definition.title,
      reference: row.sku,
      detail: `倉庫 ${row.warehouse_code}；可用量低於再訂購水位。`,
      occurredAt: row.updated_at,
      href: definition.href,
      typeRank: definition.typeRank,
    }));
  }
  return rows.map((row) => ({
    id: `promotion:${row.promotion_code}`,
    type: definition.type,
    severity: 'INFO',
    title: definition.title,
    reference: row.promotion_code,
    detail: `促銷結束時間：${row.ends_at}。`,
    occurredAt: row.ends_at,
    href: definition.href,
    typeRank: definition.typeRank,
  }));
}

function compareNotifications(left, right) {
  const severityDifference = SEVERITY_RANKS.get(left.severity) - SEVERITY_RANKS.get(right.severity);
  if (severityDifference !== 0) return severityDifference;
  const typeDifference = left.typeRank - right.typeRank;
  if (typeDifference !== 0) return typeDifference;
  const timestampDifference = left.occurredAt.localeCompare(right.occurredAt);
  if (timestampDifference !== 0) return timestampDifference;
  return left.id.localeCompare(right.id);
}

function publicNotification({ typeRank, ...notification }) {
  return notification;
}

export function createAdminNotificationService({ databasePath, clock = Date.now }) {
  if (typeof clock !== 'function') throw new TypeError('notification clock must be a function');
  return {
    async list(permissions, params) {
      assertNoQueryParameters(params);
      const now = new Date(clock());
      if (Number.isNaN(now.valueOf())) throw new TypeError('Invalid notification clock value');
      const permissionSet = new Set(permissions);
      const definitions = NOTIFICATION_DEFINITIONS.filter(({ permission }) => permissionSet.has(permission));
      const asOf = now.toISOString();
      const sourceRows = (await readAdminNotifications({
        databasePath,
        visibleTypes: new Set(definitions.map(({ type }) => type)),
        asOf,
        asOfDate: taipeiDate(now),
        promotionUntil: new Date(now.valueOf() + (PROMOTION_WINDOW_DAYS * DAY_MS)).toISOString(),
      }));
      const typeTotals = definitions.map(({ type }) => ({
        type,
        count: sourceRows.get(type)?.count ?? 0,
      }));
      const total = typeTotals.reduce((sum, { count }) => sum + count, 0);
      const notifications = definitions
        .flatMap((definition) => mapRows(definition, sourceRows.get(definition.type)?.rows ?? []))
        .sort(compareNotifications)
        .slice(0, NOTIFICATION_ITEM_LIMIT)
        .map(publicNotification);
      return {
        asOf,
        itemLimit: NOTIFICATION_ITEM_LIMIT,
        total,
        hasMore: total > notifications.length,
        typeTotals,
        notifications,
      };
    },
  };
}
