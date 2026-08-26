import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const SIGNATURE_PREFIX = '__request_signature__:';

function decodeNotes(value) {
  if (!value?.startsWith(SIGNATURE_PREFIX)) return { signature: null, notes: value };
  const separator = value.indexOf('\n');
  if (separator < 0) return { signature: value.slice(SIGNATURE_PREFIX.length), notes: null };
  return {
    signature: value.slice(SIGNATURE_PREFIX.length, separator),
    notes: value.slice(separator + 1) || null,
  };
}

function encodeNotes(signature, notes) {
  return `${SIGNATURE_PREFIX}${signature}\n${notes ?? ''}`;
}

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function selectOrder(database, orderId) {
  const row = await database.prepare(`
    SELECT orders.id, orders.order_no, orders.customer_id, orders.service_location_id,
      orders.engineering_project_id, orders.order_type, orders.status,
      orders.sales_staff_user_id, orders.ordered_at, orders.subtotal_amount,
      orders.tax_amount, orders.total_amount, orders.notes, orders.created_at, orders.updated_at,
      customers.customer_no, customers.display_name,
      locations.location_no, locations.city, locations.district, locations.address_line,
      projects.project_no, projects.project_name
    FROM sales_orders AS orders
    JOIN customers ON customers.id = orders.customer_id
    LEFT JOIN service_locations AS locations ON locations.id = orders.service_location_id
    LEFT JOIN engineering_projects AS projects ON projects.id = orders.engineering_project_id
    WHERE orders.id = ?
  `).get(orderId);
  if (!row) return null;
  const serviceItems = await database.prepare(`
    SELECT items.id, items.service_plan_id, items.plan_price_id, items.promotion_id,
      items.quantity, items.unit_price, items.contract_months, items.description_snapshot,
      plans.plan_code, plans.plan_name, prices.price_type, promotions.promotion_code
    FROM order_service_items AS items
    JOIN service_plans AS plans ON plans.id = items.service_plan_id
    LEFT JOIN plan_prices AS prices ON prices.id = items.plan_price_id
    LEFT JOIN promotions ON promotions.id = items.promotion_id
    WHERE items.sales_order_id = ? ORDER BY items.id
  `).all(orderId);
  const productItems = await database.prepare(`
    SELECT items.id, items.stock_item_id, items.quantity, items.unit_price,
      items.discount_amount, stock.sku, stock.item_name
    FROM order_product_items AS items
    JOIN stock_items AS stock ON stock.id = items.stock_item_id
    WHERE items.sales_order_id = ? ORDER BY items.id
  `).all(orderId);
  const workOrder = await database.prepare(`
    SELECT id, work_order_no, work_type, status
    FROM work_orders WHERE sales_order_id = ? ORDER BY id LIMIT 1
  `).get(orderId) ?? null;
  return { row, serviceItems, productItems, workOrder, ...await decodeNotes(row.notes) };
}

async function resolveCustomer(database, customerId) {
  return await database.prepare(`
    SELECT id FROM customers WHERE id = ? AND status IN ('LEAD', 'ACTIVE')
  `).get(customerId) ?? null;
}

async function resolveLocation(database, customerId, locationId) {
  if (locationId === null) return null;
  return await database.prepare(`
    SELECT id FROM service_locations
    WHERE id = ? AND customer_id = ? AND status IN ('PENDING_SURVEY', 'SERVICEABLE')
  `).get(locationId, customerId) ?? null;
}

async function resolveProject(database, customerId, locationId, projectId) {
  if (projectId === null) return null;
  return await database.prepare(`
    SELECT id, estimated_amount, contract_amount
    FROM engineering_projects
    WHERE id = ? AND customer_id = ?
      AND (? IS NULL OR service_location_id IS NULL OR service_location_id = ?)
      AND status NOT IN ('COMPLETED', 'CANCELLED')
  `).get(projectId, customerId, locationId, locationId) ?? null;
}

async function resolveServiceItem(database, item, now) {
  const resolved = await database.prepare(`
    SELECT plans.id AS service_plan_id, plans.plan_code, plans.plan_name,
      plans.contract_months, plans.description,
      prices.id AS plan_price_id, prices.price_type, prices.amount
    FROM service_plans AS plans
    JOIN plan_prices AS prices ON prices.service_plan_id = plans.id
    WHERE plans.id = ? AND prices.id = ?
      AND plans.is_active = 1 AND prices.is_active = 1
      AND (plans.effective_from IS NULL OR plans.effective_from <= date(?))
      AND (plans.effective_to IS NULL OR plans.effective_to >= date(?))
      AND (prices.effective_from IS NULL OR prices.effective_from <= date(?))
      AND (prices.effective_to IS NULL OR prices.effective_to >= date(?))
  `).get(item.servicePlanId, item.planPriceId, now, now, now, now);
  if (!resolved) return { kind: 'invalid-price' };
  let promotion = null;
  if (item.promotionId !== null) {
    promotion = await database.prepare(`
      SELECT promotions.id, promotions.promotion_code, promotions.promotion_name,
        promotions.discount_type, promotions.discount_value
      FROM promotions
      JOIN promotion_plans AS links ON links.promotion_id = promotions.id
      WHERE promotions.id = ? AND links.service_plan_id = ? AND promotions.is_active = 1
        AND (promotions.starts_at IS NULL OR promotions.starts_at <= ?)
        AND (promotions.ends_at IS NULL OR promotions.ends_at >= ?)
    `).get(item.promotionId, item.servicePlanId, now, now) ?? null;
    if (!promotion) return { kind: 'invalid-promotion' };
  }
  let unitPrice = Number(resolved.amount);
  if (promotion?.discount_type === 'FIXED') {
    unitPrice = Math.max(0, unitPrice - Number(promotion.discount_value));
  } else if (promotion?.discount_type === 'PERCENT') {
    unitPrice = Math.max(0, unitPrice - Math.round(
      unitPrice * Number(promotion.discount_value) / 10_000,
    ));
  }
  const description = [
    resolved.plan_code,
    resolved.plan_name,
    resolved.price_type,
    promotion?.promotion_code,
    promotion?.promotion_name,
  ].filter(Boolean).join(' | ');
  return { kind: 'resolved', ...resolved, promotion, unitPrice, description };
}

async function resolveProductItem(database, item) {
  const row = await database.prepare(`
    SELECT stock.id, stock.sku, stock.item_name, stock.selling_price,
      COALESCE(SUM(balances.quantity_on_hand - balances.quantity_reserved), 0) AS available
    FROM stock_items AS stock
    LEFT JOIN warehouse_stock AS balances ON balances.stock_item_id = stock.id
    WHERE stock.id = ? AND stock.is_active = 1
    GROUP BY stock.id
  `).get(item.stockItemId);
  if (!row) return { kind: 'invalid-stock' };
  if (Number(row.available) < item.quantity * 1_000) return { kind: 'insufficient-stock' };
  return { kind: 'resolved', ...row, unitPrice: Number(row.selling_price) };
}

async function insertOrder(database, input, resolved, actorId, now) {
  const grossService = resolved.serviceItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const grossProducts = resolved.productItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const grossProject = input.orderType === 'PROJECT' && resolved.project
    ? Number(resolved.project.contract_amount ?? resolved.project.estimated_amount)
    : 0;
  const total = grossService + grossProducts + grossProject;
  const subtotal = Math.round(total * 100 / 105);
  const tax = total - subtotal;
  const result = await database.prepare(`
    INSERT INTO sales_orders (
      order_no, customer_id, service_location_id, engineering_project_id,
      order_type, status, sales_staff_user_id, ordered_at,
      subtotal_amount, tax_amount, total_amount, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.orderNo,
    input.customerId,
    input.serviceLocationId,
    input.engineeringProjectId,
    input.orderType,
    actorId,
    now,
    subtotal,
    tax,
    total,
    await encodeNotes(input.requestSignature, input.notes),
    now,
    now,
  );
  const orderId = Number(result.lastInsertRowid);
  const insertService = await database.prepare(`
    INSERT INTO order_service_items (
      sales_order_id, service_plan_id, plan_price_id, promotion_id, quantity,
      unit_price, contract_months, description_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of resolved.serviceItems) {
    await insertService.run(
      orderId,
      item.service_plan_id,
      item.plan_price_id,
      item.promotion?.id ?? null,
      item.quantity,
      item.unitPrice,
      Number(item.contract_months),
      item.description,
      now,
    );
  }
  const insertProduct = await database.prepare(`
    INSERT INTO order_product_items (
      sales_order_id, stock_item_id, quantity, unit_price, discount_amount, created_at
    ) VALUES (?, ?, ?, ?, 0, ?)
  `);
  for (const item of resolved.productItems) {
    await insertProduct.run(orderId, item.id, item.quantity, item.unitPrice, now);
  }
  return orderId;
}

export async function createOrderDraft({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      const existing = await database.prepare('SELECT id FROM sales_orders WHERE order_no = ?').get(input.orderNo);
      if (existing) {
        const detail = await selectOrder(database, Number(existing.id));
        return detail.signature === input.requestSignature
          ? { kind: 'replayed', detail }
          : { kind: 'idempotency-conflict' };
      }
      if (!await resolveCustomer(database, input.customerId)) return { kind: 'invalid-customer' };
      if (input.serviceLocationId !== null && !await resolveLocation(
        database, input.customerId, input.serviceLocationId,
      )) return { kind: 'invalid-location' };
      const project = await resolveProject(
        database, input.customerId, input.serviceLocationId, input.engineeringProjectId,
      );
      if (input.engineeringProjectId !== null && !project) return { kind: 'invalid-project' };
      const serviceItems = [];
      for (const item of input.serviceItems) {
        const result = await resolveServiceItem(database, item, databaseNow);
        if (result.kind !== 'resolved') return result;
        serviceItems.push({ ...result, quantity: item.quantity });
      }
      const productItems = [];
      for (const item of input.productItems) {
        const result = await resolveProductItem(database, item);
        if (result.kind !== 'resolved') return result;
        productItems.push({ ...result, quantity: item.quantity });
      }
      const orderId = await insertOrder(
        database,
        input,
        { project, serviceItems, productItems },
        actorId,
    databaseNow,
  );
      const detail = await selectOrder(database, orderId);
      await afterWrite(database, detail);
      return { kind: 'created', detail };
    });
  } finally {
    database.close();
  }
}

export async function listOrderRows({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      SELECT orders.id, orders.order_no, orders.order_type, orders.status,
        orders.total_amount, orders.ordered_at,
        customers.customer_no, customers.display_name
      FROM sales_orders AS orders
      JOIN customers ON customers.id = orders.customer_id
      ORDER BY orders.ordered_at DESC, orders.id DESC
      LIMIT 100
    `).all();
  } finally {
    database.close();
  }
}

export async function findOrderDetail({ databasePath, orderId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectOrder(database, orderId);
  } finally {
    database.close();
  }
}
