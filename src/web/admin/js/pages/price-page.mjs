import {
  AdminApiError,
  deleteAdminPlanPrice,
  getAdminPlanPrices,
  saveAdminPlanPrice,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const TYPE_LABELS = new Map([
  ['INTRO', '優惠月租'], ['RENEWAL', '續約月租'], ['STANDARD', '標準月租'],
  ['INSTALLATION', '裝機費'], ['DEPOSIT', '押金'],
]);

function value(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function nullableInteger(form, name) {
  const raw = value(form, name);
  return raw ? Number(raw) : null;
}

function payload(form) {
  return {
    priceType: value(form, 'priceType'),
    billingCycle: value(form, 'billingCycle'),
    amount: value(form, 'amount'),
    monthFrom: nullableInteger(form, 'monthFrom'),
    monthTo: nullableInteger(form, 'monthTo'),
    effectiveFrom: value(form, 'effectiveFrom') || null,
    effectiveTo: value(form, 'effectiveTo') || null,
    priority: Number(value(form, 'priority')),
    isActive: form.elements.namedItem('isActive').checked,
  };
}

function setFormValue(form, name, nextValue) {
  const control = form.elements.namedItem(name);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = Boolean(nextValue);
  else control.value = nextValue ?? '';
}

function periodLabel(price) {
  const months = price.billingCycle === 'ONE_TIME'
    ? '一次性'
    : `第 ${price.monthFrom}–${price.monthTo ?? '不限'} 月`;
  const dates = `${price.effectiveFrom ?? '不限'} 至 ${price.effectiveTo ?? '不限'}`;
  return `${months}｜${dates}`;
}

export function createPricePage({
  document,
  list,
  form,
  status,
  resetButton,
  deleteButton,
  confirmDelete = () => globalThis.confirm('確定刪除此未被訂單引用的價格期間？'),
  onChanged = () => {},
  onSessionExpired = () => {},
}) {
  let planId = null;
  let prices = [];
  const gate = createSubmissionGate();

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function toggleMonthFields() {
    const oneTime = value(form, 'billingCycle') === 'ONE_TIME';
    for (const name of ['monthFrom', 'monthTo']) {
      const control = form.elements.namedItem(name);
      control.disabled = oneTime;
      if (oneTime) control.value = '';
    }
  }

  function reset() {
    form.reset();
    setFormValue(form, 'priceId', '');
    setFormValue(form, 'expectedUpdatedAt', '');
    setFormValue(form, 'priority', 100);
    setFormValue(form, 'isActive', true);
    deleteButton.hidden = true;
    toggleMonthFields();
  }

  function edit(price) {
    for (const field of [
      'priceType', 'billingCycle', 'amount', 'monthFrom', 'monthTo',
      'effectiveFrom', 'effectiveTo', 'priority', 'isActive',
    ]) setFormValue(form, field, price[field]);
    setFormValue(form, 'priceId', price.id);
    setFormValue(form, 'expectedUpdatedAt', price.updatedAt);
    deleteButton.hidden = false;
    toggleMonthFields();
    form.elements.namedItem('amount').focus();
  }

  function render() {
    list.replaceChildren();
    if (!prices.length) {
      const empty = document.createElement('p');
      empty.className = 'plan-price-list__empty';
      empty.textContent = '尚未設定價格期間。';
      list.append(empty);
      return;
    }
    for (const price of prices) {
      const card = document.createElement('article');
      card.className = 'plan-price-card';
      const heading = document.createElement('strong');
      heading.textContent = `${TYPE_LABELS.get(price.priceType) ?? price.priceType}｜NT$ ${price.amount}`;
      const details = document.createElement('span');
      details.textContent = `${periodLabel(price)}｜優先序 ${price.priority}｜${price.isActive ? '啟用' : '停用'}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'table-action';
      button.textContent = '編輯';
      button.addEventListener('click', () => edit(price));
      card.append(heading, details, button);
      list.append(card);
    }
  }

  async function load(nextPlanId = planId) {
    planId = nextPlanId;
    status.textContent = '正在載入價格期間…';
    try {
      prices = await getAdminPlanPrices(planId);
      render();
      status.textContent = `共 ${prices.length} 個價格期間；金額以含稅元顯示。`;
    } catch (error) {
      if (!(await expireSession(error))) status.textContent = '價格期間載入失敗。';
    }
  }

  form.elements.namedItem('billingCycle').addEventListener('change', toggleMonthFields);
  resetButton.addEventListener('click', reset);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const priceId = value(form, 'priceId');
    const body = payload(form);
    if (priceId) body.expectedUpdatedAt = value(form, 'expectedUpdatedAt');
    status.textContent = '正在儲存價格期間…';
    try {
      const outcome = await gate.run(() => saveAdminPlanPrice(planId, priceId, body));
      if (!outcome.accepted) return;
      reset();
      await load();
      await onChanged();
      status.textContent = '價格期間已儲存，公開預覽已更新。';
    } catch (error) {
      if (!(await expireSession(error))) {
        status.textContent = error instanceof AdminApiError ? error.message : '價格期間儲存失敗。';
      }
    }
  });
  deleteButton.addEventListener('click', async () => {
    const priceId = value(form, 'priceId');
    if (!priceId || !confirmDelete()) return;
    status.textContent = '正在刪除價格期間…';
    try {
      const outcome = await gate.run(() => deleteAdminPlanPrice(
        planId, priceId, value(form, 'expectedUpdatedAt'),
      ));
      if (!outcome.accepted) return;
      reset();
      await load();
      await onChanged();
      status.textContent = '價格期間已刪除，公開預覽已更新。';
    } catch (error) {
      if (!(await expireSession(error))) {
        status.textContent = error instanceof AdminApiError ? error.message : '價格期間刪除失敗。';
      }
    }
  });

  reset();
  return { load, reset };
}
