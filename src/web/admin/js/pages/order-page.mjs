import {
  AdminApiError,
  createAdminOrder,
  getAdminOrder,
  getAdminOrders,
  transitionAdminOrder,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

function value(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function nullableNumber(form, name) {
  const raw = value(form, name);
  return raw ? Number(raw) : null;
}

function appendCell(document, row, content) {
  const cell = document.createElement('td');
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content ?? '—';
  row.append(cell);
}

function actionButton(document, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'table-action';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function detailField(document, term, description) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = description ?? '—';
  wrapper.append(dt, dd);
  return wrapper;
}

function draftPayload(form) {
  const servicePlanId = nullableNumber(form, 'servicePlanId');
  const stockItemId = nullableNumber(form, 'stockItemId');
  return {
    customerId: Number(value(form, 'customerId')),
    serviceLocationId: nullableNumber(form, 'serviceLocationId'),
    engineeringProjectId: nullableNumber(form, 'engineeringProjectId'),
    orderType: value(form, 'orderType'),
    notes: value(form, 'notes') || null,
    serviceItems: servicePlanId ? [{
      servicePlanId,
      planPriceId: Number(value(form, 'planPriceId')),
      promotionId: nullableNumber(form, 'promotionId'),
      quantity: Number(value(form, 'serviceQuantity') || 1),
    }] : [],
    productItems: stockItemId ? [{
      stockItemId,
      quantity: Number(value(form, 'productQuantity') || 1),
    }] : [],
  };
}

export function createOrderPage({
  document,
  page,
  refreshButton,
  results,
  resultsBody,
  listStatus,
  createForm,
  createStatus,
  detail,
  detailFields,
  detailItems,
  detailStatus,
  detailClose,
  useReferencesButton,
  submitButton,
  approveButton,
  cancelButton,
  workOrderLink,
  onSessionExpired = () => {},
}) {
  let currentOrder = null;
  let detailOpener = null;
  let pendingIdempotencyKey = null;
  let canManageOrders = false;
  let canApproveOrders = false;
  const gate = createSubmissionGate();

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  async function load() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入訂單…';
    try {
      const orders = await getAdminOrders();
      resultsBody.replaceChildren();
      for (const order of orders) {
        const row = document.createElement('tr');
        appendCell(document, row, order.orderNo);
        appendCell(document, row, order.customer.name);
        appendCell(document, row, order.orderType);
        appendCell(document, row, order.status);
        appendCell(document, row, `NT$ ${order.total}`);
        appendCell(document, row, actionButton(document, '查看', (event) => {
          void openDetail(order.id, event.currentTarget);
        }));
        resultsBody.append(row);
      }
      if (!orders.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'table-empty';
        cell.textContent = '尚無訂單。可先從洽詢轉換，再於此建立完整草稿。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `目前顯示 ${orders.length} 筆訂單。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = '訂單載入失敗。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function renderItems(order) {
    detailItems.replaceChildren();
    const allItems = [
      ...order.serviceItems.map((item) => ({
        title: `${item.planCode}｜${item.planName}`,
        summary: `${item.priceType}｜${item.quantity} × NT$ ${item.unitPrice}｜${item.promotionCode ?? '無促銷'}`,
      })),
      ...order.productItems.map((item) => ({
        title: `${item.sku}｜${item.itemName}`,
        summary: `${item.quantity} × NT$ ${item.unitPrice}`,
      })),
    ];
    if (!allItems.length) {
      const empty = document.createElement('p');
      empty.textContent = '此草稿尚未加入方案或商品明細。';
      detailItems.append(empty);
      return;
    }
    for (const item of allItems) {
      const card = document.createElement('article');
      const heading = document.createElement('strong');
      const summary = document.createElement('span');
      heading.textContent = item.title;
      summary.textContent = item.summary;
      card.append(heading, summary);
      detailItems.append(card);
    }
  }

  function renderWorkflowActions(order) {
    submitButton.hidden = !canManageOrders || order.status !== 'DRAFT';
    approveButton.hidden = !canApproveOrders || order.status !== 'SUBMITTED';
    cancelButton.hidden = !canManageOrders || !['DRAFT', 'SUBMITTED'].includes(order.status);
    workOrderLink.hidden = !order.workOrder;
    if (order.workOrder) {
      workOrderLink.textContent = `前往工單 ${order.workOrder.workOrderNo}`;
      workOrderLink.href = `#operations?workOrderId=${encodeURIComponent(order.workOrder.id)}`;
    }
  }

  async function openDetail(orderId, opener) {
    detailOpener = opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入訂單關聯…';
    detail.focus();
    try {
      currentOrder = await getAdminOrder(orderId);
      detailFields.replaceChildren(
        detailField(document, '訂單編號', currentOrder.orderNo),
        detailField(document, '客戶', `${currentOrder.customer.no}｜${currentOrder.customer.name}`),
        detailField(document, '服務地址', currentOrder.serviceLocation?.address),
        detailField(document, '工程專案', currentOrder.engineeringProject?.name),
        detailField(document, '狀態', currentOrder.status),
        detailField(document, '未稅／稅額／總額', `NT$ ${currentOrder.amounts.subtotal}／${currentOrder.amounts.tax}／${currentOrder.amounts.total}`),
      );
      renderItems(currentOrder);
      renderWorkflowActions(currentOrder);
      detailStatus.textContent = '訂單主檔、價格快照與關聯明細已載入。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = '訂單明細載入失敗。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    currentOrder = null;
    detailFields.replaceChildren();
    detailItems.replaceChildren();
    detailOpener?.focus();
  }

  useReferencesButton.addEventListener('click', () => {
    if (!currentOrder) return;
    createForm.elements.namedItem('customerId').value = currentOrder.customer.id;
    createForm.elements.namedItem('serviceLocationId').value = currentOrder.serviceLocation?.id ?? '';
    createForm.elements.namedItem('engineeringProjectId').value = currentOrder.engineeringProject?.id ?? '';
    createStatus.textContent = `已帶入 ${currentOrder.orderNo} 的客戶與服務地址。`;
    createForm.elements.namedItem('servicePlanId').focus();
  });

  async function runTransition(action, successMessage) {
    detailStatus.textContent = '正在執行訂單狀態變更…';
    try {
      const outcome = await gate.run(() => transitionAdminOrder(
        currentOrder.id, action, currentOrder.updatedAt,
      ));
      if (!outcome.accepted) return;
      await openDetail(outcome.value.id, detailOpener);
      detailStatus.textContent = successMessage;
      await load();
    } catch (error) {
      if (!(await expireSession(error))) {
        detailStatus.textContent = error instanceof AdminApiError ? error.message : '狀態變更失敗。';
      }
    }
  }

  submitButton.addEventListener('click', () => void runTransition('submit', '訂單已送出審核。'));
  approveButton.addEventListener('click', () => void runTransition('approve', '訂單已核准，裝機工單已建立。'));
  cancelButton.addEventListener('click', () => {
    if (globalThis.confirm('確定取消此訂單？')) void runTransition('cancel', '訂單已取消。');
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    pendingIdempotencyKey ??= crypto.randomUUID();
    createStatus.textContent = '正在解析價格、庫存與訂單快照…';
    try {
      const outcome = await gate.run(() => createAdminOrder(
        draftPayload(createForm), pendingIdempotencyKey,
      ));
      if (!outcome.accepted) return;
      const created = outcome.value;
      pendingIdempotencyKey = null;
      createStatus.textContent = `已建立草稿 ${created.orderNo}，總額 NT$ ${created.amounts.total}。`;
      await load();
      await openDetail(created.id, createForm.querySelector('button[type="submit"]'));
    } catch (error) {
      if (!(await expireSession(error))) {
        createStatus.textContent = error instanceof AdminApiError ? error.message : '訂單建立失敗。';
      }
    }
  });
  refreshButton.addEventListener('click', load);
  detailClose.addEventListener('click', closeDetail);

  return {
    async show({ orderPermission = false, approvalPermission = false, orderId = null } = {}) {
      canManageOrders = orderPermission;
      canApproveOrders = approvalPermission;
      page.hidden = false;
      await load();
      if (orderId && /^\d+$/.test(orderId)) await openDetail(Number(orderId), null);
    },
    hide() { page.hidden = true; closeDetail(); },
  };
}
