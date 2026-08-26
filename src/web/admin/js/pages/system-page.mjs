import { getSystemHealth } from '../api-client.mjs?v=20260824-outage-inline-editor';

const DATABASES = [
  { key: 'metadata', label: '網站中繼資料庫' },
  { key: 'telecom', label: '營運資料庫' },
];

function databaseStatus(value) {
  if (value === 'ok') return '正常';
  if (value === 'unavailable') return '暫時無法使用';
  return '狀態未確認';
}

function checkedAt(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '未提供';
  return value;
}

export function normalizeSystemHealth(data) {
  const databases = DATABASES.map(({ key, label }) => ({
    key,
    label,
    status: databaseStatus(data?.databases?.[key]),
  }));
  return {
    overall: data?.status === 'ok' && databases.every((database) => database.status === '正常')
      ? '正常'
      : '需要處理',
    checkedAt: checkedAt(data?.checkedAt),
    databases,
  };
}

function healthCard(document, database) {
  const card = document.createElement('article');
  card.className = 'system-health-card';
  card.setAttribute('role', 'listitem');
  const label = document.createElement('p');
  label.textContent = database.label;
  const status = document.createElement('strong');
  status.textContent = database.status;
  status.className = database.status === '正常' ? 'system-health-card__ok' : 'system-health-card__attention';
  card.append(label, status);
  return card;
}

function recoveryCard(document, title, detail, command = null) {
  const card = document.createElement('article');
  card.className = 'system-recovery-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = detail;
  card.append(heading, paragraph);
  if (command) {
    const code = document.createElement('code');
    code.textContent = command;
    card.append(code);
  }
  return card;
}

function renderRecoveryGuidance(document, region) {
  region.replaceChildren(
    recoveryCard(document, '先停止服務', '只由已授權操作人員處理；確認服務已停止後才可進行 migration 或資料回復。'),
    recoveryCard(
      document,
      '建立可驗證備份',
      '只使用新的、經核准的備份目的地；不要以覆寫或清除方式處理既有資料庫。',
      'npm run db:migrate -- --metadata-backup <新的受驗證中繼資料備份> --telecom-backup <新的受驗證營運資料備份>',
    ),
    recoveryCard(
      document,
      '受控回復',
      '先確認備份、目標資料庫與核准範圍；本頁不會執行這個指令。完整程序請依 README 的「資料庫備份與回復」。',
      'Copy-Item -LiteralPath <受核准備份> -Destination <受核准本機資料庫> -Force',
    ),
    recoveryCard(document, '回復後驗證', '完成後先執行完整測試，再檢查健康端點；若狀態仍異常，停止後續操作並交由維運人員處理。', 'npm test'),
  );
}

export function createSystemPage({
  document, page, refreshButton, status, results, recovery,
  requestHealth = getSystemHealth,
}) {
  async function load() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    status.textContent = '正在讀取服務與資料庫健康狀態…';
    try {
      const health = normalizeSystemHealth(await requestHealth());
      const service = { key: 'service', label: '服務', status: health.overall };
      results.replaceChildren(
        healthCard(document, service),
        ...health.databases.map((database) => healthCard(document, database)),
      );
      status.textContent = health.overall === '正常'
        ? `系統健康正常；資料截至 ${health.checkedAt}。`
        : `部分健康檢查需要處理；資料截至 ${health.checkedAt}。請依下方受控流程處理。`;
    } catch {
      results.replaceChildren();
      const failure = document.createElement('p');
      failure.className = 'system-health-error';
      failure.textContent = '健康狀態暫時無法取得。請確認本機服務與操作文件，勿執行未經核准的復原指令。';
      results.append(failure);
      status.textContent = '健康狀態讀取失敗；沒有顯示舊資料。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => { void load(); });
  return {
    async show() {
      page.hidden = false;
      renderRecoveryGuidance(document, recovery);
      await load();
    },
    hide() {
      page.hidden = true;
      results.replaceChildren();
      recovery.replaceChildren();
      status.textContent = '';
    },
  };
}
