import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(app, id) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId: id }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedInvoice(path, { id = 1500, total = 39600, balance = total, status = 'ISSUED' } = {}) {
  const database = new DatabaseSync(path);
  const at = '2026-07-21T08:00:00.000Z';
  database.prepare(`INSERT INTO customers
    (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (?, ?, 'PERSON', ?, 'ACTIVE', ?, ?)`)
    .run(id, `C-PAY-${id}`, `付款測試客戶 ${id}`, at, at);
  const subtotal = Math.round(total * 100 / 105);
  database.prepare(`INSERT INTO invoices (
    id, billing_period_key, invoice_no, customer_id, billing_period_start,
    billing_period_end, issued_at, due_date, subtotal_amount, tax_amount,
    total_amount, balance_due, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, '2026-07-01', '2026-07-31', ?, '2026-08-15', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `customer:${id}:2026-07`, `INV-PAY-${id}`, id, at,
      subtotal, total - subtotal, total, balance, status, at, at);
  database.close();
  return at;
}

function paymentBody(invoiceId, expectedUpdatedAt, overrides = {}) {
  return {
    invoiceId, expectedUpdatedAt, idempotencyKey: `pay-${invoiceId}-${overrides.amount ?? '100.00'}`,
    paidAt: '2026-07-21T12:00:00.000Z', amount: '100.00', paymentMethod: 'TRANSFER',
    transactionReference: `BANK-${invoiceId}-${overrides.amount ?? '10000'}`, notes: '測試入帳',
    ...overrides,
  };
}

test('payment posting atomically moves an issued invoice through partial and paid', async (t) => {
  const app = await startSeededApplication(t, {
    enableDevelopmentLogin: true,
    paymentClock: () => Date.parse('2026-07-21T12:00:00.000Z'),
  });
  const updatedAt = seedInvoice(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const partial = await request(app, billing, '/api/v1/admin/payments', {
    method: 'POST', body: paymentBody(1500, updatedAt),
  });
  assert.equal(partial.response.status, 201);
  assert.equal(partial.body.data.payment.amount, '100.00');
  assert.equal(partial.body.data.invoice.status, 'PARTIAL');
  assert.equal(partial.body.data.invoice.balanceDue, '296.00');

  const paid = await request(app, billing, '/api/v1/admin/payments', {
    method: 'POST', body: paymentBody(1500, partial.body.data.invoice.updatedAt, {
      amount: '296.00', idempotencyKey: 'pay-1500-final', transactionReference: 'BANK-1500-FINAL',
    }),
  });
  assert.equal(paid.response.status, 201);
  assert.equal(paid.body.data.invoice.status, 'PAID');
  assert.equal(paid.body.data.invoice.balanceDue, '0.00');
  const activity = await request(app, billing, '/api/v1/admin/billing/invoices/1500/activity');
  assert.deepEqual(activity.body.data.payments.map(({ amount }) => amount), ['100.00', '296.00']);
});

test('payment rejects overpayment, duplicate references, secrets, and concurrent double-spend', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const updatedAt = seedInvoice(app.telecomDatabasePath, { total: 10000 });
  const billing = await login(app, 4);
  assert.equal((await request(app, billing, '/api/v1/admin/payments', {
    method: 'POST', body: paymentBody(1500, updatedAt, { amount: '100.01' }),
  })).response.status, 409);
  assert.equal((await request(app, billing, '/api/v1/admin/payments', {
    method: 'POST', body: { ...paymentBody(1500, updatedAt), cardNumber: '4111111111111111' },
  })).response.status, 422);

  const attempts = await Promise.all([
    request(app, billing, '/api/v1/admin/payments', {
      method: 'POST', body: paymentBody(1500, updatedAt, {
        amount: '100.00', idempotencyKey: 'concurrent-a', transactionReference: 'BANK-CONCURRENT-A',
      }),
    }),
    request(app, billing, '/api/v1/admin/payments', {
      method: 'POST', body: paymentBody(1500, updatedAt, {
        amount: '100.00', idempotencyKey: 'concurrent-b', transactionReference: 'BANK-CONCURRENT-B',
      }),
    }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [201, 409]);
  const replay = await request(app, billing, '/api/v1/admin/payments', {
    method: 'POST', body: paymentBody(1500, updatedAt, {
      amount: '1.00', idempotencyKey: 'replay-new-key', transactionReference: 'BANK-CONCURRENT-A',
    }),
  });
  assert.equal(replay.response.status, 409);
});

test('billing adjustment requires a different access approver and preserves immutable request evidence', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedInvoice(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const admin = await login(app, 1);
  const requested = await request(app, billing, '/api/v1/admin/billing-adjustments', {
    method: 'POST', body: {
      invoiceId: 1500, adjustmentType: 'CREDIT', amount: '96.00', reason: '服務中斷補償',
    },
  });
  assert.equal(requested.response.status, 201);
  assert.equal(requested.body.data.status, 'PENDING');
  assert.equal(requested.body.data.requestedBy.id, 4);
  assert.equal((await request(app, billing, `/api/v1/admin/billing-adjustments/${requested.body.data.id}/approve`, {
    method: 'POST', body: { expectedUpdatedAt: requested.body.data.updatedAt },
  })).response.status, 403);

  const approved = await request(app, admin, `/api/v1/admin/billing-adjustments/${requested.body.data.id}/approve`, {
    method: 'POST', body: { expectedUpdatedAt: requested.body.data.updatedAt },
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.request.status, 'APPROVED');
  assert.equal(approved.body.data.request.reason, '服務中斷補償');
  assert.equal(approved.body.data.request.approvedBy.id, 1);
  assert.equal(approved.body.data.invoice.balanceDue, '300.00');
  const database = new DatabaseSync(app.telecomDatabasePath);
  const ledger = database.prepare('SELECT * FROM billing_adjustments').get();
  assert.equal(Number(ledger.approved_by_staff_user_id), 1);
  assert.equal(ledger.reason, '服務中斷補償');
  assert.throws(
    () => database.prepare('UPDATE billing_adjustment_requests SET reason = ? WHERE id = ?')
      .run('竄改原因', requested.body.data.id),
    /immutable/,
  );
  database.close();
});

test('adjustment concurrency and audit failures restore both invoice and ledger state', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedInvoice(app.telecomDatabasePath);
  const billing = await login(app, 4);
  const admin = await login(app, 1);
  const requested = (await request(app, billing, '/api/v1/admin/billing-adjustments', {
    method: 'POST', body: {
      invoiceId: 1500, adjustmentType: 'WRITE_OFF', amount: '396.00', reason: '核准呆帳沖銷',
    },
  })).body.data;
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_adjustment_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'BILLING_ADJUSTMENT_APPROVED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  database.close();
  const failed = await request(app, admin, `/api/v1/admin/billing-adjustments/${requested.id}/approve`, {
    method: 'POST', body: { expectedUpdatedAt: requested.updatedAt },
  });
  assert.equal(failed.response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath);
  assert.equal(verify.prepare('SELECT status FROM billing_adjustment_requests WHERE id = ?').get(requested.id).status, 'PENDING');
  assert.equal(Number(verify.prepare('SELECT balance_due FROM invoices WHERE id = 1500').get().balance_due), 39600);
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM billing_adjustments').get().count), 0);
  verify.exec('DROP TRIGGER fail_adjustment_audit');
  verify.close();

  const attempts = await Promise.all([
    request(app, admin, `/api/v1/admin/billing-adjustments/${requested.id}/approve`, {
      method: 'POST', body: { expectedUpdatedAt: requested.updatedAt },
    }),
    request(app, admin, `/api/v1/admin/billing-adjustments/${requested.id}/approve`, {
      method: 'POST', body: { expectedUpdatedAt: requested.updatedAt },
    }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [200, 409]);
  const final = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(Number(final.prepare('SELECT balance_due FROM invoices WHERE id = 1500').get().balance_due), 0);
  assert.equal(Number(final.prepare('SELECT COUNT(*) AS count FROM billing_adjustments').get().count), 1);
  final.close();
});
