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

const SOURCE_ITEM_LIMIT = 50;
const OPEN_WORK_STATUSES = "'OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS'";
const OPEN_INVOICE_STATUSES = "'ISSUED', 'PARTIAL', 'OVERDUE'";

async function count(database, sql, ...parameters) {
  return Number((await database.prepare(sql).get(...parameters)).count);
}

async function readOpenWork(database) {
  const where = `status IN (${OPEN_WORK_STATUSES})`;
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM work_orders WHERE ${where}`),
    rows: await database.prepare(`
      SELECT work_order_no, work_type, priority, status, created_at
      FROM work_orders
      WHERE ${where}
      ORDER BY
        CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
        created_at ASC,
        id ASC
      LIMIT ${SOURCE_ITEM_LIMIT}
    `).all(),
  };
}

async function readOverdueInvoices(database, asOfDate) {
  const where = `due_date < ? AND balance_due > 0 AND status IN (${OPEN_INVOICE_STATUSES})`;
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM invoices WHERE ${where}`, asOfDate),
    rows: await database.prepare(`
      SELECT invoice_no, due_date, status
      FROM invoices
      WHERE ${where}
      ORDER BY due_date ASC, id ASC
      LIMIT ${SOURCE_ITEM_LIMIT}
    `).all(asOfDate),
  };
}

async function readLowStock(database) {
  const joins = `
    FROM warehouse_stock
    JOIN stock_items ON stock_items.id = warehouse_stock.stock_item_id
    JOIN warehouses ON warehouses.id = warehouse_stock.warehouse_id
  `;
  const where = `
    stock_items.is_active = 1
    AND warehouses.is_active = 1
    AND (warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved)
      <= stock_items.reorder_level
  `;
  return {
    count: await count(database, `SELECT COUNT(*) AS count ${joins} WHERE ${where}`),
    rows: await database.prepare(`
      SELECT stock_items.sku, warehouses.warehouse_code, warehouse_stock.updated_at
      ${joins}
      WHERE ${where}
      ORDER BY warehouse_stock.updated_at ASC, warehouse_stock.id ASC
      LIMIT ${SOURCE_ITEM_LIMIT}
    `).all(),
  };
}

async function readExpiringPromotions(database, { asOf, until }) {
  const databaseAsOf = queryDateTime(database, asOf);
  const databaseUntil = queryDateTime(database, until);
  const where = `
    is_active = 1
    AND ends_at IS NOT NULL
    AND (starts_at IS NULL OR starts_at <= ?)
    AND ends_at >= ?
    AND ends_at < ?
  `;
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM promotions WHERE ${where}`, databaseAsOf, databaseAsOf, databaseUntil),
    rows: await database.prepare(`
      SELECT promotion_code, ends_at
      FROM promotions
      WHERE ${where}
      ORDER BY ends_at ASC, id ASC
      LIMIT ${SOURCE_ITEM_LIMIT}
    `).all(databaseAsOf, databaseAsOf, databaseUntil),
  };
}

export async function readAdminNotifications({ databasePath, visibleTypes, asOf, asOfDate, promotionUntil }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const notifications = new Map();
    if (visibleTypes.has('OVERDUE_INVOICE')) {
      notifications.set('OVERDUE_INVOICE', await readOverdueInvoices(database, asOfDate));
    }
    if (visibleTypes.has('OPEN_WORK')) notifications.set('OPEN_WORK', await readOpenWork(database));
    if (visibleTypes.has('LOW_STOCK')) notifications.set('LOW_STOCK', await readLowStock(database));
    if (visibleTypes.has('EXPIRING_PROMOTION')) {
      notifications.set('EXPIRING_PROMOTION', await readExpiringPromotions(database, {
        asOf,
        until: promotionUntil,
      }));
    }
    return notifications;
  } finally {
    database.close();
  }
}
