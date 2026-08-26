import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function writeInvoiceDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

const SELECT_INVOICE = `
  SELECT invoices.*, customers.customer_no, customers.display_name,
    subscriptions.subscription_no, plans.plan_code, plans.plan_name
  FROM invoices
  JOIN customers ON customers.id = invoices.customer_id
  LEFT JOIN subscriptions ON subscriptions.id = invoices.subscription_id
  LEFT JOIN service_plans AS plans ON plans.id = subscriptions.service_plan_id
`;

async function selectInvoice(database, invoiceId) {
  const row = await database.prepare(`${SELECT_INVOICE} WHERE invoices.id = ?`).get(invoiceId);
  if (!row) return null;
  const items = await database.prepare(`
    SELECT id, subscription_id, item_type, description, period_start, period_end,
      quantity, unit_price, line_amount, tax_amount, created_at
    FROM invoice_items WHERE invoice_id = ? ORDER BY id
  `).all(invoiceId);
  return { row, items };
}

export async function listInvoiceRows({ databasePath, filters }) {
  const clauses = [];
  const values = [];
  if (filters.status) {
    clauses.push('invoices.status = ?');
    values.push(filters.status);
  }
  if (filters.q) {
    clauses.push(`(invoices.invoice_no LIKE ? ESCAPE '!'
      OR customers.display_name LIKE ? ESCAPE '!'
      OR subscriptions.subscription_no LIKE ? ESCAPE '!')`);
    const pattern = `%${filters.q.replace(/[!%_]/g, '!$&')}%`;
    values.push(pattern, pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`${SELECT_INVOICE} ${where}
      ORDER BY invoices.created_at DESC, invoices.id DESC LIMIT 100`).all(...values);
  } finally {
    database.close();
  }
}

export async function findInvoiceDetail({ databasePath, invoiceId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectInvoice(database, invoiceId);
  } finally {
    database.close();
  }
}

export async function listBillableSubscriptionIds({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return (await database.prepare(`
      SELECT id FROM subscriptions
      WHERE status IN ('ACTIVE', 'SUSPENDED')
      ORDER BY id
    `).all()).map(({ id }) => Number(id));
  } finally {
    database.close();
  }
}

export async function generateInvoice({ databasePath, input, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeInvoiceDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      const subscription = await database.prepare(`
        SELECT subscriptions.id, subscriptions.subscription_no,
          subscriptions.customer_id, subscriptions.status, subscriptions.monthly_fee,
          plans.plan_name, plans.bandwidth_label
        FROM subscriptions
        JOIN service_plans AS plans ON plans.id = subscriptions.service_plan_id
        WHERE subscriptions.id = ?
      `).get(input.subscriptionId);
      if (!subscription) return { kind: 'subscription-not-found' };
      if (!['ACTIVE', 'SUSPENDED'].includes(subscription.status)) {
        return { kind: 'subscription-not-billable' };
      }
      const billingPeriodKey = `${subscription.id}:${input.billingPeriodStart}:${input.billingPeriodEnd}`;
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM invoices').get()).id);
      const invoiceNo = `INV-${input.billingPeriodStart.slice(0, 7).replace('-', '')}-${String(id).padStart(8, '0')}`;
      const total = Number(subscription.monthly_fee);
      const subtotal = Math.round(total * 100 / 105);
      const tax = total - subtotal;
      await database.prepare(`
        INSERT INTO invoices (
          id, billing_period_key, invoice_no, customer_id, subscription_id,
          billing_period_start, billing_period_end, issued_at, due_date,
          subtotal_amount, tax_amount, total_amount, balance_due, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
      `).run(
        id, billingPeriodKey, invoiceNo, subscription.customer_id, subscription.id,
        input.billingPeriodStart, input.billingPeriodEnd, databaseNow, input.dueDate,
        subtotal, tax, total, total, databaseNow, databaseNow,
      );
      await database.prepare(`
        INSERT INTO invoice_items (
          invoice_id, subscription_id, item_type, description, period_start,
          period_end, quantity, unit_price, line_amount, tax_amount, created_at
        ) VALUES (?, ?, 'SERVICE', ?, ?, ?, 1000, ?, ?, ?, ?)
      `).run(
        id, subscription.id, `${subscription.bandwidth_label || subscription.plan_name} 月租費`,
        input.billingPeriodStart, input.billingPeriodEnd, total, subtotal, tax, databaseNow,
      );
      const detail = await selectInvoice(database, id);
      await afterWrite(database, detail.row);
      return { kind: 'created', detail };
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: invoices.billing_period_key')) {
      return { kind: 'duplicate-period' };
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function transitionInvoice({
  databasePath, invoiceId, action, input, now, today, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeInvoiceDateTime(database, now);
  const expectedUpdatedAt = writeInvoiceDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const before = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      if (!before) return { kind: 'not-found' };
      if (before.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      let target = null;
      if (action === 'issue' && before.status === 'DRAFT') target = 'ISSUED';
      if (action === 'overdue' && before.status === 'ISSUED' && before.due_date < today) target = 'OVERDUE';
      if (action === 'void' && ['DRAFT', 'ISSUED', 'OVERDUE'].includes(before.status)) target = 'VOID';
      if (!target) return { kind: 'invalid-transition' };
      const balanceDue = target === 'VOID' ? 0 : before.balance_due;
      const issuedAt = target === 'ISSUED' ? databaseNow : before.issued_at;
      const result = await database.prepare(`
        UPDATE invoices SET status = ?, balance_due = ?, issued_at = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(target, balanceDue, issuedAt, databaseNow, invoiceId, expectedUpdatedAt);
      if (Number(result.changes) !== 1) return { kind: 'conflict' };
      const after = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      await afterWrite(database, before, after);
      return { kind: 'updated', detail: await selectInvoice(database, invoiceId) };
    });
  } finally {
    database.close();
  }
}
