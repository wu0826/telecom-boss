import {
  AdminApiError, createAdminWorkOrder, getAdminWorkOrder, getAdminWorkOrders,
  transitionAdminWorkOrder,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const STATUS_LABELS = {
  OPEN: '待指派', ASSIGNED: '已指派', SCHEDULED: '已排程', IN_PROGRESS: '處理中',
  COMPLETED: '已完工', CANCELLED: '已取消',
};
const TYPE_LABELS = {
  SURVEY: '場勘', INSTALL: '裝機', REPAIR: '維修', MAINTENANCE: '保養',
  RELOCATION: '移機', REMOVAL: '拆機',
};
const VIEW_LABELS = { queue: '工單佇列', calendar: '排程行事曆', kanban: '狀態看板' };
const VIEW_NAMES = new Set(Object.keys(VIEW_LABELS));
const STATUS_NAMES = new Set(Object.keys(STATUS_LABELS));
const MAX_DATE_WINDOW_DAYS = 31;
const TAIPEI_UTC_OFFSET = '+08:00';

function boundedText(value, maxLength = 100) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return '';
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? '' : value;
}

function addDays(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function boundedStaffUserId(value) {
  if (!/^\d+$/.test(String(value ?? ''))) return '';
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 100_000 ? String(id) : '';
}

function normalizeWorkOrderViewState(value = {}) {
  const from = calendarDate(value.from);
  let to = calendarDate(value.to);
  if (from && to) {
    if (to < from) to = '';
    else if (to > addDays(from, MAX_DATE_WINDOW_DAYS - 1)) to = addDays(from, MAX_DATE_WINDOW_DAYS - 1);
  }
  const status = String(value.status ?? '');
  const view = String(value.view ?? '');
  return {
    keyword: boundedText(value.keyword),
    status: STATUS_NAMES.has(status) ? status : '',
    assignedStaffUserId: boundedStaffUserId(value.assignedStaffUserId),
    from,
    to,
    view: VIEW_NAMES.has(view) ? view : 'queue',
  };
}

export function parseWorkOrderViewState(search) {
  const params = new URLSearchParams(search);
  return normalizeWorkOrderViewState({
    keyword: params.get('q'),
    status: params.get('status'),
    assignedStaffUserId: params.get('assignedStaffUserId'),
    from: params.get('from'),
    to: params.get('to'),
    view: params.get('view'),
  });
}

export function serializeWorkOrderViewState(value) {
  const state = normalizeWorkOrderViewState(value);
  const params = new URLSearchParams();
  if (state.keyword) params.set('q', state.keyword);
  if (state.status) params.set('status', state.status);
  if (state.assignedStaffUserId) params.set('assignedStaffUserId', state.assignedStaffUserId);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.view !== 'queue') params.set('view', state.view);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function taipeiMidnight(value) {
  return new Date(`${value}T00:00:00${TAIPEI_UTC_OFFSET}`).toISOString();
}

export function buildWorkOrderRequestSearch(value) {
  const state = normalizeWorkOrderViewState(value);
  const params = new URLSearchParams();
  if (state.keyword) params.set('q', state.keyword);
  if (state.status) params.set('status', state.status);
  if (state.assignedStaffUserId) params.set('assignedStaffUserId', state.assignedStaffUserId);
  if (state.from) params.set('from', taipeiMidnight(state.from));
  if (state.to) params.set('to', taipeiMidnight(addDays(state.to, 1)));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function nullableNumber(form, name) {
  const value = form.elements.namedItem(name).value;
  return value === '' ? null : Number(value);
}

function localToIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function detailField(document, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value ?? '—';
  wrapper.append(term, description);
  return wrapper;
}

function actionButton(document, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'table-action';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function groupLabel(workOrder) {
  if (!workOrder.scheduledAt) return '未排程';
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'full', timeZone: 'Asia/Taipei' }).format(new Date(workOrder.scheduledAt));
}

function scheduledDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const named = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${named.year}-${named.month}-${named.day}`;
}

function scheduledTimeLabel(value) {
  if (!value) return '未排程';
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
  }).format(new Date(value));
}

function filterControl(form, name, value) {
  const control = form.elements.namedItem(name);
  if (control) control.value = value ?? '';
}

function fillFilterForm(form, state) {
  filterControl(form, 'q', state.keyword);
  filterControl(form, 'status', state.status);
  filterControl(form, 'assignedStaffUserId', state.assignedStaffUserId);
  filterControl(form, 'from', state.from);
  filterControl(form, 'to', state.to);
}

function readFilterState(form, view) {
  return normalizeWorkOrderViewState({
    keyword: form.elements.namedItem('q').value,
    status: form.elements.namedItem('status').value,
    assignedStaffUserId: form.elements.namedItem('assignedStaffUserId').value,
    from: form.elements.namedItem('from').value,
    to: form.elements.namedItem('to').value,
    view,
  });
}

function dateRangeError(form) {
  const from = calendarDate(form.elements.namedItem('from').value);
  const to = calendarDate(form.elements.namedItem('to').value);
  if (!from || !to) return '';
  if (to < from) return '結束日期不可早於起始日期。';
  if (to > addDays(from, MAX_DATE_WINDOW_DAYS - 1)) return '日期區間最多 31 天，請縮短查詢範圍。';
  return '';
}

function createPayload(form) {
  return {
    serviceLocationId: Number(form.elements.namedItem('serviceLocationId').value),
    subscriptionId: nullableNumber(form, 'subscriptionId'),
    salesOrderId: nullableNumber(form, 'salesOrderId'),
    workType: form.elements.namedItem('workType').value,
    priority: form.elements.namedItem('priority').value,
    problemDescription: form.elements.namedItem('problemDescription').value.trim() || null,
  };
}

export function createWorkOrderPage({
  document, location, history, page, filterForm, refreshButton, clearButton, viewTabs, groups, listStatus,
  createForm, createStatus, detail, detailFields, historyList, detailStatus, detailClose,
  assignForm, scheduleForm, startButton, completeForm, cancelForm,
  onSessionExpired = () => {},
}) {
  let current = null;
  let opener = null;
  let state = parseWorkOrderViewState(location.search);
  let workOrders = [];
  const gate = createSubmissionGate();

  fillFilterForm(filterForm, state);

  function replaceUrl() {
    const [route = '#operations', routeQuery = ''] = (location.hash || '#operations').split('?');
    const routeParams = new URLSearchParams(routeQuery);
    const workOrderId = routeParams.get('workOrderId');
    const detail = /^\d+$/.test(workOrderId ?? '') ? `?workOrderId=${workOrderId}` : '';
    history.replaceState(null, '', `${serializeWorkOrderViewState(state)}${route}${detail}`);
  }

  function syncViewTabs() {
    for (const button of viewTabs.querySelectorAll('[data-work-order-view]')) {
      const selected = button.dataset.workOrderView === state.view;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) groups.setAttribute('aria-labelledby', button.id);
    }
  }

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function renderEmpty() {
    const empty = document.createElement('p');
    empty.className = 'work-order-empty';
    empty.textContent = '目前沒有符合條件的工單。';
    groups.append(empty);
  }

  function renderQueue(items) {
    groups.replaceChildren();
    const grouped = new Map();
    for (const workOrder of items) {
      const label = groupLabel(workOrder);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(workOrder);
    }
    for (const [label, items] of grouped) {
      const section = document.createElement('section');
      section.className = 'work-order-group';
      const heading = document.createElement('h3');
      heading.textContent = `${label} · ${items.length} 張`;
      const tableWrap = document.createElement('div');
      tableWrap.className = 'work-order-table-wrap';
      const table = document.createElement('table');
      table.className = 'work-order-table';
      const caption = document.createElement('caption');
      caption.className = 'visually-hidden';
      caption.textContent = `${label}工單`;
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const title of ['工單編號', '客戶／地址', '類型', '優先', '狀態', '執行人員', '操作']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = title;
        headRow.append(cell);
      }
      head.append(headRow);
      const body = document.createElement('tbody');
      for (const workOrder of items) {
        const row = document.createElement('tr');
        const values = [
          workOrder.workOrderNo,
          `${workOrder.customer.name}｜${workOrder.serviceLocation.address}`,
          TYPE_LABELS[workOrder.workType],
          workOrder.priority,
          STATUS_LABELS[workOrder.status],
          workOrder.assignedStaff?.name ?? '未指派',
        ];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        const actionCell = document.createElement('td');
        actionCell.append(actionButton(document, '查看', (event) => {
          void openDetail(workOrder.id, event.currentTarget);
        }));
        row.append(actionCell);
        body.append(row);
      }
      table.append(caption, head, body);
      tableWrap.append(table);
      section.append(heading, tableWrap);
      groups.append(section);
    }
    if (!items.length) renderEmpty();
  }

  function workOrderCard(workOrder) {
    const card = document.createElement('article');
    card.className = 'work-order-card';
    const heading = document.createElement('h4');
    heading.textContent = workOrder.workOrderNo;
    const customer = document.createElement('p');
    customer.textContent = workOrder.customer.name;
    const summary = document.createElement('p');
    summary.className = 'work-order-card__summary';
    summary.textContent = `${TYPE_LABELS[workOrder.workType]}｜${workOrder.serviceLocation.address}`;
    const meta = document.createElement('p');
    meta.className = 'work-order-card__meta';
    meta.textContent = `${STATUS_LABELS[workOrder.status]}｜${workOrder.assignedStaff?.name ?? '未指派'}｜${scheduledTimeLabel(workOrder.scheduledAt)}`;
    card.append(heading, customer, summary, meta);
    card.append(actionButton(document, '查看工單', (event) => {
      void openDetail(workOrder.id, event.currentTarget);
    }));
    return card;
  }

  function renderCalendar(items) {
    groups.replaceChildren();
    if (!items.length) {
      renderEmpty();
      return;
    }
    const scheduled = new Map();
    const unscheduled = [];
    for (const workOrder of items) {
      if (!workOrder.scheduledAt) {
        unscheduled.push(workOrder);
        continue;
      }
      const key = scheduledDateKey(workOrder.scheduledAt);
      if (!scheduled.has(key)) scheduled.set(key, []);
      scheduled.get(key).push(workOrder);
    }
    if (unscheduled.length) {
      const unplanned = document.createElement('section');
      unplanned.className = 'work-order-calendar__unplanned';
      const heading = document.createElement('h3');
      heading.textContent = `未排程 · ${unscheduled.length} 張`;
      const list = document.createElement('div');
      list.className = 'work-order-calendar__cards';
      list.append(...unscheduled.map(workOrderCard));
      unplanned.append(heading, list);
      groups.append(unplanned);
    }
    const calendar = document.createElement('section');
    calendar.className = 'work-order-calendar';
    calendar.setAttribute('aria-label', '依排程日期排列的工單行事曆');
    for (const [date, dateItems] of [...scheduled.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const day = document.createElement('section');
      day.className = 'work-order-calendar__day';
      const heading = document.createElement('h3');
      heading.textContent = new Intl.DateTimeFormat('zh-TW', {
        weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei',
      }).format(new Date(`${date}T00:00:00${TAIPEI_UTC_OFFSET}`));
      const count = document.createElement('span');
      count.textContent = `${dateItems.length} 張`;
      heading.append(count);
      const list = document.createElement('div');
      list.className = 'work-order-calendar__cards';
      list.append(...dateItems.map(workOrderCard));
      day.append(heading, list);
      calendar.append(day);
    }
    if (scheduled.size) groups.append(calendar);
  }

  function renderKanban(items) {
    groups.replaceChildren();
    if (!items.length) {
      renderEmpty();
      return;
    }
    const board = document.createElement('section');
    board.className = 'work-order-kanban';
    board.setAttribute('aria-label', '依工單狀態排列的看板');
    for (const status of Object.keys(STATUS_LABELS)) {
      const column = document.createElement('section');
      column.className = 'work-order-kanban__column';
      const statusItems = items.filter((workOrder) => workOrder.status === status);
      const heading = document.createElement('h3');
      heading.textContent = STATUS_LABELS[status];
      const count = document.createElement('span');
      count.textContent = String(statusItems.length);
      heading.append(count);
      const list = document.createElement('div');
      list.className = 'work-order-kanban__cards';
      list.append(...statusItems.map(workOrderCard));
      if (!statusItems.length) {
        const empty = document.createElement('p');
        empty.className = 'work-order-kanban__empty';
        empty.textContent = '目前無工單';
        list.append(empty);
      }
      column.append(heading, list);
      board.append(column);
    }
    groups.append(board);
  }

  function renderWorkOrders() {
    if (state.view === 'calendar') renderCalendar(workOrders);
    else if (state.view === 'kanban') renderKanban(workOrders);
    else renderQueue(workOrders);
  }

  async function load() {
    groups.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入工單佇列…';
    try {
      workOrders = await getAdminWorkOrders(buildWorkOrderRequestSearch(state));
      renderWorkOrders();
      listStatus.textContent = `共 ${workOrders.length} 張工單，顯示為${VIEW_LABELS[state.view]}。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = error instanceof AdminApiError ? error.message : '工單載入失敗。';
    } finally {
      groups.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function renderHistory(items) {
    historyList.replaceChildren();
    for (const item of items) {
      const entry = document.createElement('li');
      const transition = document.createElement('strong');
      const meta = document.createElement('span');
      transition.textContent = `${item.fromStatus ? STATUS_LABELS[item.fromStatus] : '建立'} → ${STATUS_LABELS[item.toStatus]}`;
      meta.textContent = `${item.changedBy?.name ?? '系統'}｜${new Date(item.changedAt).toLocaleString('zh-TW')}`;
      entry.append(transition, meta);
      historyList.append(entry);
    }
  }

  function renderActions(workOrder) {
    assignForm.hidden = workOrder.status !== 'OPEN';
    scheduleForm.hidden = workOrder.status !== 'ASSIGNED';
    startButton.hidden = workOrder.status !== 'SCHEDULED';
    completeForm.hidden = workOrder.status !== 'IN_PROGRESS';
    cancelForm.hidden = !['OPEN', 'ASSIGNED', 'SCHEDULED'].includes(workOrder.status);
    const verified = completeForm.elements.namedItem('installationVerified');
    verified.closest('label').hidden = workOrder.workType !== 'INSTALL';
    verified.required = workOrder.workType === 'INSTALL';
  }

  async function openDetail(id, detailOpener = null) {
    opener = detailOpener ?? opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入工單明細…';
    detail.focus();
    try {
      current = await getAdminWorkOrder(id);
      detailFields.replaceChildren(
        detailField(document, '工單編號', current.workOrderNo),
        detailField(document, '客戶', `${current.customer.no}｜${current.customer.name}`),
        detailField(document, '服務地址', current.serviceLocation.address),
        detailField(document, '類型／優先', `${TYPE_LABELS[current.workType]}｜${current.priority}`),
        detailField(document, '狀態', STATUS_LABELS[current.status]),
        detailField(document, '執行人員', current.assignedStaff?.name),
        detailField(document, '排程時間', current.scheduledAt ? new Date(current.scheduledAt).toLocaleString('zh-TW') : null),
        detailField(document, '問題描述', current.problemDescription),
        detailField(document, '處理結果', current.resolutionNotes),
      );
      renderHistory(current.history);
      renderActions(current);
      detailStatus.textContent = '工單明細已載入。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '工單明細載入失敗。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    current = null;
    detailFields.replaceChildren();
    historyList.replaceChildren();
    opener?.focus();
  }

  async function transition(action, body, success) {
    detailStatus.textContent = '正在更新工單…';
    try {
      const outcome = await gate.run(() => transitionAdminWorkOrder(current.id, action, {
        expectedUpdatedAt: current.updatedAt,
        ...body,
      }));
      if (!outcome.accepted) return;
      await openDetail(outcome.value.id);
      await load();
      detailStatus.textContent = success;
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = error instanceof AdminApiError ? error.message : '工單更新失敗。';
    }
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const error = dateRangeError(filterForm);
    const to = filterForm.elements.namedItem('to');
    to.setCustomValidity(error);
    if (error) {
      listStatus.textContent = error;
      to.reportValidity();
      to.focus();
      return;
    }
    state = readFilterState(filterForm, state.view);
    fillFilterForm(filterForm, state);
    replaceUrl();
    void load();
  });
  clearButton.addEventListener('click', () => {
    state = normalizeWorkOrderViewState({ view: state.view });
    fillFilterForm(filterForm, state);
    syncViewTabs();
    replaceUrl();
    void load();
  });
  refreshButton.addEventListener('click', load);
  viewTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-order-view]');
    if (!button) return;
    state = normalizeWorkOrderViewState({ ...state, view: button.dataset.workOrderView });
    syncViewTabs();
    replaceUrl();
    renderWorkOrders();
    listStatus.textContent = `共 ${workOrders.length} 張工單，顯示為${VIEW_LABELS[state.view]}。`;
  });
  viewTabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...viewTabs.querySelectorAll('[data-work-order-view]')];
    const currentIndex = tabs.indexOf(event.target);
    if (currentIndex === -1) return;
    event.preventDefault();
    const targetIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[targetIndex].click();
    tabs[targetIndex].focus();
  });
  detailClose.addEventListener('click', closeDetail);
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    createStatus.textContent = '正在建立工單…';
    try {
      const outcome = await gate.run(() => createAdminWorkOrder(createPayload(createForm)));
      if (!outcome.accepted) return;
      createForm.reset();
      createStatus.textContent = `已建立 ${outcome.value.workOrderNo}。`;
      await load();
      await openDetail(outcome.value.id, createForm.querySelector('button[type="submit"]'));
    } catch (error) {
      if (!(await expireSession(error))) createStatus.textContent = error instanceof AdminApiError ? error.message : '工單建立失敗。';
    }
  });
  assignForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void transition('assign', { assignedStaffUserId: Number(assignForm.elements.namedItem('assignedStaffUserId').value) }, '工單已指派。');
  });
  scheduleForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void transition('schedule', { scheduledAt: localToIso(scheduleForm.elements.namedItem('scheduledAt').value) }, '工單已排程。');
  });
  startButton.addEventListener('click', () => void transition('start', {}, '工單已開始處理。'));
  completeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const completion = {
      resolutionNotes: completeForm.elements.namedItem('resolutionNotes').value.trim(),
    };
    if (current.workType === 'INSTALL') {
      completion.installationVerified = completeForm.elements.namedItem('installationVerified').checked;
    }
    void transition('complete', completion, '工單已完工。');
  });
  cancelForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void transition('cancel', { reason: cancelForm.elements.namedItem('reason').value.trim() }, '工單已取消。');
  });

  return {
    async show({ workOrderId = null } = {}) {
      page.hidden = false;
      state = parseWorkOrderViewState(location.search);
      fillFilterForm(filterForm, state);
      syncViewTabs();
      await load();
      if (workOrderId && /^\d+$/.test(workOrderId)) await openDetail(Number(workOrderId));
    },
    hide() { page.hidden = true; closeDetail(); },
  };
}
