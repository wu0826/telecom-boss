import { readOperationalReports } from './report-repository.mjs';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_DAYS = 31;
const ITEM_LIMIT = 50;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_QUERY_FIELDS = new Set(['from', 'to']);

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const REPORT_DEFINITIONS = Object.freeze([
  {
    key: 'inquiries',
    permission: 'customer.read',
    title: '期間洽詢',
    unit: '件',
    denominatorLabel: '期間內建立洽詢總數',
    definition: '依建立時間落在所選台北日期區間的洽詢計數。',
  },
  {
    key: 'open-work',
    permission: 'operations.manage',
    title: '未結案工單',
    unit: '張',
    denominatorLabel: '期間內建立工單總數',
    definition: '依建立時間落在所選台北日期區間，且目前為待處理狀態的工單。',
  },
  {
    key: 'overdue-invoices',
    permission: 'billing.manage',
    title: '逾期帳單',
    unit: '張',
    denominatorLabel: '期間內到期帳單總數',
    definition: '到期日落在所選區間、早於資料截至日，且仍有餘額的已開立帳單。',
  },
  {
    key: 'low-stock',
    permission: 'inventory.manage',
    title: '低庫存餘額',
    unit: '項',
    denominatorLabel: '啟用倉庫庫存餘額總數',
    definition: '資料截至日啟用倉庫中，可用量小於或等於再訂購量的庫存餘額。日期區間不影響此快照。',
  },
  {
    key: 'expiring-promotions',
    permission: 'catalog.manage',
    title: '即將到期促銷',
    unit: '檔',
    denominatorLabel: '期間內結束的啟用促銷總數',
    definition: '結束時間落在所選台北日期區間、資料截至日仍有效的啟用促銷。',
  },
]);

export class AdminReportError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminReportError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalid(field, message) {
  throw new AdminReportError(422, 'INVALID_QUERY', '營運報表查詢條件無效。', [{ field, message }]);
}

function taipeiDate(now) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid report clock value');
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(date)
      .filter(({ type }) => ['year', 'month', 'day'].includes(type))
      .map(({ type, value }) => [type, Number(value)]),
  );
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function validDate(value, field) {
  if (!DATE_PATTERN.test(value)) invalid(field, '日期格式必須為 YYYY-MM-DD。');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(field, '日期不存在。');
  }
  return value;
}

function taipeiStartAt(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - TAIPEI_OFFSET_MS).toISOString();
}

function nextTaipeiDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function rangeDays(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
}

function fixedScale(value, scale) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw new TypeError('Expected a safe fixed-scale integer');
  const sign = integer < 0 ? '-' : '';
  const digits = String(Math.abs(integer)).padStart(scale + 1, '0');
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function parseOperationalReportQuery(params, now) {
  if (!(params instanceof URLSearchParams)) throw new TypeError('Report query parameters must be URLSearchParams');
  for (const field of new Set(params.keys())) {
    if (!ALLOWED_QUERY_FIELDS.has(field)) invalid(field, '不支援此查詢欄位。');
    if (params.getAll(field).length !== 1) invalid(field, '每個查詢欄位只能提供一次。');
  }
  const suppliedFrom = params.get('from');
  const suppliedTo = params.get('to');
  if ((suppliedFrom === null) !== (suppliedTo === null)) {
    invalid(suppliedFrom === null ? 'from' : 'to', '開始與結束日期必須同時提供。');
  }
  const from = suppliedFrom === null ? taipeiDate(now) : validDate(suppliedFrom, 'from');
  const to = suppliedTo === null ? from : validDate(suppliedTo, 'to');
  if (from > to) invalid('to', '結束日期不可早於開始日期。');
  if (rangeDays(from, to) > MAX_RANGE_DAYS) invalid('to', `日期區間不可超過 ${MAX_RANGE_DAYS} 天。`);
  const fromAt = taipeiStartAt(from);
  const toAt = taipeiStartAt(nextTaipeiDate(to));
  return {
    timeZone: TAIPEI_TIME_ZONE,
    from,
    to,
    fromAt,
    toAt,
    maxRangeDays: MAX_RANGE_DAYS,
    asOfDate: taipeiDate(now),
  };
}

function mapItems(key, rows) {
  if (key === 'inquiries') return rows.map((row) => ({
    inquiryNo: row.inquiry_no,
    channel: row.channel,
    status: row.status,
    createdAt: row.created_at,
  }));
  if (key === 'open-work') return rows.map((row) => ({
    workOrderNo: row.work_order_no,
    workType: row.work_type,
    priority: row.priority,
    status: row.status,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
  }));
  if (key === 'overdue-invoices') return rows.map((row) => ({
    invoiceNo: row.invoice_no,
    dueDate: row.due_date,
    balanceDue: fixedScale(row.balance_due, 2),
    status: row.status,
  }));
  if (key === 'low-stock') return rows.map((row) => ({
    sku: row.sku,
    itemName: row.item_name,
    unit: row.unit,
    warehouseCode: row.warehouse_code,
    availableQuantity: fixedScale(row.available_quantity, 3),
    reorderLevel: fixedScale(row.reorder_level, 3),
  }));
  return rows.map((row) => ({
    promotionCode: row.promotion_code,
    promotionName: row.promotion_name,
    endsAt: row.ends_at,
  }));
}

export function createAdminReportService({ databasePath, clock = Date.now }) {
  if (typeof clock !== 'function') throw new TypeError('report clock must be a function');
  return {
    async operational(permissions, params) {
      const now = new Date(clock());
      if (Number.isNaN(now.valueOf())) throw new TypeError('Invalid report clock value');
      const filters = parseOperationalReportQuery(params, now);
      const visibleDefinitions = REPORT_DEFINITIONS.filter(({ permission }) => new Set(permissions).has(permission));
      const metrics = (await readOperationalReports({
        databasePath,
        visibleKeys: new Set(visibleDefinitions.map(({ key }) => key)),
        filters: { ...filters, asOf: now.toISOString() },
      }));
      return {
        asOf: now.toISOString(),
        filters: {
          timeZone: filters.timeZone,
          from: filters.from,
          to: filters.to,
          fromAt: filters.fromAt,
          toAt: filters.toAt,
          maxRangeDays: filters.maxRangeDays,
        },
        reports: visibleDefinitions.map((definition) => {
          const metric = metrics.get(definition.key) ?? { total: 0, sourceTotal: 0, items: [] };
          return {
            key: definition.key,
            title: definition.title,
            unit: definition.unit,
            total: metric.total,
            denominator: {
              label: definition.denominatorLabel,
              value: metric.sourceTotal,
              unit: definition.unit,
            },
            sourceTotals: { records: metric.sourceTotal },
            definition: definition.definition,
            itemLimit: ITEM_LIMIT,
            items: mapItems(definition.key, metric.items),
          };
        }),
      };
    },
  };
}
