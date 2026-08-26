import {
  AdminApiError,
  convertAdminInquiry,
  getAdminInquiries,
  getAdminInquiry,
  getAdminInquiryAssignees,
  updateAdminInquiry,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createStatusBadge, statusPresentation } from '../components.mjs';
import { createSubmissionGate } from '../form-controller.mjs';
import { parseListState, serializeListState } from '../list-state.mjs';

const LIST_OPTIONS = Object.freeze({
  allowedFilters: ['status', 'channel', 'planId', 'assigneeId', 'from', 'to'],
  allowedSorts: ['createdAt', 'inquiryNo', 'status'],
  defaultSort: 'createdAt',
});
const NEXT_STATUSES = new Map([
  ['NEW', [['CONTACTED', '標記為已聯繫']]],
  ['CONTACTED', [['QUALIFIED', '標記為已確認需求'], ['CLOSED', '結案']]],
  ['QUALIFIED', [['CLOSED', '結案']]],
]);
const CHANNEL_LABELS = new Map([
  ['WEB', '網站'],
  ['PHONE', '電話'],
  ['STORE', '門市'],
  ['PARTNER', '合作夥伴'],
  ['OTHER', '其他'],
]);

function setControlValue(form, name, value) {
  const control = form.elements.namedItem(name);
  if (control) control.value = value ?? '';
}

function readFormState(form, currentPage = 1) {
  const data = new FormData(form);
  return {
    keyword: String(data.get('q') ?? ''),
    filters: Object.fromEntries(
      LIST_OPTIONS.allowedFilters
        .map((field) => [field, String(data.get(field) ?? '').trim()])
        .filter(([, value]) => value),
    ),
    page: currentPage,
    pageSize: Number(data.get('pageSize')),
    sort: String(data.get('sort')),
    direction: String(data.get('direction')),
  };
}

function fillForm(form, state) {
  setControlValue(form, 'q', state.keyword);
  for (const field of LIST_OPTIONS.allowedFilters) setControlValue(form, field, state.filters[field]);
  setControlValue(form, 'pageSize', String(state.pageSize));
  setControlValue(form, 'sort', state.sort);
  setControlValue(form, 'direction', state.direction);
}

function appendTextCell(document, row, value) {
  const cell = document.createElement('td');
  cell.textContent = value ?? '—';
  row.append(cell);
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(new Date(value));
}

function renderRow(document, inquiry, openDetail) {
  const row = document.createElement('tr');
  appendTextCell(document, row, inquiry.inquiryNo);
  appendTextCell(document, row, inquiry.prospectName);
  appendTextCell(document, row, inquiry.phone ?? inquiry.email);
  appendTextCell(document, row, inquiry.requestedPlan?.name);
  const statusCell = document.createElement('td');
  statusCell.append(createStatusBadge(document, inquiry.status));
  row.append(statusCell);
  appendTextCell(document, row, inquiry.assignee?.displayName ?? '未指派');
  appendTextCell(document, row, formatDate(inquiry.createdAt));
  const actionCell = document.createElement('td');
  const action = document.createElement('button');
  action.className = 'table-action';
  action.type = 'button';
  action.textContent = '查看';
  action.addEventListener('click', () => openDetail(inquiry.id, action));
  actionCell.append(action);
  row.append(actionCell);
  return row;
}

function appendDefinition(document, list, termText, value) {
  if (value === undefined || value === null || value === '') return;
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = termText;
  const description = document.createElement('dd');
  description.textContent = String(value);
  wrapper.append(term, description);
  list.append(wrapper);
}

function renderDetail(document, fields, inquiry) {
  fields.replaceChildren();
  appendDefinition(document, fields, '洽詢編號', inquiry.inquiryNo);
  appendDefinition(document, fields, '客戶', inquiry.prospectName);
  appendDefinition(document, fields, '電話', inquiry.phone);
  appendDefinition(document, fields, 'Email', inquiry.email);
  appendDefinition(document, fields, '申裝地址', inquiry.addressText);
  appendDefinition(document, fields, '方案', inquiry.requestedPlan?.name);
  appendDefinition(document, fields, '來源', CHANNEL_LABELS.get(inquiry.channel) ?? inquiry.channel);
  appendDefinition(document, fields, '狀態', statusPresentation(inquiry.status).label);
  appendDefinition(document, fields, '承辦人', inquiry.assignee?.displayName ?? '未指派');
  appendDefinition(document, fields, '建立時間', formatDate(inquiry.createdAt));
  appendDefinition(document, fields, '更新時間', formatDate(inquiry.updatedAt));
}

export function createInquiryPage({
  document,
  location,
  history,
  page,
  form,
  results,
  resultsBody,
  listStatus,
  pageSummary,
  previousButton,
  nextButton,
  refreshButton,
  clearButton,
  detail,
  detailFields,
  detailStatus,
  detailClose,
  workflowForm,
  assigneeSelect,
  nextStatusSelect,
  expectedUpdatedAtInput,
  workflowSubmit,
  workflowStatus,
  conversionForm,
  conversionMode,
  existingCustomerField,
  createLocationCheckbox,
  conversionLocationFields,
  conversionSubmit,
  conversionStatus,
  requestList = getAdminInquiries,
  requestDetail = getAdminInquiry,
  requestAssignees = getAdminInquiryAssignees,
  requestUpdate = updateAdminInquiry,
  requestConversion = convertAdminInquiry,
  onSessionExpired = () => {},
}) {
  let state = parseListState(location.search, LIST_OPTIONS);
  let total = 0;
  let detailOpener = null;
  let currentInquiry = null;
  let assignees = null;
  let canWrite = false;
  const updateGate = createSubmissionGate();
  fillForm(form, state);

  function replaceUrl() {
    const search = serializeListState(state, LIST_OPTIONS);
    history.replaceState(null, '', `${search}#inquiries`);
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    pageSummary.textContent = `第 ${state.page} / ${totalPages} 頁，共 ${total} 筆`;
    previousButton.disabled = state.page <= 1;
    nextButton.disabled = state.page >= totalPages;
  }

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
    listStatus.textContent = '正在載入洽詢清單…';
    try {
      const envelope = await requestList(serializeListState(state, LIST_OPTIONS));
      total = envelope.meta.total;
      resultsBody.replaceChildren(...envelope.data.map(
        (inquiry) => renderRow(document, inquiry, openDetail),
      ));
      if (envelope.data.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 8;
        cell.className = 'table-empty';
        cell.textContent = '目前條件沒有符合的洽詢。';
        row.append(cell);
        resultsBody.append(row);
      }
      renderPagination();
      listStatus.textContent = `已載入 ${envelope.data.length} 筆，本次查詢共 ${total} 筆。`;
    } catch (error) {
      if (await expireSession(error)) return;
      resultsBody.replaceChildren();
      total = 0;
      renderPagination();
      listStatus.textContent = '洽詢清單載入失敗，請重新整理再試一次。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  async function loadAssignees() {
    if (assignees !== null) return assignees;
    assignees = await requestAssignees();
    return assignees;
  }

  async function configureWorkflow(inquiry) {
    workflowForm.hidden = true;
    conversionForm.hidden = true;
    workflowStatus.textContent = '';
    conversionStatus.textContent = '';
    if (canWrite && inquiry.status === 'QUALIFIED') {
      conversionForm.reset();
      conversionForm.elements.namedItem('expectedUpdatedAt').value = inquiry.updatedAt;
      conversionForm.elements.namedItem('displayName').value = inquiry.prospectName ?? '';
      conversionForm.elements.namedItem('addressLine').value = inquiry.addressText ?? '';
      conversionForm.hidden = false;
      updateConversionFields();
    }
    if (!canWrite || !NEXT_STATUSES.has(inquiry.status)) return;
    const availableAssignees = await loadAssignees();
    const unassigned = document.createElement('option');
    unassigned.value = '';
    unassigned.textContent = '未指派';
    const assigneeOptions = availableAssignees.map((assignee) => {
      const option = document.createElement('option');
      option.value = String(assignee.id);
      option.textContent = `${assignee.displayName} · ${assignee.department ?? assignee.staffNo}`;
      return option;
    });
    assigneeSelect.replaceChildren(unassigned, ...assigneeOptions);
    assigneeSelect.value = inquiry.assignee ? String(inquiry.assignee.id) : '';

    const unchanged = document.createElement('option');
    unchanged.value = '';
    unchanged.textContent = '維持目前狀態';
    const statusOptions = NEXT_STATUSES.get(inquiry.status).map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    });
    nextStatusSelect.replaceChildren(unchanged, ...statusOptions);
    expectedUpdatedAtInput.value = inquiry.updatedAt;
    workflowForm.hidden = false;
  }

  async function showLoadedInquiry(inquiry) {
    currentInquiry = inquiry;
    renderDetail(document, detailFields, inquiry);
    await configureWorkflow(inquiry);
  }

  async function openDetail(inquiryId, opener) {
    detailOpener = opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入洽詢明細…';
    detailFields.replaceChildren();
    workflowForm.hidden = true;
    detail.focus();
    try {
      const inquiry = await requestDetail(inquiryId);
      await showLoadedInquiry(inquiry);
      detailStatus.textContent = '洽詢明細已載入。';
    } catch (error) {
      if (await expireSession(error)) return;
      detailStatus.textContent = '洽詢明細載入失敗，請關閉後再試一次。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    detailFields.replaceChildren();
    workflowForm.hidden = true;
    conversionForm.hidden = true;
    currentInquiry = null;
    detailStatus.textContent = '';
    detailOpener?.focus();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state = readFormState(form, 1);
    replaceUrl();
    void load();
  });
  refreshButton.addEventListener('click', load);
  clearButton.addEventListener('click', () => {
    state = parseListState('', LIST_OPTIONS);
    fillForm(form, state);
    replaceUrl();
    void load();
  });
  previousButton.addEventListener('click', () => {
    if (state.page <= 1) return;
    state = { ...state, page: state.page - 1 };
    replaceUrl();
    void load();
  });
  nextButton.addEventListener('click', () => {
    if (state.page * state.pageSize >= total) return;
    state = { ...state, page: state.page + 1 };
    replaceUrl();
    void load();
  });
  detailClose.addEventListener('click', closeDetail);
  workflowForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentInquiry) return;
    workflowSubmit.disabled = true;
    workflowStatus.textContent = '正在儲存流程變更…';
    try {
      const update = {
        expectedUpdatedAt: expectedUpdatedAtInput.value,
        assignedStaffUserId: assigneeSelect.value ? Number(assigneeSelect.value) : null,
      };
      if (nextStatusSelect.value) update.status = nextStatusSelect.value;
      const outcome = await updateGate.run(() => requestUpdate(currentInquiry.id, update));
      if (!outcome.accepted) return;
      await showLoadedInquiry(outcome.value);
      await load();
      workflowStatus.textContent = '流程變更已儲存。';
    } catch (error) {
      if (await expireSession(error)) return;
      if (error instanceof AdminApiError && error.code === 'INQUIRY_CONFLICT') {
        const latest = await requestDetail(currentInquiry.id);
        await showLoadedInquiry(latest);
        workflowStatus.textContent = '資料已被其他人更新，已載入最新版本，請重新確認。';
      } else {
        workflowStatus.textContent = error instanceof AdminApiError
          ? error.message
          : '流程變更儲存失敗，請再試一次。';
      }
    } finally {
      workflowSubmit.disabled = false;
    }
  });

  function updateConversionFields() {
    const newCustomer = conversionMode.value === 'NEW';
    existingCustomerField.hidden = newCustomer;
    const existingInput = conversionForm.elements.namedItem('existingCustomerId');
    existingInput.disabled = newCustomer;
    existingInput.required = !newCustomer;
    for (const wrapper of conversionForm.querySelectorAll('[data-new-customer-field]')) {
      wrapper.hidden = !newCustomer;
      for (const control of wrapper.querySelectorAll('input, select')) control.disabled = !newCustomer;
    }
    const createLocation = createLocationCheckbox.checked;
    conversionLocationFields.hidden = !createLocation;
    for (const control of conversionLocationFields.querySelectorAll('input, select, textarea')) {
      control.disabled = !createLocation;
    }
  }

  conversionMode.addEventListener('change', updateConversionFields);
  createLocationCheckbox.addEventListener('change', updateConversionFields);
  conversionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentInquiry) return;
    conversionSubmit.disabled = true;
    conversionStatus.textContent = '正在建立客戶、地址與草稿訂單…';
    try {
      const formData = new FormData(conversionForm);
      const isNew = formData.get('customerMode') === 'NEW';
      const createLocation = createLocationCheckbox.checked;
      const conversion = {
        expectedUpdatedAt: String(formData.get('expectedUpdatedAt')),
        customer: isNew ? {
          mode: 'NEW',
          customerType: String(formData.get('customerType')),
          displayName: String(formData.get('displayName')).trim(),
          legalName: String(formData.get('legalName')).trim() || null,
        } : {
          mode: 'EXISTING',
          customerId: Number(formData.get('existingCustomerId')),
        },
        location: createLocation ? {
          create: true,
          serviceAreaId: null,
          postalCode: String(formData.get('postalCode')).trim() || null,
          city: String(formData.get('city')).trim(),
          district: String(formData.get('district')).trim(),
          addressLine: String(formData.get('addressLine')).trim(),
          floorUnit: String(formData.get('floorUnit')).trim() || null,
          accessNotes: null,
          status: String(formData.get('locationStatus')),
        } : { create: false },
      };
      const outcome = await updateGate.run(() => requestConversion(currentInquiry.id, conversion));
      if (!outcome.accepted) return;
      const latest = await requestDetail(currentInquiry.id);
      await showLoadedInquiry(latest);
      await load();
      conversionStatus.textContent = `轉換完成，草稿訂單 ${outcome.value.orderNo} 已建立。`;
      detailStatus.textContent = `轉換完成，草稿訂單 ${outcome.value.orderNo} 已建立，並已連結客戶 ID ${outcome.value.customerId}。`;
    } catch (error) {
      if (await expireSession(error)) return;
      if (error instanceof AdminApiError && error.code === 'INQUIRY_CONFLICT') {
        const latest = await requestDetail(currentInquiry.id);
        await showLoadedInquiry(latest);
        conversionStatus.textContent = '資料已被更新，已載入最新版本，請重新確認。';
      } else {
        conversionStatus.textContent = error instanceof AdminApiError ? error.message : '轉換失敗，請再試一次。';
      }
    } finally {
      conversionSubmit.disabled = false;
    }
  });

  return {
    async show({ writePermission = false, inquiryId = null } = {}) {
      canWrite = writePermission;
      page.hidden = false;
      await load();
      if (inquiryId && /^\d+$/.test(inquiryId)) await openDetail(Number(inquiryId));
    },
    hide() {
      page.hidden = true;
      closeDetail();
    },
    load,
  };
}
