import { AdminApiError, getAdminDashboard } from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createStatusBadge } from '../components.mjs';

function itemLabel(key, item) {
  if (key === 'new-inquiries') return item.inquiryNo;
  if (key === 'open-work-orders') return item.workOrderNo;
  if (key === 'overdue-invoices') return `${item.invoiceNo} · NT$ ${item.balanceDue}`;
  if (key === 'low-stock') return `${item.sku} · 可用 ${item.availableQuantity}`;
  return '待辦項目';
}

function itemStatus(key, item) {
  return key === 'low-stock' ? 'LOW_STOCK' : item.status;
}

function renderCard(document, card) {
  const article = document.createElement('article');
  article.className = 'dashboard-card';
  article.setAttribute('role', 'listitem');
  article.dataset.cardKey = card.key;

  const heading = document.createElement('div');
  heading.className = 'dashboard-card__heading';
  const title = document.createElement('h3');
  title.textContent = card.title;
  const metric = document.createElement('p');
  const value = document.createElement('strong');
  value.textContent = String(card.count);
  const unit = document.createElement('span');
  unit.textContent = card.unit;
  metric.append(value, unit);
  heading.append(title, metric);

  const list = document.createElement('ul');
  list.className = 'dashboard-card__queue';
  if (card.items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'dashboard-card__empty';
    empty.textContent = '目前沒有待辦項目。';
    list.append(empty);
  } else {
    for (const item of card.items) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = itemLabel(card.key, item);
      row.append(label, createStatusBadge(document, itemStatus(card.key, item)));
      list.append(row);
    }
  }

  const action = document.createElement('a');
  action.className = 'dashboard-card__action';
  action.href = card.href;
  action.textContent = '前往處理';
  article.append(heading, list, action);
  return article;
}

export function createDashboardPage({
  document,
  region,
  status,
  refreshButton,
  requestDashboard = getAdminDashboard,
  onSessionExpired = () => {},
}) {
  async function load() {
    region.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    status.textContent = '正在載入最新營運資料…';
    try {
      const dashboard = await requestDashboard();
      region.replaceChildren(...dashboard.cards.map((card) => renderCard(document, card)));
      if (dashboard.cards.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'dashboard-empty';
        empty.textContent = '目前角色沒有可顯示的儀表板項目。';
        region.append(empty);
      }
      status.textContent = `資料截至 ${dashboard.asOf}，營業日 ${dashboard.businessDay.date}（台北）。`;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
        status.textContent = '工作階段已失效，請重新登入。';
        await onSessionExpired();
        return;
      }
      region.replaceChildren();
      const failure = document.createElement('p');
      failure.className = 'dashboard-error';
      failure.textContent = '營運資料暫時無法載入，請使用重新整理再試一次。';
      region.append(failure);
      status.textContent = '載入失敗；可重新嘗試。';
    } finally {
      region.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', load);
  return {
    load,
    clear() {
      region.replaceChildren();
      status.textContent = '';
    },
  };
}
