import {
  AdminApiError,
  createAdminCustomer,
  downloadAdminCustomerExport,
  getAdminCustomer,
  getAdminCustomers,
  getAdminServiceAreas,
  saveAdminCustomerContact,
  saveAdminServiceLocation,
  updateAdminCustomer,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createStatusBadge } from '../components.mjs';
import { createSubmissionGate } from '../form-controller.mjs';

const TYPE_LABELS = new Map([['PERSON', '個人'], ['BUSINESS', '企業']]);
const CONTACT_LABELS = new Map([
  ['PRIMARY', '主要'], ['BILLING', '帳務'], ['TECHNICAL', '技術'], ['OTHER', '其他'],
]);
const CUSTOMER_TYPES = new Set(['PERSON', 'BUSINESS']);
const CUSTOMER_STATUSES = new Set(['LEAD', 'ACTIVE', 'SUSPENDED', 'CLOSED']);

export function buildCustomerExportSearch({ q = '', customerType = '', status = '' } = {}) {
  const params = new URLSearchParams();
  const keyword = String(q ?? '').trim().slice(0, 100);
  if (keyword) params.set('q', keyword);
  if (CUSTOMER_TYPES.has(customerType)) params.set('customerType', customerType);
  if (CUSTOMER_STATUSES.has(status)) params.set('status', status);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function requiresCustomerExportRelogin(error) {
  return ['AUTHENTICATION_REQUIRED', 'PERMISSION_DENIED'].includes(error?.code);
}

function value(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function nullable(valueToCheck) {
  return valueToCheck || null;
}

function profilePayload(form, { includeNumber = false } = {}) {
  const payload = {
    customerType: value(form, 'customerType'),
    displayName: value(form, 'displayName'),
    legalName: nullable(value(form, 'legalName')),
    status: value(form, 'status'),
  };
  if (includeNumber) payload.customerNo = value(form, 'customerNo');
  return payload;
}

function contactPayload(form) {
  return {
    contactName: value(form, 'contactName'),
    contactType: value(form, 'contactType'),
    phone: nullable(value(form, 'phone')),
    email: nullable(value(form, 'email')),
    isPrimary: form.elements.namedItem('isPrimary').checked,
    isActive: form.elements.namedItem('isActive').checked,
  };
}

function locationPayload(form, { includeNumber = false } = {}) {
  const area = value(form, 'serviceAreaId');
  const payload = {
    serviceAreaId: area ? Number(area) : null,
    postalCode: nullable(value(form, 'postalCode')),
    city: value(form, 'city'),
    district: value(form, 'district'),
    addressLine: value(form, 'addressLine'),
    floorUnit: nullable(value(form, 'floorUnit')),
    accessNotes: nullable(value(form, 'accessNotes')),
    status: value(form, 'status'),
  };
  if (includeNumber) payload.locationNo = value(form, 'locationNo');
  return payload;
}

function setFormValue(form, name, nextValue) {
  const control = form.elements.namedItem(name);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = Boolean(nextValue);
  else control.value = nextValue ?? '';
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

function resetSubform(form) {
  form.reset();
  for (const name of ['contactId', 'locationId']) setFormValue(form, name, '');
  const locationNo = form.elements.namedItem('locationNo');
  if (locationNo) locationNo.readOnly = false;
  const isActive = form.elements.namedItem('isActive');
  if (isActive) isActive.checked = true;
}

export function createCustomerPage({
  document,
  page,
  filterForm,
  results,
  resultsBody,
  listStatus,
  refreshButton,
  exportButton,
  exportStatus,
  clearButton,
  createPanel,
  createForm,
  createStatus,
  detail,
  detailStatus,
  detailClose,
  profileForm,
  sensitiveButton,
  contactList,
  contactForm,
  locationList,
  locationForm,
  onSessionExpired = () => {},
}) {
  let currentCustomer = null;
  let canWrite = false;
  let canSensitive = false;
  let sensitiveLoaded = false;
  let detailOpener = null;
  let serviceAreas = [];
  const writeGate = createSubmissionGate();
  const exportGate = createSubmissionGate();

  async function expireSession(error) {
    if (requiresCustomerExportRelogin(error)) {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function listSearch() {
    return buildCustomerExportSearch({
      q: value(filterForm, 'q'),
      customerType: value(filterForm, 'customerType'),
      status: value(filterForm, 'status'),
    });
  }

  function downloadCsv(csv, filename) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv; charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function exportCurrentFilters() {
    exportButton.disabled = true;
    exportStatus.textContent = '正在建立遮罩後的 CSV 匯出檔…';
    try {
      const outcome = await exportGate.run(() => downloadAdminCustomerExport(listSearch()));
      if (!outcome.accepted) return;
      downloadCsv(outcome.value.csv, outcome.value.filename);
      exportStatus.textContent = '已開始下載目前篩選條件的遮罩 CSV 檔。';
    } catch (error) {
      if (await expireSession(error)) return;
      exportStatus.textContent = error instanceof AdminApiError
        ? error.message
        : '客戶匯出失敗，未建立檔案。請稍後再試。';
    } finally {
      exportButton.disabled = false;
    }
  }

  async function load() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入客戶清單…';
    try {
      const envelope = await getAdminCustomers(listSearch());
      resultsBody.replaceChildren();
      for (const customer of envelope.data) {
        const row = document.createElement('tr');
        appendCell(document, row, customer.customerNo);
        appendCell(document, row, customer.displayName);
        appendCell(document, row, TYPE_LABELS.get(customer.customerType) ?? customer.customerType);
        appendCell(document, row, createStatusBadge(document, customer.status));
        appendCell(document, row, actionButton(document, '查看', (event) => openDetail(customer.id, event.currentTarget)));
        resultsBody.append(row);
      }
      if (!envelope.data.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.className = 'table-empty';
        cell.textContent = '目前沒有符合條件的客戶。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `已載入 ${envelope.data.length} 筆，共 ${envelope.meta.total} 筆。`;
    } catch (error) {
      if (await expireSession(error)) return;
      listStatus.textContent = '客戶清單載入失敗，請重新整理。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function fillProfile(customer) {
    for (const field of ['customerNo', 'customerType', 'displayName', 'legalName', 'status']) {
      setFormValue(profileForm, field, customer[field]);
    }
  }

  function fillContact(contact) {
    for (const field of ['contactId', 'contactName', 'contactType', 'phone', 'email', 'isPrimary', 'isActive']) {
      setFormValue(contactForm, field, field === 'contactId' ? contact.id : contact[field]);
    }
    contactForm.elements.namedItem('contactName').focus();
  }

  function fillLocation(location) {
    for (const field of [
      'locationId', 'locationNo', 'postalCode', 'city', 'district', 'addressLine',
      'floorUnit', 'accessNotes', 'status',
    ]) {
      setFormValue(locationForm, field, field === 'locationId' ? location.id : location[field]);
    }
    setFormValue(locationForm, 'serviceAreaId', location.serviceArea?.id);
    locationForm.elements.namedItem('locationNo').readOnly = true;
    locationForm.elements.namedItem('city').focus();
  }

  function renderCards(container, records, render) {
    container.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'customer-records__empty';
      empty.textContent = '尚無資料。';
      container.append(empty);
      return;
    }
    for (const record of records) container.append(render(record));
  }

  function renderDetail(customer) {
    currentCustomer = customer;
    fillProfile(customer);
    sensitiveButton.hidden = !canSensitive || sensitiveLoaded;
    renderCards(contactList, customer.contacts, (contact) => {
      const card = document.createElement('article');
      card.className = 'customer-record';
      const heading = document.createElement('strong');
      heading.textContent = `${contact.contactName} · ${CONTACT_LABELS.get(contact.contactType) ?? contact.contactType}`;
      const details = document.createElement('span');
      details.textContent = `${contact.phone ?? '無電話'} · ${contact.email ?? '無 Email'}${contact.isPrimary ? ' · 主要聯絡人' : ''}`;
      card.append(heading, details);
      if (canWrite && sensitiveLoaded) card.append(actionButton(document, '編輯', () => fillContact(contact)));
      return card;
    });
    renderCards(locationList, customer.locations, (location) => {
      const card = document.createElement('article');
      card.className = 'customer-record';
      const heading = document.createElement('strong');
      heading.textContent = `${location.locationNo} · ${location.city}${location.district}${location.addressLine}`;
      const details = document.createElement('span');
      const technologies = location.allowedTechnologies.length ? location.allowedTechnologies.join(' / ') : '待確認';
      details.textContent = `${location.serviceArea?.name ?? '未連結服務區'} · ${technologies}`;
      card.append(heading, details);
      if (canWrite && sensitiveLoaded) card.append(actionButton(document, '編輯', () => fillLocation(location)));
      return card;
    });
  }

  async function openDetail(customerId, opener) {
    detailOpener = opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入客戶明細…';
    detail.focus();
    sensitiveLoaded = false;
    resetSubform(contactForm);
    resetSubform(locationForm);
    try {
      const customer = await getAdminCustomer(customerId);
      renderDetail(customer);
      detailStatus.textContent = '客戶明細已載入；聯絡方式預設遮罩。';
    } catch (error) {
      if (await expireSession(error)) return;
      detailStatus.textContent = '客戶明細載入失敗。';
    }
  }

  async function reloadDetail({ sensitive = sensitiveLoaded } = {}) {
    if (!currentCustomer) return;
    const customer = await getAdminCustomer(currentCustomer.id, { sensitive });
    sensitiveLoaded = sensitive;
    renderDetail(customer);
  }

  function closeDetail() {
    detail.hidden = true;
    currentCustomer = null;
    sensitiveLoaded = false;
    resetSubform(contactForm);
    resetSubform(locationForm);
    detailOpener?.focus();
  }

  async function submitWrite(button, operation, successMessage) {
    button.disabled = true;
    detailStatus.textContent = '正在儲存…';
    try {
      const outcome = await writeGate.run(operation);
      if (!outcome.accepted) return false;
      await reloadDetail();
      await load();
      detailStatus.textContent = successMessage;
      return true;
    } catch (error) {
      if (await expireSession(error)) return false;
      detailStatus.textContent = error instanceof AdminApiError ? error.message : '儲存失敗，請再試一次。';
      return false;
    } finally {
      button.disabled = false;
    }
  }

  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void load(); });
  refreshButton.addEventListener('click', load);
  exportButton.addEventListener('click', () => { void exportCurrentFilters(); });
  detailClose.addEventListener('click', closeDetail);
  sensitiveButton.addEventListener('click', async () => {
    sensitiveButton.disabled = true;
    detailStatus.textContent = '正在取得完整聯絡資料並留下稽核紀錄…';
    try {
      await reloadDetail({ sensitive: true });
      detailStatus.textContent = '完整聯絡資料已載入，本次存取已記錄。';
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = '完整聯絡資料載入失敗。';
    } finally {
      sensitiveButton.disabled = false;
    }
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = createForm.querySelector('button[type="submit"]');
    button.disabled = true;
    createStatus.textContent = '正在建立客戶…';
    try {
      const customer = await createAdminCustomer(profilePayload(createForm, { includeNumber: true }));
      createForm.reset();
      createStatus.textContent = `已建立 ${customer.customerNo}。`;
      await load();
      await openDetail(customer.id, button);
    } catch (error) {
      if (!(await expireSession(error))) createStatus.textContent = error instanceof AdminApiError ? error.message : '建立失敗。';
    } finally {
      button.disabled = false;
    }
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = profileForm.querySelector('button[type="submit"]');
    await submitWrite(button, () => updateAdminCustomer(
      currentCustomer.id, profilePayload(profileForm),
    ), '基本資料已更新。');
  });

  contactForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = contactForm.querySelector('button[type="submit"]');
    const contactId = value(contactForm, 'contactId');
    if (await submitWrite(button, () => saveAdminCustomerContact(
      currentCustomer.id, contactId, contactPayload(contactForm),
    ), '聯絡人已儲存。')) resetSubform(contactForm);
  });

  locationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = locationForm.querySelector('button[type="submit"]');
    const locationId = value(locationForm, 'locationId');
    if (await submitWrite(button, () => saveAdminServiceLocation(
      currentCustomer.id,
      locationId,
      locationPayload(locationForm, { includeNumber: !locationId }),
    ), '服務地址已儲存。')) resetSubform(locationForm);
  });

  for (const button of page.querySelectorAll('[data-form-reset]')) {
    button.addEventListener('click', () => resetSubform(button.form));
  }

  return {
    async show({ writePermission = false, sensitivePermission = false, customerId = null } = {}) {
      canWrite = writePermission;
      canSensitive = sensitivePermission;
      page.hidden = false;
      exportStatus.textContent = '';
      createPanel.hidden = !canWrite;
      profileForm.hidden = false;
      for (const control of profileForm.elements) {
        if (control.name !== 'customerNo') control.disabled = !canWrite;
      }
      profileForm.querySelector('button[type="submit"]').hidden = !canWrite;
      contactForm.hidden = !canWrite;
      locationForm.hidden = !canWrite;
      if (!serviceAreas.length) {
        serviceAreas = await getAdminServiceAreas();
        const select = locationForm.elements.namedItem('serviceAreaId');
        for (const area of serviceAreas) {
          const option = document.createElement('option');
          option.value = String(area.id);
          option.textContent = `${area.code} · ${area.name} · ${area.allowedTechnologies.join(' / ')}`;
          select.append(option);
        }
      }
      await load();
      if (customerId && /^\d+$/.test(customerId)) await openDetail(Number(customerId));
    },
    hide() {
      page.hidden = true;
      closeDetail();
    },
  };
}
