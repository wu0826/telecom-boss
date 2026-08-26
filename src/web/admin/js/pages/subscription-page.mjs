import {
  AdminApiError, getAdminSubscription, getAdminSubscriptions, saveAdminServiceAccount,
  transitionAdminSubscription,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const STATUS_LABELS = {
  PENDING: '待啟用', ACTIVE: '使用中', SUSPENDED: '暫停', TERMINATED: '已終止', EXPIRED: '已到期',
};

function detailField(document, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value ?? '—';
  wrapper.append(term, description);
  return wrapper;
}

function actionButton(document, label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'table-action';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function setNullable(form, name, value) {
  form.elements.namedItem(name).value = value ?? '';
}

export function createSubscriptionPage({
  document, page, filterForm, refreshButton, clearButton, results, resultsBody, listStatus,
  detail, detailStatus, detailClose, tabs, panels, overviewFields, sourceLinks,
  accountForm, accountStatus, historyList, lifecycleActions,
  onSessionExpired = () => {},
}) {
  let current = null;
  let opener = null;
  const gate = createSubmissionGate();

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function activateTab(button) {
    for (const tab of tabs.querySelectorAll('[role="tab"]')) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels.get(tab.dataset.panel).hidden = !selected;
    }
  }

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[role="tab"]');
    if (button) activateTab(button);
  });

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
    listStatus.textContent = '正在載入服務合約…';
    try {
      const subscriptions = await getAdminSubscriptions(search());
      resultsBody.replaceChildren();
      for (const subscription of subscriptions) {
        const row = document.createElement('tr');
        for (const value of [
          subscription.subscriptionNo, subscription.customer.name, subscription.servicePlan.name,
          `NT$ ${subscription.monthlyFee}`, STATUS_LABELS[subscription.status],
          subscription.contract.start ? `${subscription.contract.start}～${subscription.contract.end}` : '未設定',
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        const action = document.createElement('td');
        action.append(actionButton(document, '查看', (event) => void openDetail(
          subscription.id, event.currentTarget,
        )));
        row.append(action);
        resultsBody.append(row);
      }
      if (!subscriptions.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'table-empty';
        cell.textContent = '目前沒有符合條件的服務合約。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `共 ${subscriptions.length} 筆服務合約。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = error instanceof AdminApiError ? error.message : '服務合約載入失敗。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function renderSources(subscription) {
    sourceLinks.replaceChildren();
    if (subscription.sourceOrder) {
      const order = document.createElement('a');
      order.href = `#orders?orderId=${encodeURIComponent(subscription.sourceOrder.id)}`;
      order.textContent = `來源訂單 ${subscription.sourceOrder.orderNo}`;
      sourceLinks.append(order);
    }
    for (const workOrder of subscription.workOrders) {
      const link = document.createElement('a');
      link.href = `#operations?workOrderId=${encodeURIComponent(workOrder.id)}`;
      link.textContent = `${workOrder.workOrderNo}｜${workOrder.status}`;
      sourceLinks.append(link);
    }
    if (!sourceLinks.childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = '目前沒有關聯訂單或工單。';
      sourceLinks.append(empty);
    }
  }

  function renderHistory(subscription) {
    historyList.replaceChildren();
    for (const item of subscription.history) {
      const entry = document.createElement('li');
      const transition = document.createElement('strong');
      const meta = document.createElement('span');
      transition.textContent = `${item.fromStatus ? STATUS_LABELS[item.fromStatus] : '建立'} → ${STATUS_LABELS[item.toStatus]}`;
      meta.textContent = `${item.changedBy?.name ?? '系統'}｜${new Date(item.changedAt).toLocaleString('zh-TW')}${item.reason ? `｜${item.reason}` : ''}`;
      entry.append(transition, meta);
      historyList.append(entry);
    }
  }

  function renderAccount(subscription) {
    const account = subscription.serviceAccount;
    setNullable(accountForm, 'circuitNo', account?.circuitNo);
    setNullable(accountForm, 'accessUsername', account?.accessUsername);
    setNullable(accountForm, 'credentialSecretRef', null);
    setNullable(accountForm, 'ipAssignment', account?.ipAssignment ?? 'DYNAMIC');
    setNullable(accountForm, 'staticIp', account?.staticIp);
    setNullable(accountForm, 'vlanId', account?.vlanId);
    accountForm.querySelector('[data-credential-state]').textContent = account?.credentialConfigured
      ? '已設定外部祕密參照；留白可保留原參照。' : '尚未設定外部祕密參照。';
    accountForm.hidden = ['TERMINATED', 'EXPIRED'].includes(subscription.status);
  }

  function renderActions(subscription) {
    const allowed = {
      activate: subscription.status === 'PENDING',
      suspend: subscription.status === 'ACTIVE',
      resume: subscription.status === 'SUSPENDED',
      terminate: ['PENDING', 'ACTIVE', 'SUSPENDED'].includes(subscription.status),
      expire: ['ACTIVE', 'SUSPENDED'].includes(subscription.status),
    };
    for (const button of lifecycleActions.querySelectorAll('button[data-action]')) {
      button.hidden = !allowed[button.dataset.action];
    }
    lifecycleActions.hidden = !Object.values(allowed).some(Boolean);
  }

  async function openDetail(id, detailOpener = null) {
    opener = detailOpener ?? opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入合約明細…';
    detail.focus();
    try {
      current = await getAdminSubscription(id);
      overviewFields.replaceChildren(
        detailField(document, '合約編號', current.subscriptionNo),
        detailField(document, '狀態', STATUS_LABELS[current.status]),
        detailField(document, '客戶', `${current.customer.no}｜${current.customer.name}`),
        detailField(document, '服務地址', current.serviceLocation.address),
        detailField(document, '方案', `${current.servicePlan.code}｜${current.servicePlan.name}`),
        detailField(document, '月租費', `NT$ ${current.monthlyFee}`),
        detailField(document, '合約期間', `${current.contract.start}～${current.contract.end}`),
        detailField(document, '結帳日／續約', `${current.billingDay} 日｜${current.autoRenew ? '自動續約' : '不自動續約'}`),
      );
      renderSources(current);
      renderAccount(current);
      renderHistory(current);
      renderActions(current);
      activateTab(tabs.querySelector('[role="tab"]'));
      detailStatus.textContent = '合約明細已載入。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '合約明細載入失敗。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    current = null;
    overviewFields.replaceChildren();
    sourceLinks.replaceChildren();
    historyList.replaceChildren();
    opener?.focus();
  }

  async function transition(action) {
    const needsReason = ['suspend', 'terminate'].includes(action);
    const reason = needsReason ? globalThis.prompt('請輸入異動原因：') : null;
    if (needsReason && !reason?.trim()) return;
    detailStatus.textContent = '正在更新合約狀態…';
    try {
      const outcome = await gate.run(() => transitionAdminSubscription(current.id, action, {
        expectedUpdatedAt: current.updatedAt, reason: reason?.trim() || null,
      }));
      if (!outcome.accepted) return;
      await openDetail(outcome.value.id);
      await load();
      detailStatus.textContent = '合約狀態已更新。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '狀態更新失敗。';
    }
  }

  lifecycleActions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) void transition(button.dataset.action);
  });
  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const credentialSecretRef = accountForm.elements.namedItem('credentialSecretRef').value.trim();
    const payload = {
      expectedUpdatedAt: current.updatedAt,
      circuitNo: accountForm.elements.namedItem('circuitNo').value.trim(),
      accessUsername: accountForm.elements.namedItem('accessUsername').value.trim() || null,
      ipAssignment: accountForm.elements.namedItem('ipAssignment').value,
      staticIp: accountForm.elements.namedItem('staticIp').value.trim() || null,
      vlanId: accountForm.elements.namedItem('vlanId').value
        ? Number(accountForm.elements.namedItem('vlanId').value) : null,
    };
    if (credentialSecretRef) payload.credentialSecretRef = credentialSecretRef;
    accountStatus.textContent = '正在儲存安全線路資料…';
    try {
      const outcome = await gate.run(() => saveAdminServiceAccount(current.id, payload));
      if (!outcome.accepted) return;
      await openDetail(outcome.value.id);
      accountStatus.textContent = '線路帳號資料已儲存；祕密值未回傳。';
    } catch (error) {
      if (!(await expireSession(error))) accountStatus.textContent = error instanceof AdminApiError ? error.message : '線路帳號儲存失敗。';
    }
  });
  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void load(); });
  refreshButton.addEventListener('click', load);
  detailClose.addEventListener('click', closeDetail);

  return {
    async show({ subscriptionId = null } = {}) {
      page.hidden = false;
      await load();
      if (subscriptionId && /^\d+$/.test(subscriptionId)) await openDetail(Number(subscriptionId));
    },
    hide() { page.hidden = true; closeDetail(); },
  };
}
