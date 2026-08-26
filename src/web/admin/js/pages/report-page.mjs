import { AdminApiError, getAdminOperationalReports } from '../api-client.mjs?v=20260824-outage-inline-editor';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_DAYS = 31;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_COLUMNS = {
  inquiries: [['洽詢編號', 'inquiryNo'], ['來源', 'channel'], ['狀態', 'status'], ['建立時間', 'createdAt']],
  'open-work': [['工單編號', 'workOrderNo'], ['類型', 'workType'], ['優先級', 'priority'], ['狀態', 'status'], ['排程時間', 'scheduledAt']],
  'overdue-invoices': [['帳單編號', 'invoiceNo'], ['到期日', 'dueDate'], ['未收餘額', 'balanceDue'], ['狀態', 'status']],
  'low-stock': [['料號', 'sku'], ['品項', 'itemName'], ['倉庫', 'warehouseCode'], ['可用量', 'availableQuantity'], ['再訂購量', 'reorderLevel']],
  'expiring-promotions': [['促銷代碼', 'promotionCode'], ['促銷名稱', 'promotionName'], ['結束時間', 'endsAt']],
};

function validDate(value) {
  if (!DATE_PATTERN.test(value)) throw new TypeError('日期格式必須為 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError('日期不存在。');
  }
}

export function buildOperationalReportSearch({ from = '', to = '' } = {}) {
  const start = String(from).trim();
  const end = String(to).trim();
  if (!start && !end) return '';
  if (!start || !end) throw new TypeError('開始與結束日期必須同時提供。');
  validDate(start);
  validDate(end);
  if (start > end) throw new TypeError('結束日期不可早於開始日期。');
  const days = Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw new TypeError(`日期區間不可超過 ${MAX_RANGE_DAYS} 天。`);
  return `?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
}

function cellValue(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function renderItems(document, report) {
  const items = Array.isArray(report.items) ? report.items : [];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'report-card__empty';
    empty.textContent = '這個日期區間沒有符合定義的項目。可調整日期後重新查詢。';
    return empty;
  }

  const wrap = document.createElement('div');
  wrap.className = 'report-table-wrap';
  const table = document.createElement('table');
  table.className = 'report-table';
  const caption = document.createElement('caption');
  caption.textContent = `${report.title}明細（最多顯示 ${report.itemLimit} 筆）`;
  const header = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const columns = REPORT_COLUMNS[report.key] ?? [];
  for (const [label] of columns) {
    const heading = document.createElement('th');
    heading.scope = 'col';
    heading.textContent = label;
    headerRow.append(heading);
  }
  header.append(headerRow);
  const body = document.createElement('tbody');
  for (const item of items) {
    const row = document.createElement('tr');
    for (const [, property] of columns) {
      const cell = document.createElement('td');
      cell.textContent = cellValue(item[property]);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, header, body);
  wrap.append(table);
  return wrap;
}

function renderReport(document, report) {
  const card = document.createElement('article');
  card.className = 'report-card';
  card.setAttribute('role', 'listitem');
  card.dataset.reportKey = report.key;

  const header = document.createElement('div');
  header.className = 'report-card__header';
  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = report.title;
  const definition = document.createElement('p');
  definition.textContent = report.definition;
  heading.append(title, definition);
  const metric = document.createElement('p');
  metric.className = 'report-card__metric';
  const total = document.createElement('strong');
  total.textContent = String(report.total);
  const unit = document.createElement('span');
  unit.textContent = report.unit;
  metric.append(total, unit);
  header.append(heading, metric);

  const reconciliation = document.createElement('dl');
  reconciliation.className = 'report-card__reconciliation';
  const sourceLabel = document.createElement('dt');
  sourceLabel.textContent = '來源對帳';
  const sourceValue = document.createElement('dd');
  sourceValue.textContent = `${report.sourceTotals.records} ${report.unit}／${report.denominator.label}`;
  const limitLabel = document.createElement('dt');
  limitLabel.textContent = '明細上限';
  const limitValue = document.createElement('dd');
  limitValue.textContent = `${report.itemLimit} 筆`;
  reconciliation.append(sourceLabel, sourceValue, limitLabel, limitValue);
  card.append(header, reconciliation, renderItems(document, report));
  return card;
}

function errorMessage(error) {
  if (error instanceof AdminApiError && error.code === 'INVALID_QUERY') {
    return `${error.details[0]?.message ?? error.message} 請修正日期後重新套用。`;
  }
  return '報表暫時無法載入。請確認網路後按「重新整理」。';
}

export function createOperationalReportPage({
  document, page, form, fromInput, toInput, refreshButton, clearButton, status, region,
  requestReports = getAdminOperationalReports, onSessionExpired = () => {},
}) {
  async function load() {
    let search;
    try {
      search = buildOperationalReportSearch({ from: fromInput.value, to: toInput.value });
    } catch (error) {
      region.replaceChildren();
      status.textContent = error.message;
      return;
    }
    region.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    status.textContent = '正在依台北日期區間整理營運資料…';
    try {
      const data = await requestReports(search);
      fromInput.value = data.filters.from;
      toInput.value = data.filters.to;
      region.replaceChildren(...data.reports.map((report) => renderReport(document, report)));
      if (data.reports.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'report-empty';
        empty.textContent = '目前角色沒有可查看的營運報表。';
        region.append(empty);
      }
      status.textContent = `資料截至 ${data.asOf}；區間為 ${data.filters.from} 至 ${data.filters.to}（台北）。`;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
        status.textContent = '工作階段已失效，請重新登入。';
        await onSessionExpired();
        return;
      }
      region.replaceChildren();
      const failure = document.createElement('p');
      failure.className = 'report-error';
      failure.textContent = errorMessage(error);
      region.append(failure);
      status.textContent = '載入失敗；請修正條件或重新整理。';
    } finally {
      region.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  refreshButton.addEventListener('click', () => { void load(); });
  clearButton.addEventListener('click', () => { form.reset(); void load(); });
  return {
    async show() { page.hidden = false; await load(); },
    hide() { page.hidden = true; region.replaceChildren(); status.textContent = ''; },
  };
}
