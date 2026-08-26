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

const ITEM_LIMIT = 5;

async function count(database, sql, ...parameters) {
  return Number((await database.prepare(sql).get(...parameters)).count);
}

async function readNewInquiries(database, { startAt, endAt }) {
  const where = "status = 'NEW' AND created_at >= ? AND created_at < ?";
  const databaseStartAt = queryDateTime(database, startAt);
  const databaseEndAt = queryDateTime(database, endAt);
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM service_inquiries WHERE ${where}`, databaseStartAt, databaseEndAt),
    items: await database.prepare(`
      SELECT id, inquiry_no, status, created_at
      FROM service_inquiries
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${ITEM_LIMIT}
    `).all(databaseStartAt, databaseEndAt),
  };
}

async function readOpenWorkOrders(database) {
  const where = "status IN ('OPEN', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS')";
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM work_orders WHERE ${where}`),
    items: await database.prepare(`
      SELECT id, work_order_no, work_type, priority, status, scheduled_at
      FROM work_orders
      WHERE ${where}
      ORDER BY
        CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
        created_at ASC,
        id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(),
  };
}

async function readOverdueInvoices(database, localDate) {
  const where = "due_date < ? AND balance_due > 0 AND status IN ('ISSUED', 'PARTIAL', 'OVERDUE')";
  return {
    count: await count(database, `SELECT COUNT(*) AS count FROM invoices WHERE ${where}`, localDate),
    items: await database.prepare(`
      SELECT id, invoice_no, due_date, balance_due, status
      FROM invoices
      WHERE ${where}
      ORDER BY due_date ASC, id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(localDate),
  };
}

async function readLowStock(database) {
  const where = `
    stock_items.is_active = 1
    AND warehouses.is_active = 1
    AND (warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved)
      <= stock_items.reorder_level
  `;
  const joins = `
    FROM warehouse_stock
    JOIN stock_items ON stock_items.id = warehouse_stock.stock_item_id
    JOIN warehouses ON warehouses.id = warehouse_stock.warehouse_id
  `;
  return {
    count: await count(database, `SELECT COUNT(*) AS count ${joins} WHERE ${where}`),
    items: await database.prepare(`
      SELECT
        stock_items.id AS stock_item_id,
        stock_items.sku,
        stock_items.item_name,
        warehouses.warehouse_code,
        warehouse_stock.quantity_on_hand - warehouse_stock.quantity_reserved AS available_quantity,
        stock_items.reorder_level
      ${joins}
      WHERE ${where}
      ORDER BY available_quantity ASC, stock_items.id ASC, warehouses.id ASC
      LIMIT ${ITEM_LIMIT}
    `).all(),
  };
}

export async function readDashboardMetrics({ databasePath, visibleKeys, businessDay }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const metrics = new Map();
    if (visibleKeys.has('new-inquiries')) {
      metrics.set('new-inquiries', await readNewInquiries(database, businessDay));
    }
    if (visibleKeys.has('open-work-orders')) {
      metrics.set('open-work-orders', await readOpenWorkOrders(database));
    }
    if (visibleKeys.has('overdue-invoices')) {
      metrics.set('overdue-invoices', await readOverdueInvoices(database, businessDay.date));
    }
    if (visibleKeys.has('low-stock')) {
      metrics.set('low-stock', await readLowStock(database));
    }
    return metrics;
  } finally {
    database.close();
  }
}

