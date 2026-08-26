const STATUS_LABELS = new Map([
  ['ACTIVE', ['success', '使用中']],
  ['COMPLETED', ['success', '已完成']],
  ['PAID', ['success', '已付款']],
  ['IN_PROGRESS', ['progress', '處理中']],
  ['INVESTIGATING', ['progress', '調查中']],
  ['NEW', ['progress', '新案件']],
  ['CONTACTED', ['progress', '已聯繫']],
  ['QUALIFIED', ['progress', '已確認需求']],
  ['CONVERTED', ['success', '已轉換']],
  ['CLOSED', ['neutral', '已結案']],
  ['DRAFT', ['neutral', '草稿']],
  ['PENDING', ['neutral', '等待中']],
  ['CANCELLED', ['danger', '已取消']],
  ['FAILED', ['danger', '失敗']],
  ['OVERDUE', ['danger', '已逾期']],
  ['LOW_STOCK', ['danger', '庫存偏低']],
]);

export function statusPresentation(status) {
  const normalized = String(status ?? '').trim().toUpperCase();
  const known = STATUS_LABELS.get(normalized);
  return known
    ? { tone: known[0], label: known[1] }
    : { tone: 'neutral', label: normalized.replaceAll('_', ' ') || '未知狀態' };
}

export function createStatusBadge(document, status) {
  const presentation = statusPresentation(status);
  const badge = document.createElement('span');
  badge.className = `status-badge status-badge--${presentation.tone}`;
  badge.dataset.status = String(status ?? '');
  badge.textContent = presentation.label;
  return badge;
}

export function activateTab({ tabs, panels, selectedIndex, focus = false }) {
  if (
    !Number.isInteger(selectedIndex)
    || selectedIndex < 0
    || selectedIndex >= tabs.length
    || tabs.length !== panels.length
  ) return false;
  tabs.forEach((tab, index) => {
    const selected = index === selectedIndex;
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('tabindex', selected ? '0' : '-1');
    panels[index].hidden = !selected;
  });
  if (focus) tabs[selectedIndex].focus();
  return true;
}

export function createTabsController({ tabList, tabs, panels }) {
  const select = (index, focus = false) => activateTab({
    tabs,
    panels,
    selectedIndex: index,
    focus,
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
  });
  tabList.addEventListener('keydown', (event) => {
    const currentIndex = tabs.indexOf(event.target);
    if (currentIndex < 0) return;
    const keyOffsets = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (event.key === 'Home') {
      event.preventDefault();
      select(0, true);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      select(tabs.length - 1, true);
      return;
    }
    const offset = keyOffsets[event.key];
    if (!offset) return;
    event.preventDefault();
    select((currentIndex + offset + tabs.length) % tabs.length, true);
  });
  return { select };
}

export function announce(region, message) {
  region.textContent = '';
  globalThis.requestAnimationFrame?.(() => { region.textContent = message; });
}

export function nextDialogFocusIndex(currentIndex, itemCount, backwards) {
  if (itemCount < 1) return -1;
  if (backwards) return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  return currentIndex >= itemCount - 1 ? 0 : currentIndex + 1;
}

export function createDialogController({ dialog, initialFocus }) {
  let opener = null;
  const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll(focusableSelector)];
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(dialog.ownerDocument.activeElement);
    const nextIndex = nextDialogFocusIndex(currentIndex, focusable.length, event.shiftKey);
    if (
      currentIndex === -1
      || (event.shiftKey && currentIndex === 0)
      || (!event.shiftKey && currentIndex === focusable.length - 1)
    ) {
      event.preventDefault();
      focusable[nextIndex].focus();
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener('close', () => opener?.focus());
  for (const control of dialog.querySelectorAll('[data-dialog-close]')) {
    control.addEventListener('click', () => dialog.close());
  }
  return {
    open(trigger = dialog.ownerDocument.activeElement) {
      opener = trigger;
      dialog.showModal();
      initialFocus?.focus();
    },
    close() { dialog.close(); },
  };
}
