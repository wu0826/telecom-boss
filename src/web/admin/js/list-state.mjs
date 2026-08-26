const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZES = new Set([20, 50, 100]);

function boundedText(value, maxLength = 100) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function positiveInteger(value, fallback) {
  if (!/^\d+$/.test(value ?? '')) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : fallback;
}

function validateOptions(options) {
  const allowedFilters = Array.isArray(options?.allowedFilters) ? options.allowedFilters : [];
  const allowedSorts = Array.isArray(options?.allowedSorts) ? options.allowedSorts : [];
  if (!allowedSorts.includes(options?.defaultSort)) throw new TypeError('defaultSort must be allowlisted');
  return { allowedFilters, allowedSorts, defaultSort: options.defaultSort };
}

export function parseListState(search, options) {
  const { allowedFilters, allowedSorts, defaultSort } = validateOptions(options);
  const params = new URLSearchParams(search);
  const filters = {};
  for (const field of allowedFilters) {
    const value = boundedText(params.get(field));
    if (value) filters[field] = value;
  }
  const requestedPageSize = positiveInteger(params.get('pageSize'), DEFAULT_PAGE_SIZE);
  const requestedSort = params.get('sort');
  const requestedDirection = params.get('direction');
  return {
    keyword: boundedText(params.get('q')),
    filters,
    page: positiveInteger(params.get('page'), 1),
    pageSize: PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE,
    sort: allowedSorts.includes(requestedSort) ? requestedSort : defaultSort,
    direction: requestedDirection === 'asc' ? 'asc' : 'desc',
  };
}

export function serializeListState(state, options) {
  const { allowedFilters, allowedSorts, defaultSort } = validateOptions(options);
  const params = new URLSearchParams();
  const keyword = boundedText(state?.keyword);
  if (keyword) params.set('q', keyword);
  for (const field of allowedFilters) {
    const value = boundedText(state?.filters?.[field]);
    if (value) params.set(field, value);
  }
  const page = positiveInteger(String(state?.page ?? ''), 1);
  const pageSize = PAGE_SIZES.has(state?.pageSize) ? state.pageSize : DEFAULT_PAGE_SIZE;
  const sort = allowedSorts.includes(state?.sort) ? state.sort : defaultSort;
  const direction = state?.direction === 'asc' ? 'asc' : 'desc';
  if (page !== 1) params.set('page', String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(pageSize));
  if (sort !== defaultSort) params.set('sort', sort);
  if (direction !== 'desc') params.set('direction', direction);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}
