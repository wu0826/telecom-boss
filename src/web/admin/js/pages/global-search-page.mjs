import {
  AdminApiError,
  getAdminCatalogProducts,
  getAdminCustomers,
  getAdminInquiries,
  getAdminInvoices,
  getAdminOutages,
  getAdminSubscriptions,
  getAdminWorkOrders,
} from '../api-client.mjs?v=20260824-outage-inline-editor';

const MAX_QUERY_LENGTH = 100;
const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 5;
const SEARCH_DELAY_MS = 250;

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function detailHref(route, parameter, item) {
  const id = positiveId(item?.id);
  return id === null ? null : `${route}?${parameter}=${id}`;
}

function queryForPagedList(query) {
  const params = new URLSearchParams({ q: query, page: '1', pageSize: String(RESULT_LIMIT) });
  return `?${params}`;
}

function queryForList(query) {
  return `?${new URLSearchParams({ q: query })}`;
}

function text(value, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function takeResults(items, toResult) {
  return (Array.isArray(items) ? items : [])
    .map(toResult)
    .filter((item) => item !== null)
    .slice(0, RESULT_LIMIT);
}

const SEARCH_MODULES = Object.freeze([
  {
    id: 'inquiries',
    label: '申裝洽詢',
    permission: 'customer.read',
    request: (query) => getAdminInquiries(queryForPagedList(query)),
    results: (envelope) => takeResults(envelope?.data, (inquiry) => {
      const href = detailHref('#inquiries', 'inquiryId', inquiry);
      return href ? { href, title: text(inquiry.inquiryNo), detail: text(inquiry.prospectName) } : null;
    }),
  },
  {
    id: 'customers',
    label: '客戶',
    permission: 'customer.read',
    request: (query) => getAdminCustomers(queryForPagedList(query)),
    results: (envelope) => takeResults(envelope?.data, (customer) => {
      const href = detailHref('#customers', 'customerId', customer);
      return href ? { href, title: text(customer.customerNo), detail: text(customer.displayName) } : null;
    }),
  },
  {
    id: 'products',
    label: '商品',
    permission: 'catalog.manage',
    request: (query) => getAdminCatalogProducts(queryForPagedList(query)),
    results: (envelope) => takeResults(envelope?.data, (product) => {
      const href = detailHref('#products', 'productId', product);
      return href ? { href, title: text(product.productCode), detail: text(product.productName) } : null;
    }),
  },
  {
    id: 'work-orders',
    label: '工單',
    permission: 'operations.manage',
    request: (query) => getAdminWorkOrders(queryForList(query)),
    results: (items) => takeResults(items, (workOrder) => {
      const href = detailHref('#operations', 'workOrderId', workOrder);
      return href ? { href, title: text(workOrder.workOrderNo), detail: text(workOrder.customer?.name) } : null;
    }),
  },
  {
    id: 'outages',
    label: '障礙事件',
    permission: 'operations.manage',
    request: (query) => getAdminOutages(queryForList(query)),
    results: (items) => takeResults(items, (outage) => {
      const href = detailHref('#outages', 'outageId', outage);
      return href ? { href, title: text(outage.incidentNo), detail: text(outage.title) } : null;
    }),
  },
  {
    id: 'subscriptions',
    label: '服務合約',
    permission: 'order.manage',
    request: (query) => getAdminSubscriptions(queryForList(query)),
    results: (items) => takeResults(items, (subscription) => {
      const href = detailHref('#subscriptions', 'subscriptionId', subscription);
      return href ? {
        href,
        title: text(subscription.subscriptionNo),
        detail: text(subscription.customer?.name),
      } : null;
    }),
  },
  {
    id: 'invoices',
    label: '帳單',
    permission: 'billing.manage',
    request: (query) => getAdminInvoices(queryForList(query)),
    results: (items) => takeResults(items, (invoice) => {
      const href = detailHref('#billing', 'invoiceId', invoice);
      return href ? { href, title: text(invoice.invoiceNo), detail: text(invoice.customer?.name) } : null;
    }),
  },
]);

export function normalizeGlobalSearchQuery(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_QUERY_LENGTH) : '';
}

export function globalSearchModulesForPermissions(permissions) {
  const permissionSet = new Set(Array.isArray(permissions) ? permissions : []);
  return SEARCH_MODULES.filter(({ permission }) => permissionSet.has(permission));
}

function appendMessage(document, results, message) {
  const element = document.createElement('p');
  element.className = 'global-search__message';
  element.setAttribute('role', 'status');
  element.textContent = message;
  results.replaceChildren(element);
}

export function createGlobalSearch({
  document,
  form,
  input,
  results,
  status,
  onNavigate = () => {},
  onSessionExpired = () => {},
}) {
  let enabled = false;
  let permittedModules = [];
  let requestVersion = 0;
  let debounceTimer = null;
  let activeIndex = -1;
  let selectableResults = [];

  function setExpanded(expanded) {
    input.setAttribute('aria-expanded', String(expanded));
    results.hidden = !expanded;
  }

  function clearTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearResults({ hide = true } = {}) {
    requestVersion += 1;
    clearTimer();
    activeIndex = -1;
    selectableResults = [];
    results.replaceChildren();
    results.setAttribute('aria-busy', 'false');
    setExpanded(!hide);
  }

  function renderSelection({ focus = false } = {}) {
    selectableResults.forEach(({ element }, index) => {
      const selected = index === activeIndex;
      element.setAttribute('aria-selected', String(selected));
      if (selected && focus) element.focus();
    });
  }

  function moveSelection(nextIndex, { focus = true } = {}) {
    if (!selectableResults.length) return;
    activeIndex = Math.min(Math.max(nextIndex, 0), selectableResults.length - 1);
    renderSelection({ focus });
  }

  function chooseResult(index = activeIndex) {
    const result = selectableResults[index];
    if (!result) return;
    clearResults();
    input.value = '';
    status.textContent = '正在開啟已選取項目。';
    onNavigate(result.href);
  }

  function renderFoundResults(groups) {
    results.replaceChildren();
    selectableResults = [];
    activeIndex = -1;
    for (const { module, items } of groups) {
      if (!items.length) continue;
      const group = document.createElement('div');
      group.className = 'global-search__group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', module.label);
      const label = document.createElement('p');
      label.className = 'global-search__group-label';
      label.textContent = module.label;
      const list = document.createElement('div');
      list.className = 'global-search__items';
      group.append(label, list);
      for (const item of items) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'global-search__option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.tabIndex = -1;
        const title = document.createElement('strong');
        const detail = document.createElement('span');
        title.textContent = item.title;
        detail.textContent = item.detail;
        option.append(title, detail);
        const index = selectableResults.length;
        option.addEventListener('click', () => chooseResult(index));
        selectableResults.push({ element: option, href: item.href });
        list.append(option);
      }
      results.append(group);
    }
    if (!selectableResults.length) {
      appendMessage(document, results, '沒有找到符合條件的可存取資料。');
      status.textContent = '沒有符合條件的可存取資料。';
      return;
    }
    status.textContent = '搜尋完成；可使用方向鍵選取結果。';
  }

  async function runSearch(query, version) {
    results.setAttribute('aria-busy', 'true');
    setExpanded(true);
    appendMessage(document, results, '正在搜尋可存取資料…');
    status.textContent = '正在搜尋可存取資料。';
    try {
      const groups = await Promise.all(permittedModules.map(async (module) => ({
        module,
        items: module.results(await module.request(query)),
      })));
      if (!enabled || version !== requestVersion) return;
      renderFoundResults(groups);
    } catch (error) {
      if (!enabled || version !== requestVersion) return;
      if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
        clearResults();
        await onSessionExpired();
        return;
      }
      selectableResults = [];
      activeIndex = -1;
      appendMessage(document, results, '搜尋暫時無法完成，請稍後再試。');
      status.textContent = '搜尋暫時無法完成，請稍後再試。';
    } finally {
      if (version === requestVersion) results.setAttribute('aria-busy', 'false');
    }
  }

  function queueSearch() {
    if (!enabled) return;
    const query = normalizeGlobalSearchQuery(input.value);
    clearTimer();
    const version = ++requestVersion;
    if (query.length < MIN_QUERY_LENGTH) {
      activeIndex = -1;
      selectableResults = [];
      results.replaceChildren();
      results.setAttribute('aria-busy', 'false');
      if (query) {
        appendMessage(document, results, `請至少輸入 ${MIN_QUERY_LENGTH} 個字再搜尋。`);
        status.textContent = `請至少輸入 ${MIN_QUERY_LENGTH} 個字再搜尋。`;
        setExpanded(true);
      } else {
        status.textContent = '';
        setExpanded(false);
      }
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSearch(query, version);
    }, SEARCH_DELAY_MS);
  }

  function handleInputKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearResults();
      status.textContent = '';
      return;
    }
    if (!selectableResults.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(activeIndex <= 0 ? selectableResults.length - 1 : activeIndex - 1);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      chooseResult();
    }
  }

  function handleResultsKeydown(event) {
    if (!selectableResults.length) return;
    const index = selectableResults.findIndex(({ element }) => element === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      clearResults();
      input.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(index >= selectableResults.length - 1 ? 0 : index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(index <= 0 ? selectableResults.length - 1 : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveSelection(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveSelection(selectableResults.length - 1);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (activeIndex >= 0) chooseResult();
  });
  input.addEventListener('input', queueSearch);
  input.addEventListener('keydown', handleInputKeydown);
  input.addEventListener('focus', () => {
    if (selectableResults.length) setExpanded(true);
  });
  results.addEventListener('keydown', handleResultsKeydown);
  document.addEventListener('keydown', (event) => {
    if (!enabled || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    input.focus();
    input.select();
  });

  return {
    configure(permissions) {
      enabled = true;
      permittedModules = globalSearchModulesForPermissions(permissions);
      input.disabled = permittedModules.length === 0;
      input.value = '';
      clearResults();
      status.textContent = input.disabled ? '目前角色沒有可搜尋的模組。' : '';
    },
    clear() {
      enabled = false;
      permittedModules = [];
      input.value = '';
      input.disabled = true;
      clearResults();
      status.textContent = '';
    },
  };
}
