import {
  AdminApiError, addAdminOutageSubscription, createAdminOutage, getAdminOutage,
  getAdminOutages, removeAdminOutageSubscription, transitionAdminOutage,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const STATUS_LABELS = {
  INVESTIGATING: '調查中', IDENTIFIED: '已定位', MONITORING: '觀察中', RESOLVED: '已恢復',
};
const SEVERITY_LABELS = { MINOR: '輕微', MAJOR: '重大', CRITICAL: '嚴重' };

function field(document, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label; description.textContent = value ?? '—';
  wrapper.append(term, description); return wrapper;
}

function button(document, label, handler, className = 'table-action') {
  const element = document.createElement('button');
  element.type = 'button'; element.className = className; element.textContent = label;
  element.addEventListener('click', handler); return element;
}

export function createOutagePage({
  document, page, filterForm, refreshButton, clearButton, results, resultsBody, listStatus,
  createForm, createStatus, detail, detailStatus, detailClose, detailFields,
  membershipForm, membershipList, publicDraft, workflowActions,
  onSessionExpired = () => {},
}) {
  let current = null;
  let opener = null;
  const gate = createSubmissionGate();

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired(); return true;
    }
    return false;
  }

  function search() {
    const params = new URLSearchParams();
    for (const name of ['q', 'severity', 'status']) {
      const value = filterForm.elements.namedItem(name).value.trim();
      if (value) params.set(name, value);
    }
    return params.size ? `?${params}` : '';
  }

  async function load() {
    results.setAttribute('aria-busy', 'true'); refreshButton.disabled = true;
    listStatus.textContent = '正在載入障礙事件…';
    try {
      const incidents = await getAdminOutages(search());
      resultsBody.replaceChildren();
      for (const incident of incidents) {
        const row = document.createElement('tr');
        for (const value of [
          incident.incidentNo, incident.title, SEVERITY_LABELS[incident.severity],
          STATUS_LABELS[incident.status], `${incident.impact.subscriptions} 服務／${incident.impact.customers} 客戶`,
          new Date(incident.detectedAt).toLocaleString('zh-TW'),
        ]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        const action = document.createElement('td');
        action.append(button(document, '查看', (event) => void openDetail(incident.id, event.currentTarget)));
        row.append(action); resultsBody.append(row);
      }
      if (!incidents.length) {
        const row = document.createElement('tr'); const cell = document.createElement('td');
        cell.colSpan = 7; cell.className = 'table-empty'; cell.textContent = '目前沒有符合條件的障礙事件。';
        row.append(cell); resultsBody.append(row);
      }
      listStatus.textContent = `共 ${incidents.length} 起障礙事件。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = error instanceof AdminApiError ? error.message : '障礙事件載入失敗。';
    } finally { results.setAttribute('aria-busy', 'false'); refreshButton.disabled = false; }
  }

  function renderMemberships(incident) {
    membershipList.replaceChildren();
    for (const subscription of incident.subscriptions) {
      const card = document.createElement('article');
      const summary = document.createElement('div');
      const heading = document.createElement('strong'); const meta = document.createElement('span');
      heading.textContent = `${subscription.subscriptionNo}｜${subscription.plan.name}`;
      meta.textContent = `${subscription.customer.name}｜${subscription.status}`;
      summary.append(heading, meta);
      const remove = button(document, '移除', async () => {
        try {
          const outcome = await gate.run(() => removeAdminOutageSubscription(
            current.id, subscription.id, current.updatedAt,
          ));
          if (!outcome.accepted) return;
          await openDetail(outcome.value.id); await load();
        } catch (error) {
          if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '移除失敗。';
        }
      }, 'secondary-button');
      remove.hidden = incident.status === 'RESOLVED';
      card.append(summary, remove); membershipList.append(card);
    }
    if (!incident.subscriptions.length) {
      const empty = document.createElement('p'); empty.textContent = '尚未加入受影響服務。'; membershipList.append(empty);
    }
  }

  function renderWorkflow(incident) {
    workflowActions.querySelector('.outage-transition-editor')?.remove();
    const allowed = {
      identify: incident.status === 'INVESTIGATING',
      monitor: incident.status === 'IDENTIFIED',
      resolve: incident.status === 'MONITORING',
    };
    for (const action of workflowActions.querySelectorAll('button[data-action]')) {
      action.hidden = !allowed[action.dataset.action];
    }
    workflowActions.hidden = incident.status === 'RESOLVED';
    membershipForm.hidden = incident.status === 'RESOLVED';
  }

  async function openDetail(id, detailOpener = null) {
    opener = detailOpener ?? opener; detail.hidden = false; detail.focus();
    detailStatus.textContent = '正在載入事件明細…';
    try {
      current = await getAdminOutage(id);
      detailFields.replaceChildren(
        field(document, '事件編號', current.incidentNo), field(document, '狀態', STATUS_LABELS[current.status]),
        field(document, '嚴重度', SEVERITY_LABELS[current.severity]), field(document, '標題', current.title),
        field(document, '偵測時間', new Date(current.detectedAt).toLocaleString('zh-TW')),
        field(document, '恢復時間', current.resolvedAt ? new Date(current.resolvedAt).toLocaleString('zh-TW') : null),
        field(document, '影響範圍', `${current.impact.subscriptions} 服務／${current.impact.customers} 客戶`),
        field(document, '根本原因', current.rootCause), field(document, '處理說明', current.resolutionNotes),
      );
      renderMemberships(current); renderWorkflow(current);
      publicDraft.textContent = current.publicAnnouncementDraft;
      detailStatus.textContent = '事件明細已載入。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '事件明細載入失敗。';
    }
  }

  async function transition(action, value) {
    const note = value.trim();
    if (!note) return false;
    const body = { expectedUpdatedAt: current.updatedAt };
    if (action === 'identify') body.rootCause = note; else body.resolutionNotes = note;
    try {
      const outcome = await gate.run(() => transitionAdminOutage(current.id, action, body));
      if (!outcome.accepted) return false;
      await openDetail(outcome.value.id); await load(); detailStatus.textContent = '事件狀態已更新。';
      return true;
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '事件更新失敗。';
      return false;
    }
  }

  function openTransitionEditor(action, trigger) {
    workflowActions.querySelector('.outage-transition-editor')?.remove();
    const editor = document.createElement('form');
    editor.className = 'outage-form outage-transition-editor';
    const label = document.createElement('label');
    label.textContent = action === 'identify' ? '根本原因' : '處理／恢復說明';
    const textarea = document.createElement('textarea');
    textarea.name = 'workflowNote'; textarea.rows = 3; textarea.maxLength = 2000; textarea.required = true;
    label.append(textarea);
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const submit = document.createElement('button');
    submit.type = 'submit'; submit.className = 'primary-button'; submit.textContent = '確認更新';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { editor.remove(); trigger.focus(); });
    actions.append(submit, cancel); editor.append(label, actions); workflowActions.append(editor);
    editor.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true; cancel.disabled = true; detailStatus.textContent = '正在更新事件狀態…';
      const succeeded = await transition(action, textarea.value);
      if (succeeded) editor.remove();
      else { submit.disabled = false; cancel.disabled = false; textarea.focus(); }
    });
    textarea.focus();
  }

  workflowActions.addEventListener('click', (event) => {
    const trigger = event.target.closest('button[data-action]');
    if (trigger) openTransitionEditor(trigger.dataset.action, trigger);
  });
  membershipForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const outcome = await gate.run(() => addAdminOutageSubscription(current.id, {
        expectedUpdatedAt: current.updatedAt,
        subscriptionId: Number(membershipForm.elements.namedItem('subscriptionId').value),
        notes: membershipForm.elements.namedItem('notes').value.trim() || null,
      }));
      if (!outcome.accepted) return;
      membershipForm.reset(); await openDetail(outcome.value.id); await load();
      detailStatus.textContent = '已加入受影響服務。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '加入影響服務失敗。';
    }
  });
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault(); createStatus.textContent = '正在建立障礙事件…';
    const detected = createForm.elements.namedItem('detectedAt').value;
    try {
      const outcome = await gate.run(() => createAdminOutage({
        title: createForm.elements.namedItem('title').value.trim(),
        severity: createForm.elements.namedItem('severity').value,
        serviceAreaId: createForm.elements.namedItem('serviceAreaId').value
          ? Number(createForm.elements.namedItem('serviceAreaId').value) : null,
        detectedAt: new Date(detected).toISOString(),
      }));
      if (!outcome.accepted) return;
      createForm.reset(); createStatus.textContent = `已建立 ${outcome.value.incidentNo}。`;
      await load(); await openDetail(outcome.value.id, createForm.querySelector('button[type="submit"]'));
    } catch (error) {
      if (!(await expireSession(error))) createStatus.textContent = error instanceof AdminApiError ? error.message : '事件建立失敗。';
    }
  });
  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void load(); });
  refreshButton.addEventListener('click', load);
  detailClose.addEventListener('click', () => { detail.hidden = true; current = null; opener?.focus(); });

  return {
    async show({ outageId = null } = {}) { page.hidden = false; await load(); if (outageId && /^\d+$/.test(outageId)) await openDetail(Number(outageId)); },
    hide() { page.hidden = true; detail.hidden = true; current = null; },
  };
}
