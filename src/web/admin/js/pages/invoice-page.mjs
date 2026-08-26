import {
  decideAdminBillingAdjustment, getAdminBillingActivity, getAdminBillingAdjustments,
  AdminApiError, generateAdminInvoice, generateAdminInvoiceBatch,
  getAdminInvoice, getAdminInvoices, postAdminPayment, requestAdminBillingAdjustment,
  transitionAdminInvoice,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const STATUS_LABELS = {
  DRAFT: '草稿', ISSUED: '已開立', PARTIAL: '部分收款', PAID: '已繳清', OVERDUE: '逾期', VOID: '已作廢',
};

function field(document, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value ?? '—';
  wrapper.append(term, description);
  return wrapper;
}

function periodBody(form) {
  return {
    billingPeriodStart: form.elements.namedItem('billingPeriodStart').value,
    billingPeriodEnd: form.elements.namedItem('billingPeriodEnd').value,
    dueDate: form.elements.namedItem('dueDate').value,
  };
}

export function createInvoicePage({
  document, page, refreshButton, clearButton, filterForm, results, resultsBody,
  listStatus, generateForm, generateStatus, batchForm, batchStatus,
  detail, detailClose, detailStatus, detailFields, itemsBody, actions,
  paymentForm, paymentStatus, paymentHistory, adjustmentForm, adjustmentStatus,
  adjustmentHistory, approval, approvalRefresh, approvalStatus, approvalList,
  onSessionExpired = () => {},
}) {
  let current = null;
  let opener = null;
  const gate = createSubmissionGate();
  let canApprove = false;

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function search() {
    const params = new URLSearchParams();
    for (const name of ['q', 'status']) {
      const value = filterForm.elements.namedItem(name).value.trim();
      if (value) params.set(name, value);
    }
    return params.size ? `?${params}` : '';
  }

  async function load() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入帳單…';
    try {
      const invoices = await getAdminInvoices(search());
      resultsBody.replaceChildren();
      for (const invoice of invoices) {
        const row = document.createElement('tr');
        for (const value of [
          invoice.invoiceNo, invoice.customer.name, invoice.subscription?.no ?? '—',
          `${invoice.billingPeriod.start}－${invoice.billingPeriod.end}`,
          `NT$ ${invoice.totalAmount}`, `NT$ ${invoice.balanceDue}`, STATUS_LABELS[invoice.status],
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        const actionCell = document.createElement('td');
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'table-action';
        view.textContent = '檢視';
        view.addEventListener('click', (event) => void openDetail(invoice.id, event.currentTarget));
        actionCell.append(view);
        row.append(actionCell);
        resultsBody.append(row);
      }
      if (!invoices.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 8;
        cell.className = 'table-empty';
        cell.textContent = '目前沒有符合條件的帳單。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `共 ${invoices.length} 張帳單。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = error instanceof AdminApiError ? error.message : '帳單載入失敗。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function renderActions(invoice) {
    const allowed = {
      issue: invoice.status === 'DRAFT',
      overdue: invoice.status === 'ISSUED' && invoice.dueDate < new Date().toISOString().slice(0, 10),
      void: ['DRAFT', 'ISSUED', 'OVERDUE'].includes(invoice.status),
    };
    for (const button of actions.querySelectorAll('button[data-action]')) {
      button.hidden = !allowed[button.dataset.action];
    }
    actions.hidden = !Object.values(allowed).some(Boolean);
  }

  function ledgerCard(title, detailText) {
    const card = document.createElement('article');
    const heading = document.createElement('strong');
    const details = document.createElement('span');
    heading.textContent = title;
    details.textContent = detailText;
    card.append(heading, details);
    return card;
  }

  async function loadActivity(invoiceId) {
    const activity = await getAdminBillingActivity(invoiceId);
    paymentHistory.replaceChildren();
    for (const payment of activity.payments) {
      paymentHistory.append(ledgerCard(
        `${payment.paymentNo}｜NT$ ${payment.amount}`,
        `${new Date(payment.paidAt).toLocaleString('zh-TW')}｜${payment.paymentMethod}｜${payment.transactionReference ?? '無交易參照'}`,
      ));
    }
    if (!activity.payments.length) paymentHistory.append(ledgerCard('尚無付款紀錄', '帳單入帳後會顯示於此。'));
    adjustmentHistory.replaceChildren();
    for (const request of activity.adjustmentRequests) {
      adjustmentHistory.append(ledgerCard(
        `${request.requestNo}｜${request.adjustmentType} NT$ ${request.amount}`,
        `${request.status}｜申請人 ${request.requestedBy.name}｜${request.reason}`,
      ));
    }
    if (!activity.adjustmentRequests.length) adjustmentHistory.append(ledgerCard('尚無調整申請', '貸項、加項與沖銷申請會顯示於此。'));
    paymentForm.hidden = !['ISSUED', 'PARTIAL', 'OVERDUE'].includes(activity.invoice.status);
    adjustmentForm.hidden = ['DRAFT', 'VOID'].includes(activity.invoice.status);
  }

  async function loadApprovals() {
    approval.hidden = !canApprove;
    if (!canApprove) return;
    approvalStatus.textContent = '正在載入待核准調整…';
    try {
      const requests = await getAdminBillingAdjustments('?status=PENDING');
      approvalList.replaceChildren();
      for (const request of requests) {
        const card = document.createElement('article');
        const summary = document.createElement('div');
        const heading = document.createElement('strong');
        const reason = document.createElement('p');
        heading.textContent = `${request.requestNo}｜${request.invoiceNo ?? `帳單 ${request.invoiceId}`}｜NT$ ${request.amount}`;
        reason.textContent = `${request.adjustmentType}｜${request.requestedBy.name}：${request.reason}`;
        summary.append(heading, reason);
        const controls = document.createElement('div');
        controls.className = 'billing-approval-actions';
        for (const [action, label, className] of [['approve', '核准', 'primary-button'], ['reject', '駁回', 'danger-button']]) {
          const button = document.createElement('button');
          button.type = 'button'; button.textContent = label; button.className = className;
          button.addEventListener('click', async () => {
            try {
              const outcome = await gate.run(() => decideAdminBillingAdjustment(request.id, action, request.updatedAt));
              if (!outcome.accepted) return;
              approvalStatus.textContent = `${request.requestNo} 已${action === 'approve' ? '核准' : '駁回'}。`;
              await loadApprovals();
              if (current?.id === request.invoiceId) await openDetail(current.id);
            } catch (error) {
              if (!(await expireSession(error))) approvalStatus.textContent = error instanceof AdminApiError ? error.message : '調整決定失敗。';
            }
          });
          controls.append(button);
        }
        card.append(summary, controls);
        approvalList.append(card);
      }
      if (!requests.length) approvalList.append(ledgerCard('目前沒有待核准申請', '新的帳務調整申請會顯示於此。'));
      approvalStatus.textContent = `待核准 ${requests.length} 筆。`;
    } catch (error) {
      if (!(await expireSession(error))) approvalStatus.textContent = error instanceof AdminApiError ? error.message : '核准佇列載入失敗。';
    }
  }

  async function openDetail(id, detailOpener = null) {
    opener = detailOpener ?? opener;
    detail.hidden = false;
    detail.focus();
    detailStatus.textContent = '正在載入帳單明細…';
    try {
      current = await getAdminInvoice(id);
      detailFields.replaceChildren(
        field(document, '帳單號碼', current.invoiceNo),
        field(document, '狀態', STATUS_LABELS[current.status]),
        field(document, '客戶', `${current.customer.no}｜${current.customer.name}`),
        field(document, '服務合約', current.subscription?.no),
        field(document, '帳期', `${current.billingPeriod.start}－${current.billingPeriod.end}`),
        field(document, '繳款期限', current.dueDate),
        field(document, '未稅金額', `NT$ ${current.subtotalAmount}`),
        field(document, '稅額', `NT$ ${current.taxAmount}`),
        field(document, '總額', `NT$ ${current.totalAmount}`),
        field(document, '未繳餘額', `NT$ ${current.balanceDue}`),
      );
      itemsBody.replaceChildren();
      for (const item of current.items) {
        const row = document.createElement('tr');
        for (const value of [
          item.description, `${item.period.start}－${item.period.end}`,
          item.quantity, `NT$ ${item.unitPrice}`, `NT$ ${item.lineAmount}`, `NT$ ${item.taxAmount}`,
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        itemsBody.append(row);
      }
      renderActions(current);
      await loadActivity(current.id);
      detailStatus.textContent = '帳單明細已載入。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '帳單明細載入失敗。';
    }
  }

  async function transition(action) {
    const body = { expectedUpdatedAt: current.updatedAt };
    if (action === 'void') {
      const reason = globalThis.prompt('請輸入作廢原因：');
      if (!reason?.trim()) return;
      body.reason = reason.trim();
    }
    try {
      const outcome = await gate.run(() => transitionAdminInvoice(current.id, action, body));
      if (!outcome.accepted) return;
      await openDetail(outcome.value.id);
      await load();
      detailStatus.textContent = '帳單狀態已更新。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '帳單狀態更新失敗。';
    }
  }

  actions.addEventListener('click', (event) => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (action) void transition(action);
  });
  generateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    generateStatus.textContent = '正在產生單筆帳單…';
    try {
      const outcome = await gate.run(() => generateAdminInvoice({
        subscriptionId: Number(generateForm.elements.namedItem('subscriptionId').value),
        ...periodBody(generateForm),
      }));
      if (!outcome.accepted) return;
      generateStatus.textContent = `已建立 ${outcome.value.invoiceNo}。`;
      await load();
      await openDetail(outcome.value.id, generateForm.querySelector('button[type="submit"]'));
    } catch (error) {
      if (!(await expireSession(error))) generateStatus.textContent = error instanceof AdminApiError ? error.message : '單筆出帳失敗。';
    }
  });
  batchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    batchStatus.textContent = '正在執行批次出帳…';
    try {
      const outcome = await gate.run(() => generateAdminInvoiceBatch(periodBody(batchForm)));
      if (!outcome.accepted) return;
      const { created, failed } = outcome.value.summary;
      batchStatus.textContent = `批次完成：成功 ${created} 筆，失敗 ${failed} 筆。`;
      await load();
    } catch (error) {
      if (!(await expireSession(error))) batchStatus.textContent = error instanceof AdminApiError ? error.message : '批次出帳失敗。';
    }
  });
  paymentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    paymentStatus.textContent = '正在確認付款入帳…';
    const paidAt = paymentForm.elements.namedItem('paidAt').value;
    try {
      const outcome = await gate.run(() => postAdminPayment({
        invoiceId: current.id, expectedUpdatedAt: current.updatedAt,
        idempotencyKey: globalThis.crypto.randomUUID(),
        amount: paymentForm.elements.namedItem('amount').value.trim(),
        paymentMethod: paymentForm.elements.namedItem('paymentMethod').value,
        transactionReference: paymentForm.elements.namedItem('transactionReference').value.trim() || null,
        paidAt: new Date(paidAt).toISOString(),
        notes: paymentForm.elements.namedItem('notes').value.trim() || null,
      }));
      if (!outcome.accepted) return;
      paymentForm.reset();
      await openDetail(current.id);
      await load();
      paymentStatus.textContent = `已入帳 ${outcome.value.payment.paymentNo}。`;
    } catch (error) {
      if (!(await expireSession(error))) paymentStatus.textContent = error instanceof AdminApiError ? error.message : '付款入帳失敗。';
    }
  });
  adjustmentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    adjustmentStatus.textContent = '正在送出調整申請…';
    try {
      const outcome = await gate.run(() => requestAdminBillingAdjustment({
        invoiceId: current.id,
        adjustmentType: adjustmentForm.elements.namedItem('adjustmentType').value,
        amount: adjustmentForm.elements.namedItem('amount').value.trim(),
        reason: adjustmentForm.elements.namedItem('reason').value.trim(),
      }));
      if (!outcome.accepted) return;
      adjustmentForm.reset();
      await loadActivity(current.id);
      await loadApprovals();
      adjustmentStatus.textContent = `已送出 ${outcome.value.requestNo}。`;
    } catch (error) {
      if (!(await expireSession(error))) adjustmentStatus.textContent = error instanceof AdminApiError ? error.message : '調整申請失敗。';
    }
  });
  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void load(); });
  refreshButton.addEventListener('click', load);
  approvalRefresh.addEventListener('click', loadApprovals);
  detailClose.addEventListener('click', () => {
    detail.hidden = true;
    current = null;
    opener?.focus();
  });

  return {
    async show({ invoiceId = null, approvalPermission = false } = {}) {
      page.hidden = false;
      canApprove = approvalPermission;
      await load();
      await loadApprovals();
      if (invoiceId && /^\d+$/.test(invoiceId)) await openDetail(Number(invoiceId));
    },
    hide() { page.hidden = true; detail.hidden = true; approval.hidden = true; current = null; },
  };
}
