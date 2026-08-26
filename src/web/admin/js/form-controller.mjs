export function createSubmissionGate() {
  let pending = false;
  return {
    get pending() { return pending; },
    async run(operation) {
      if (pending) return { accepted: false };
      if (typeof operation !== 'function') throw new TypeError('operation must be a function');
      pending = true;
      try {
        return { accepted: true, value: await operation() };
      } finally {
        pending = false;
      }
    },
  };
}

export function normalizeFieldErrors(details, allowedFields) {
  const allowed = new Set(allowedFields);
  const seen = new Set();
  const result = [];
  for (const detail of Array.isArray(details) ? details : []) {
    if (
      !detail
      || typeof detail !== 'object'
      || !allowed.has(detail.field)
      || seen.has(detail.field)
      || typeof detail.message !== 'string'
      || !detail.message.trim()
    ) continue;
    seen.add(detail.field);
    result.push({ field: detail.field, message: detail.message.trim().slice(0, 200) });
  }
  return result;
}

export function clearFormErrors(form, summary) {
  summary.replaceChildren();
  summary.hidden = true;
  for (const field of form.elements) {
    field.removeAttribute?.('aria-invalid');
    field.removeAttribute?.('aria-describedby');
  }
  for (const target of form.querySelectorAll('[data-error-field]')) {
    target.removeAttribute('aria-invalid');
    target.removeAttribute('aria-describedby');
  }
  for (const error of form.querySelectorAll('[data-field-error]')) error.remove();
}

function errorTarget(form, fieldName) {
  const named = form.elements.namedItem(fieldName);
  if (named?.id) return named;
  return [...form.querySelectorAll('[data-error-field]')]
    .find(({ dataset }) => dataset.errorField === fieldName) ?? null;
}

export function showFormErrors({ form, summary, errors, allowedFields, fieldLabels = {} }) {
  clearFormErrors(form, summary);
  const normalized = normalizeFieldErrors(errors, allowedFields);
  if (normalized.length === 0) return false;
  const document = form.ownerDocument;
  const heading = document.createElement('strong');
  heading.textContent = '請修正以下欄位';
  const list = document.createElement('ul');
  for (const error of normalized) {
    const field = errorTarget(form, error.field);
    if (!field?.id) continue;
    const errorId = `${field.id}-error`;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', errorId);
    const fieldError = document.createElement('p');
    fieldError.id = errorId;
    fieldError.dataset.fieldError = 'true';
    fieldError.className = 'field-error';
    fieldError.textContent = error.message;
    field.insertAdjacentElement('afterend', fieldError);
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${field.id}`;
    const label = typeof fieldLabels[error.field] === 'string' ? fieldLabels[error.field].trim() : '';
    link.textContent = label ? `${label}：${error.message}` : error.message;
    item.append(link);
    list.append(item);
  }
  summary.append(heading, list);
  summary.hidden = false;
  summary.focus();
  return true;
}

export function createDirtyTracker({ form, confirmLeave = globalThis.confirm }) {
  let dirty = false;
  const markDirty = () => { dirty = true; };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  return {
    get dirty() { return dirty; },
    markSaved() { dirty = false; },
    confirmNavigation() {
      return !dirty || confirmLeave('尚有未儲存的變更，確定要離開嗎？');
    },
    handleBeforeUnload(event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    },
  };
}
