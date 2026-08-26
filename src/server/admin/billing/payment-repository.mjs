import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function selectActivity(database, invoiceId) {
  const invoice = await database.prepare(`
    SELECT invoices.*, customers.customer_no, customers.display_name
    FROM invoices JOIN customers ON customers.id = invoices.customer_id
    WHERE invoices.id = ?
  `).get(invoiceId);
  if (!invoice) return null;
  const payments = await database.prepare(`
    SELECT payments.*, staff.staff_no, staff.display_name AS staff_name
    FROM payments LEFT JOIN staff_users AS staff ON staff.id = payments.received_by_staff_user_id
    WHERE payments.invoice_id = ? ORDER BY payments.paid_at, payments.id
  `).all(invoiceId);
  const requests = await database.prepare(`
    SELECT requests.*, applicant.staff_no AS applicant_no,
      applicant.display_name AS applicant_name, approver.staff_no AS approver_no,
      approver.display_name AS approver_name
    FROM billing_adjustment_requests AS requests
    JOIN staff_users AS applicant ON applicant.id = requests.requested_by_staff_user_id
    LEFT JOIN staff_users AS approver ON approver.id = requests.approved_by_staff_user_id
    WHERE requests.invoice_id = ? ORDER BY requests.created_at, requests.id
  `).all(invoiceId);
  const adjustments = await database.prepare(`
    SELECT adjustments.*, approver.staff_no AS approver_no,
      approver.display_name AS approver_name
    FROM billing_adjustments AS adjustments
    JOIN staff_users AS approver ON approver.id = adjustments.approved_by_staff_user_id
    WHERE adjustments.invoice_id = ? ORDER BY adjustments.approved_at, adjustments.id
  `).all(invoiceId);
  return { invoice, payments, requests, adjustments };
}

export async function findBillingActivity({ databasePath, invoiceId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try { return await selectActivity(database, invoiceId); } finally { database.close(); }
}

export async function listAdjustmentRequestRows({ databasePath, status }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      SELECT requests.*, invoices.invoice_no, customers.customer_no, customers.display_name,
        applicant.staff_no AS applicant_no, applicant.display_name AS applicant_name,
        approver.staff_no AS approver_no, approver.display_name AS approver_name
      FROM billing_adjustment_requests AS requests
      JOIN invoices ON invoices.id = requests.invoice_id
      JOIN customers ON customers.id = invoices.customer_id
      JOIN staff_users AS applicant ON applicant.id = requests.requested_by_staff_user_id
      LEFT JOIN staff_users AS approver ON approver.id = requests.approved_by_staff_user_id
      WHERE (? IS NULL OR requests.status = ?)
      ORDER BY requests.created_at DESC, requests.id DESC LIMIT 100
    `).all(status, status);
  } finally { database.close(); }
}

export async function postPayment({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  const paidAt = writeDateTime(database, input.paidAt);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const invoice = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoiceId);
      if (!invoice) return { kind: 'invoice-not-found' };
      if (invoice.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (!['ISSUED', 'PARTIAL', 'OVERDUE'].includes(invoice.status)) return { kind: 'invoice-not-payable' };
      if (input.amount > Number(invoice.balance_due)) return { kind: 'overpayment' };
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM payments').get()).id);
      const paymentNo = `PAY-${String(id).padStart(8, '0')}`;
      await database.prepare(`
        INSERT INTO payments (
          id, idempotency_key, payment_no, invoice_id, paid_at, amount,
          payment_method, transaction_reference, status,
          received_by_staff_user_id, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)
      `).run(
        id, input.idempotencyKey, paymentNo, input.invoiceId, paidAt,
        input.amount, input.paymentMethod, input.transactionReference,
        actorId, input.notes, databaseNow,
      );
      const balanceDue = Number(invoice.balance_due) - input.amount;
      const status = balanceDue === 0 ? 'PAID' : 'PARTIAL';
      const update = await database.prepare(`
        UPDATE invoices SET balance_due = ?, status = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(balanceDue, status, databaseNow, input.invoiceId, expectedUpdatedAt);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const payment = await database.prepare('SELECT * FROM payments WHERE id = ?').get(id);
      const updatedInvoice = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoiceId);
      await afterWrite(database, payment, invoice, updatedInvoice);
      return { kind: 'created', payment, invoice: updatedInvoice };
    });
  } catch (error) {
    if ((error?.constraintKind === 'unique' || String(error.message).includes('UNIQUE constraint failed'))) return { kind: 'duplicate-payment' };
    throw error;
  } finally { database.close(); }
}

export async function createAdjustmentRequest({ databasePath, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  try {
    return await runAtomicResult(database, async () => {
      const invoice = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoiceId);
      if (!invoice) return { kind: 'invoice-not-found' };
      if (['DRAFT', 'VOID'].includes(invoice.status)) return { kind: 'invoice-not-adjustable' };
      const id = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM billing_adjustment_requests').get()).id);
      const requestNo = `ADJR-${String(id).padStart(8, '0')}`;
      await database.prepare(`
        INSERT INTO billing_adjustment_requests (
          id, request_no, invoice_id, adjustment_type, amount, reason,
          requested_by_staff_user_id, status, approved_by_staff_user_id,
          approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?)
      `).run(id, requestNo, input.invoiceId, input.adjustmentType, input.amount, input.reason, actorId, databaseNow, databaseNow);
      const row = await database.prepare('SELECT * FROM billing_adjustment_requests WHERE id = ?').get(id);
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally { database.close(); }
}

export async function decideAdjustment({ databasePath, requestId, action, input, actorId, now, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  const databaseNow = writeDateTime(database, now);
  const expectedUpdatedAt = writeDateTime(database, input.expectedUpdatedAt);
  try {
    return await runAtomicResult(database, async () => {
      const request = await database.prepare('SELECT * FROM billing_adjustment_requests WHERE id = ?').get(requestId);
      if (!request) return { kind: 'request-not-found' };
      if (request.updated_at !== expectedUpdatedAt) return { kind: 'conflict' };
      if (request.status !== 'PENDING') return { kind: 'already-decided' };
      if (Number(request.requested_by_staff_user_id) === actorId) return { kind: 'self-approval' };
      const invoice = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(request.invoice_id);
      if (!invoice || ['DRAFT', 'VOID'].includes(invoice.status)) return { kind: 'invoice-not-adjustable' };
      if (action === 'approve') {
        const amount = Number(request.amount);
        let subtotal = Number(invoice.subtotal_amount);
        let total = Number(invoice.total_amount);
        let balance = Number(invoice.balance_due);
        if (request.adjustment_type === 'DEBIT') {
          subtotal += amount; total += amount; balance += amount;
        } else {
          if (amount > balance) return { kind: 'adjustment-exceeds-balance' };
          balance -= amount;
        }
        const status = balance === 0 ? 'PAID' : 'PARTIAL';
        await database.prepare(`
          UPDATE invoices SET subtotal_amount = ?, total_amount = ?, balance_due = ?,
            status = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, total, balance, status, databaseNow, invoice.id);
        const ledgerId = Number((await database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM billing_adjustments').get()).id);
        await database.prepare(`
          INSERT INTO billing_adjustments (
            id, adjustment_no, invoice_id, adjustment_type, amount, reason,
            approved_by_staff_user_id, approved_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId, `ADJ-${String(ledgerId).padStart(8, '0')}`, invoice.id,
          request.adjustment_type, amount, request.reason, actorId, databaseNow, databaseNow,
        );
      }
      const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const update = await database.prepare(`
        UPDATE billing_adjustment_requests
        SET status = ?, approved_by_staff_user_id = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING' AND updated_at = ?
      `).run(status, actorId, databaseNow, databaseNow, requestId, expectedUpdatedAt);
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await database.prepare('SELECT * FROM billing_adjustment_requests WHERE id = ?').get(requestId);
      const updatedInvoice = await database.prepare('SELECT * FROM invoices WHERE id = ?').get(request.invoice_id);
      await afterWrite(database, request, after, invoice, updatedInvoice);
      return { kind: 'updated', request: after, invoice: updatedInvoice };
    });
  } finally { database.close(); }
}
