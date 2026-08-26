import {
  AdminApiError,
  createAdminPlan,
  deleteAdminPlan,
  getAdminPlan,
  getAdminPlanPreview,
  getAdminPlans,
  publishAdminPlan,
  updateAdminPlan,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';
import { createPricePage } from './price-page.mjs?v=20260722-access-create';

const CATEGORY_LABELS = new Map([
  ['BROADBAND', '寬頻上網'], ['ENTERPRISE_LEASE', '企業專線'],
  ['LOW_VOLTAGE', '弱電工程'], ['OTHER', '其他'],
]);

function value(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function nullableText(form, name) {
  return value(form, name) || null;
}

function nullableInteger(form, name) {
  const raw = value(form, name);
  return raw ? Number(raw) : null;
}

function planPayload(form) {
  return {
    planCode: value(form, 'planCode'),
    planName: value(form, 'planName'),
    serviceCategory: value(form, 'serviceCategory'),
    technology: value(form, 'technology'),
    downloadMbps: nullableInteger(form, 'downloadMbps'),
    uploadMbps: nullableInteger(form, 'uploadMbps'),
    bandwidthLabel: nullableText(form, 'bandwidthLabel'),
    contractMonths: Number(value(form, 'contractMonths')),
    wifiIncluded: form.elements.namedItem('wifiIncluded').checked,
    description: nullableText(form, 'description'),
    effectiveFrom: nullableText(form, 'effectiveFrom'),
    effectiveTo: nullableText(form, 'effectiveTo'),
  };
}

function setFormValue(form, name, nextValue) {
  const control = form.elements.namedItem(name);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = Boolean(nextValue);
  else control.value = nextValue ?? '';
}

function fillForm(form, plan) {
  for (const field of [
    'planCode', 'planName', 'serviceCategory', 'technology', 'downloadMbps',
    'uploadMbps', 'bandwidthLabel', 'contractMonths', 'wifiIncluded', 'description',
    'effectiveFrom', 'effectiveTo',
  ]) setFormValue(form, field, plan[field]);
  setFormValue(form, 'expectedUpdatedAt', plan.updatedAt);
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

function previewField(document, term, description) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = description ?? '—';
  wrapper.append(dt, dd);
  return wrapper;
}

export function createPlanPage({
  document,
  page,
  filterForm,
  results,
  resultsBody,
  listStatus,
  refreshButton,
  clearButton,
  createForm,
  createStatus,
  detail,
  detailClose,
  detailStatus,
  editForm,
  preview,
  publishButton,
  unpublishButton,
  deleteButton,
  priceList,
  priceForm,
  priceStatus,
  priceResetButton,
  priceDeleteButton,
  confirmDelete = () => globalThis.confirm('確定刪除此未被引用的草稿方案？'),
  onSessionExpired = () => {},
}) {
  let currentPlan = null;
  let detailOpener = null;
  const gate = createSubmissionGate();

  const pricePage = createPricePage({
    document,
    list: priceList,
    form: priceForm,
    status: priceStatus,
    resetButton: priceResetButton,
    deleteButton: priceDeleteButton,
    async onChanged() {
      const projection = await getAdminPlanPreview(currentPlan.id);
      renderPreview(projection.plan);
    },
    onSessionExpired,
  });

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function listSearch() {
    const params = new URLSearchParams();
    const query = value(filterForm, 'q');
    const publication = value(filterForm, 'isPublished');
    if (query) params.set('q', query);
    if (publication) params.set('isPublished', publication);
    params.set('sort', 'updatedAt');
    params.set('direction', 'desc');
    const search = params.toString();
    return search ? `?${search}` : '';
  }

  async function load() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入方案…';
    try {
      const envelope = await getAdminPlans(listSearch());
      resultsBody.replaceChildren();
      for (const plan of envelope.data) {
        const row = document.createElement('tr');
        appendCell(document, row, plan.planCode);
        appendCell(document, row, plan.planName);
        appendCell(document, row, CATEGORY_LABELS.get(plan.serviceCategory) ?? plan.serviceCategory);
        appendCell(document, row, plan.bandwidthLabel ?? '—');
        appendCell(document, row, plan.isPublished ? '已發布' : '草稿');
        appendCell(document, row, actionButton(document, '管理', (event) => {
          void openDetail(plan.id, event.currentTarget);
        }));
        resultsBody.append(row);
      }
      if (!envelope.data.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'table-empty';
        cell.textContent = '沒有符合條件的方案。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `本頁 ${envelope.data.length} 筆，共 ${envelope.meta.total} 筆。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = '方案載入失敗，請重新整理。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function renderPreview(plan) {
    preview.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'plan-preview__heading';
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'PUBLIC CATALOG PREVIEW';
    const title = document.createElement('h4');
    title.textContent = plan.name;
    heading.append(eyebrow, title);
    const summary = document.createElement('p');
    summary.textContent = plan.description ?? '尚未提供方案說明。';
    const fields = document.createElement('dl');
    fields.append(
      previewField(document, '方案代碼', plan.code),
      previewField(document, '技術', plan.technology),
      previewField(document, '速率', plan.bandwidthLabel ?? `${plan.downloadMbps ?? '—'}M`),
      previewField(document, '合約期間', `${plan.contractMonths} 個月`),
      previewField(document, 'Wi-Fi', plan.wifiIncluded ? '方案包含' : '未包含'),
      previewField(document, '月租最低', plan.lowestMonthlyAmount ? `NT$ ${plan.lowestMonthlyAmount}` : '尚未設定'),
    );
    const priceHeading = document.createElement('h5');
    priceHeading.textContent = '公開價格呈現';
    const priceList = document.createElement('ul');
    priceList.className = 'plan-preview__prices';
    for (const price of plan.prices) {
      const item = document.createElement('li');
      item.textContent = `${price.label}｜NT$ ${price.amount}`;
      priceList.append(item);
    }
    if (!plan.prices.length) {
      const item = document.createElement('li');
      item.textContent = '尚未設定目前有效的公開價格。';
      priceList.append(item);
    }
    preview.append(heading, summary, fields, priceHeading, priceList);
  }

  function updateActions() {
    publishButton.hidden = currentPlan?.isPublished !== false;
    unpublishButton.hidden = currentPlan?.isPublished !== true;
    deleteButton.disabled = Boolean(currentPlan?.isPublished);
  }

  async function openDetail(planId, opener = detailOpener) {
    detailOpener = opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入方案與公開預覽…';
    detail.focus();
    try {
      const [plan, projection] = await Promise.all([
        getAdminPlan(planId),
        getAdminPlanPreview(planId),
      ]);
      currentPlan = plan;
      fillForm(editForm, plan);
      renderPreview(projection.plan);
      updateActions();
      await pricePage.load(planId);
      detailStatus.textContent = plan.isPublished
        ? '此方案已發布；儲存內容後請再次確認公開預覽。'
        : '此方案目前為草稿，不會顯示於公開網站。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = '方案明細載入失敗。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    currentPlan = null;
    editForm.reset();
    preview.replaceChildren();
    pricePage.reset();
    detailOpener?.focus();
  }

  async function runWrite(operation, successMessage) {
    detailStatus.textContent = '正在儲存…';
    try {
      const outcome = await gate.run(operation);
      if (!outcome.accepted) return;
      await load();
      await openDetail(outcome.value.id);
      detailStatus.textContent = successMessage;
    } catch (error) {
      if (!(await expireSession(error))) {
        detailStatus.textContent = error instanceof AdminApiError ? error.message : '儲存失敗，請稍後再試。';
      }
    }
  }

  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void load(); });
  refreshButton.addEventListener('click', load);
  detailClose.addEventListener('click', closeDetail);

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = createForm.querySelector('button[type="submit"]');
    button.disabled = true;
    createStatus.textContent = '正在建立草稿…';
    try {
      const plan = await createAdminPlan(planPayload(createForm));
      createForm.reset();
      setFormValue(createForm, 'contractMonths', 12);
      createStatus.textContent = `已建立草稿 ${plan.planCode}。`;
      await load();
      await openDetail(plan.id, button);
    } catch (error) {
      if (!(await expireSession(error))) {
        createStatus.textContent = error instanceof AdminApiError ? error.message : '建立方案失敗。';
      }
    } finally {
      button.disabled = false;
    }
  });

  editForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = planPayload(editForm);
    payload.expectedUpdatedAt = value(editForm, 'expectedUpdatedAt');
    void runWrite(() => updateAdminPlan(currentPlan.id, payload), '方案資料與預覽已更新。');
  });
  publishButton.addEventListener('click', () => {
    void runWrite(
      () => publishAdminPlan(currentPlan.id, currentPlan.updatedAt, true),
      '方案已發布至公開網站。',
    );
  });
  unpublishButton.addEventListener('click', () => {
    void runWrite(
      () => publishAdminPlan(currentPlan.id, currentPlan.updatedAt, false),
      '方案已下架；歷史訂單內容不受影響。',
    );
  });
  deleteButton.addEventListener('click', async () => {
    if (!currentPlan || !confirmDelete()) return;
    detailStatus.textContent = '正在刪除草稿…';
    try {
      const outcome = await gate.run(() => deleteAdminPlan(currentPlan.id, currentPlan.updatedAt));
      if (!outcome.accepted) return;
      closeDetail();
      await load();
      listStatus.textContent = '草稿方案已刪除。';
    } catch (error) {
      if (!(await expireSession(error))) {
        detailStatus.textContent = error instanceof AdminApiError ? error.message : '刪除失敗。';
      }
    }
  });

  return {
    async show() {
      page.hidden = false;
      await load();
    },
    hide() {
      page.hidden = true;
      closeDetail();
    },
  };
}
