import { openRuntimeDatabase } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function queryDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

const ITEM_LIMIT = 50;
const OPEN_WORK_STATUSES = "'OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS'";
const OPEN_INVOICE_STATUSES = "'ISSUED', 'PARTIAL', 'OVERDUE'";

async function count(database, sql, ...parameters) {
  return Number((await database.prepare(sql).get(...parameters)).count);
}

async function readInquiries(database, { fromAt, toAt }) {
  const where = 'created_at >= ? AND created_at < ?';
  const sourceTotal = await count(database, `SELECT COUNT(*) AS count FROM service_inquiries WHERE ${where}`, fromAt, toAt);
  return {
    total: sourceTotal,
    sourceTotal,
    items: await database.prepare(`
      SELECT inquiry_no, channel, status, created_at
      FROM service_inquiries
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${ITEM_LIMIT}
    `).all(fromAt, toAt),
  };
}

async function readOpenWork(database, { fromAt, toAt }) {
  const sourceWhere = 'created_at >= ? AND created_at < ?';
  const reportWhere = `${sourceWhere} AND status IN (${OPEN_WORK_STATUSES})`;
  return {
    total: await count(database, `SELECT COUNT(*) AS count FROM work_orders WHERE ${reportWhere}`, fromAt, toAt),
    sourceTotal: await count(database, `SELECT COUNT(*) AS count FROM work_orders WHERE ${sourceWhere}`, fromAt, toAt),
    items: await database.prepare(`
      SELECT work_order_no, work_type, priority, status, scheduled_at, created_at
      FROM work_orders
      WHERE ${reportWhere}
      ORDER BY
        CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
        created_at ASC,
        id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(fromAt, toAt),
  };
}

async function readOverdueInvoices(database, { from, to, asOfDate }) {
  const sourceWhere = 'due_date >= ? AND due_date <= ?';
  const reportWhere = `${sourceWhere}
    AND due_date < ?
    AND balance_due > 0
    AND status IN (${OPEN_INVOICE_STATUSES})`;
  return {
    total: await count(database, `SELECT COUNT(*) AS count FROM invoices WHERE ${reportWhere}`, from, to, asOfDate),
    sourceTotal: await count(database, `SELECT COUNT(*) AS count FROM invoices WHERE ${sourceWhere}`, from, to),
    items: await database.prepare(`
      SELECT invoice_no, due_date, balance_due, status
      FROM invoices
      WHERE ${reportWhere}
      ORDER BY due_date ASC, id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(from, to, asOfDate),
  };
}

async function readLowStock(database) {
  const sourceWhere = 'stock_items.is_active = 1 AND warehouses.is_active = 1';
  const reportWhere = `${sourceWhere}
    AND (warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved)
      <= stock_items.reorder_level`;
  const joins = `
    FROM warehouse_stock
    JOIN stock_items ON stock_items.id = warehouse_stock.stock_item_id
    JOIN warehouses ON warehouses.id = warehouse_stock.warehouse_id
  `;
  return {
    total: await count(database, `SELECT COUNT(*) AS count ${joins} WHERE ${reportWhere}`),
    sourceTotal: await count(database, `SELECT COUNT(*) AS count ${joins} WHERE ${sourceWhere}`),
    items: await database.prepare(`
      SELECT stock_items.sku, stock_items.item_name, stock_items.unit,
        warehouses.warehouse_code,
        warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved AS available_quantity,
        stock_items.reorder_level
      ${joins}
      WHERE ${reportWhere}
      ORDER BY available_quantity ASC, stock_items.id ASC, warehouses.id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(),
  };
}

async function readExpiringPromotions(database, { fromAt, toAt, asOf }) {
  const databaseFromAt = queryDateTime(database, fromAt);
  const databaseToAt = queryDateTime(database, toAt);
  const databaseAsOf = queryDateTime(database, asOf);
  const sourceWhere = 'is_active = 1 AND ends_at IS NOT NULL AND ends_at >= ? AND ends_at < ?';
  const reportWhere = `${sourceWhere} AND (starts_at IS NULL OR starts_at <= ?) AND ends_at >= ?`;
  return {
    total: await count(database, `SELECT COUNT(*) AS count FROM promotions WHERE ${reportWhere}`, databaseFromAt, databaseToAt, databaseAsOf, databaseAsOf),
    sourceTotal: await count(database, `SELECT COUNT(*) AS count FROM promotions WHERE ${sourceWhere}`, databaseFromAt, databaseToAt),
    items: await database.prepare(`
      SELECT promotion_code, promotion_name, ends_at
      FROM promotions
      WHERE ${reportWhere}
      ORDER BY ends_at ASC, id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(databaseFromAt, databaseToAt, databaseAsOf, databaseAsOf),
  };
}

export async function readOperationalReports({ databasePath, visibleKeys, filters }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const reports = new Map();
    if (visibleKeys.has('inquiries')) reports.set('inquiries', await readInquiries(database, filters));
    if (visibleKeys.has('open-work')) reports.set('open-work', await readOpenWork(database, filters));
    if (visibleKeys.has('overdue-invoices')) reports.set('overdue-invoices', await readOverdueInvoices(database, filters));
    if (visibleKeys.has('low-stock')) reports.set('low-stock', await readLowStock(database));
    if (visibleKeys.has('expiring-promotions')) reports.set('expiring-promotions', await readExpiringPromotions(database, filters));
    return reports;
  } finally {
    database.close();
  }
}
