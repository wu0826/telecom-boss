const POSITIVE_COLUMNS = new Set([
  'billing_adjustments.amount',
  'invoice_items.quantity',
  'order_product_items.quantity',
  'order_service_items.quantity',
  'payments.amount',
  'stock_movements.quantity',
]);

const NON_NEGATIVE_COLUMNS = new Set([
  'engineering_projects.contract_amount',
  'engineering_projects.estimated_amount',
  'equipment_models.unit_cost',
  'invoice_items.line_amount',
  'invoice_items.tax_amount',
  'invoice_items.unit_price',
  'invoices.balance_due',
  'invoices.subtotal_amount',
  'invoices.tax_amount',
  'invoices.total_amount',
  'order_product_items.discount_amount',
  'order_product_items.unit_price',
  'order_service_items.unit_price',
  'plan_prices.amount',
  'promotions.discount_value',
  'sales_orders.subtotal_amount',
  'sales_orders.tax_amount',
  'sales_orders.total_amount',
  'stock_items.reorder_level',
  'stock_items.selling_price',
  'stock_items.standard_cost',
  'warehouse_stock.quantity_on_hand',
  'warehouse_stock.quantity_reserved',
]);

const NON_NEGATIVE_INTEGER_COLUMNS = new Set([
  'cms_banners.sort_order',
  'promotions.gift_quantity',
  'service_plans.download_mbps',
  'service_plans.upload_mbps',
]);

const POSITIVE_INTEGER_COLUMNS = new Set([
  'order_product_items.quantity',
  'order_service_items.contract_months',
  'order_service_items.quantity',
  'service_plans.contract_months',
]);

const TABLE_CHECKS = new Map([
  ['cms_announcements', [
    '"ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"',
  ]],
  ['cms_banners', [
    '"ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"',
  ]],
  ['engineering_projects', [
    '"planned_end_date" IS NULL OR "planned_start_date" IS NULL OR "planned_end_date" >= "planned_start_date"',
  ]],
  ['invoice_items', [
    '"period_end" IS NULL OR "period_start" IS NULL OR "period_end" >= "period_start"',
  ]],
  ['invoices', [
    '"billing_period_end" >= "billing_period_start"',
    '"total_amount" = "subtotal_amount" + "tax_amount"',
    '"balance_due" <= "total_amount"',
  ]],
  ['warehouse_stock', [
    '"quantity_reserved" <= "quantity_on_hand"',
  ]],
  ['plan_prices', [
    '"month_to" IS NULL OR "month_from" IS NULL OR "month_to" >= "month_from"',
    '"effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" >= "effective_from"',
  ]],
  ['promotions', [
    '"ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"',
  ]],
  ['service_plans', [
    '"effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" >= "effective_from"',
  ]],
  ['subscriptions', [
    '"contract_end_date" IS NULL OR "contract_start_date" IS NULL OR "contract_end_date" >= "contract_start_date"',
  ]],
]);

export function columnOverlayChecks(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  const checks = [];

  if (POSITIVE_COLUMNS.has(key) || POSITIVE_INTEGER_COLUMNS.has(key)) {
    checks.push(`"${columnName}" > 0`);
  } else if (NON_NEGATIVE_COLUMNS.has(key) || NON_NEGATIVE_INTEGER_COLUMNS.has(key)) {
    checks.push(`"${columnName}" >= 0`);
  }

  if (key === 'subscriptions.billing_day') {
    checks.push('"billing_day" BETWEEN 1 AND 28');
  }
  if (key === 'service_accounts.vlan_id') {
    checks.push('"vlan_id" BETWEEN 1 AND 4094');
  }
  if (key === 'plan_prices.month_from' || key === 'plan_prices.month_to') {
    checks.push(`"${columnName}" >= 1`);
  }
  if (key === 'plan_prices.priority') {
    checks.push('"priority" >= 0');
  }

  return checks;
}

export function tableOverlayChecks(tableName) {
  return TABLE_CHECKS.get(tableName) ?? [];
}

export function tableOverlayStatements(tableName) {
  const statements = [];
  if (tableName === 'subscriptions') {
    statements.push(`CREATE UNIQUE INDEX "uq_subscriptions_order_service_item"
      ON "subscriptions" ("order_service_item_id")
      WHERE "order_service_item_id" IS NOT NULL`);
  }
  if (tableName === 'outage_subscriptions') {
    statements.push(`CREATE UNIQUE INDEX "uq_outage_subscriptions_pair"
      ON "outage_subscriptions" ("outage_incident_id", "subscription_id")`);
  }
  if (tableName === 'stock_movements') {
    statements.push(`CREATE UNIQUE INDEX "uq_stock_movements_idempotency"
      ON "stock_movements" ("movement_type", "reference_no")
      WHERE "reference_no" IS NOT NULL`);
  }
  if (tableName === 'billing_adjustments') {
    statements.push(`CREATE TABLE "billing_adjustment_requests" (
      "id" INTEGER PRIMARY KEY,
      "request_no" TEXT NOT NULL UNIQUE,
      "invoice_id" INTEGER NOT NULL REFERENCES "invoices" ("id") ON DELETE RESTRICT,
      "adjustment_type" TEXT NOT NULL CHECK ("adjustment_type" IN ('CREDIT', 'DEBIT', 'WRITE_OFF')),
      "amount" INTEGER NOT NULL CHECK ("amount" > 0),
      "reason" TEXT NOT NULL,
      "requested_by_staff_user_id" INTEGER NOT NULL REFERENCES "staff_users" ("id") ON DELETE RESTRICT,
      "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
      "approved_by_staff_user_id" INTEGER REFERENCES "staff_users" ("id") ON DELETE RESTRICT,
      "approved_at" TEXT,
      "created_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CHECK (("status" = 'PENDING' AND "approved_by_staff_user_id" IS NULL AND "approved_at" IS NULL)
        OR ("status" IN ('APPROVED', 'REJECTED') AND "approved_by_staff_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)),
      CHECK ("approved_by_staff_user_id" IS NULL OR "approved_by_staff_user_id" <> "requested_by_staff_user_id")
    )`);
    statements.push(`CREATE INDEX "idx_billing_adjustment_requests_invoice"
      ON "billing_adjustment_requests" ("invoice_id")`);
    statements.push(`CREATE INDEX "idx_billing_adjustment_requests_status"
      ON "billing_adjustment_requests" ("status")`);
    statements.push(`CREATE TRIGGER "trg_billing_adjustment_requests_no_delete"
      BEFORE DELETE ON "billing_adjustment_requests"
      BEGIN SELECT RAISE(ABORT, 'billing adjustment requests are append-only'); END`);
    statements.push(`CREATE TRIGGER "trg_billing_adjustment_requests_immutable"
      BEFORE UPDATE ON "billing_adjustment_requests"
      WHEN OLD."status" <> 'PENDING'
        OR NEW."request_no" <> OLD."request_no"
        OR NEW."invoice_id" <> OLD."invoice_id"
        OR NEW."adjustment_type" <> OLD."adjustment_type"
        OR NEW."amount" <> OLD."amount"
        OR NEW."reason" <> OLD."reason"
        OR NEW."requested_by_staff_user_id" <> OLD."requested_by_staff_user_id"
        OR NEW."created_at" <> OLD."created_at"
      BEGIN SELECT RAISE(ABORT, 'billing adjustment request evidence is immutable'); END`);
  }
  const appendOnlyTables = new Set([
    'audit_logs', 'stock_movements', 'subscription_status_history', 'work_order_status_history',
  ]);
  if (!appendOnlyTables.has(tableName)) return statements;
  statements.push(
    `CREATE TRIGGER "trg_${tableName}_no_update"
     BEFORE UPDATE ON "${tableName}"
     BEGIN
       SELECT RAISE(ABORT, '${tableName} is append-only');
     END`,
    `CREATE TRIGGER "trg_${tableName}_no_delete"
     BEFORE DELETE ON "${tableName}"
     BEGIN
       SELECT RAISE(ABORT, '${tableName} is append-only');
     END`,
  );
  return statements;
}
