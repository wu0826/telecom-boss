import { readDashboardMetrics } from './dashboard-repository.mjs';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const CARD_DEFINITIONS = Object.freeze([
  { key: 'new-inquiries', permission: 'customer.read', title: '今日新洽詢', unit: '件', href: '#inquiries' },
  { key: 'open-work-orders', permission: 'operations.manage', title: '待處理工單', unit: '張', href: '#operations' },
  { key: 'overdue-invoices', permission: 'billing.manage', title: '逾期帳單', unit: '張', href: '#billing' },
  { key: 'low-stock', permission: 'inventory.manage', title: '低庫存項目', unit: '項', href: '#inventory' },
]);

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function fixedScale(value, scale) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw new TypeError('Expected a safe fixed-scale integer');
  const sign = integer < 0 ? '-' : '';
  const digits = String(Math.abs(integer)).padStart(scale + 1, '0');
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function taipeiBusinessDay(now) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid dashboard clock value');
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(date)
      .filter(({ type }) => ['year', 'month', 'day'].includes(type))
      .map(({ type, value }) => [type, Number(value)]),
  );
  const startMs = Date.UTC(parts.year, parts.month - 1, parts.day) - TAIPEI_OFFSET_MS;
  return {
    timeZone: TAIPEI_TIME_ZONE,
    date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + DAY_MS).toISOString(),
  };
}

function inquiryItems(rows) {
  return rows.map((row) => ({
    inquiryId: Number(row.id),
    inquiryNo: row.inquiry_no,
    status: row.status,
    createdAt: row.created_at,
  }));
}

function workOrderItems(rows) {
  return rows.map((row) => ({
    workOrderId: Number(row.id),
    workOrderNo: row.work_order_no,
    workType: row.work_type,
    priority: row.priority,
    status: row.status,
    scheduledAt: row.scheduled_at,
  }));
}

function invoiceItems(rows) {
  return rows.map((row) => ({
    invoiceId: Number(row.id),
    invoiceNo: row.invoice_no,
    dueDate: row.due_date,
    balanceDue: fixedScale(row.balance_due, 2),
    status: row.status,
  }));
}

function stockItems(rows) {
  return rows.map((row) => ({
    stockItemId: Number(row.stock_item_id),
    sku: row.sku,
    itemName: row.item_name,
    warehouseCode: row.warehouse_code,
    availableQuantity: fixedScale(row.available_quantity, 3),
    reorderLevel: fixedScale(row.reorder_level, 3),
  }));
}

const ITEM_MAPPERS = new Map([
  ['new-inquiries', inquiryItems],
  ['open-work-orders', workOrderItems],
  ['overdue-invoices', invoiceItems],
  ['low-stock', stockItems],
]);

export function createDashboardService({ databasePath, clock = Date.now }) {
  if (typeof clock !== 'function') throw new TypeError('dashboard clock must be a function');
  return {
    async getDashboard(permissions) {
      const permissionSet = new Set(permissions);
      const definitions = CARD_DEFINITIONS.filter(({ permission }) => permissionSet.has(permission));
      const visibleKeys = new Set(definitions.map(({ key }) => key));
      const now = new Date(clock());
      const businessDay = taipeiBusinessDay(now);
      const metrics = (await readDashboardMetrics({ databasePath, visibleKeys, businessDay }));
      return {
        asOf: now.toISOString(),
        businessDay,
        cards: definitions.map(({ permission, ...definition }) => {
          const metric = metrics.get(definition.key) ?? { count: 0, items: [] };
          return {
            ...definition,
            count: metric.count,
            items: ITEM_MAPPERS.get(definition.key)(metric.items),
          };
        }),
      };
    },
  };
}

