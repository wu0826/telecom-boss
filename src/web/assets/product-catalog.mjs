const PRODUCT_LIST_PATH = '/api/v1/catalog/products';
const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function element(tagName, { className, text } = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories.filter((category) => (
    typeof category?.slug === 'string'
    && CATEGORY_SLUG_PATTERN.test(category.slug)
    && typeof category.name === 'string'
    && category.name.trim().length > 0
  ));
}

function hasSingleSearchValue(searchParams, name) {
  const values = searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatAmount(amount) {
  if (typeof amount !== 'string' && typeof amount !== 'number') return null;
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  const fractionDigits = Number.isInteger(value) ? 0 : 2;
  return new Intl.NumberFormat('zh-TW', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

function quoteHref(product) {
  const query = new URLSearchParams({ intent: 'quote', product });
  return `/?${query.toString()}#apply`;
}

function detailHref(product) {
  return `/products/detail.html?${new URLSearchParams({ product }).toString()}`;
}

export function categoryFromSearch(search, categories) {
  const category = hasSingleSearchValue(new URLSearchParams(search), 'category');
  if (!category) return null;
  return validCategories(categories).some(({ slug }) => slug === category) ? category : null;
}

export function catalogRequestPath(category, categories) {
  const params = new URLSearchParams({ locale: 'zh-TW' });
  if (validCategories(categories).some(({ slug }) => slug === category)) {
    params.set('category', category);
  }
  return `${PRODUCT_LIST_PATH}?${params.toString()}`;
}

export function productCardPreview(product) {
  const slug = typeof product?.slug === 'string' ? product.slug : '';
  const lowestMonthlyAmount = formatAmount(product?.pricing?.lowestMonthlyAmount);
  const sellingPrice = formatAmount(product?.pricing?.sellingPrice);
  const promotion = product?.promotions?.[0];
  const promotionText = nonEmptyText(promotion?.title) ?? nonEmptyText(promotion?.description);
  const facts = [
    lowestMonthlyAmount
      ? `每月最低 NT$ ${lowestMonthlyAmount}`
      : sellingPrice
        ? `公開售價 NT$ ${sellingPrice}`
        : null,
    promotionText,
  ].filter(Boolean).slice(0, 2);

  return {
    category: nonEmptyText(product?.category?.name) ?? '公開分類',
    detailHref: detailHref(slug),
    facts,
    purpose: nonEmptyText(product?.content?.summary) ?? '目前公開資訊整理中，可留下需求由專人協助確認。',
    quoteHref: quoteHref(slug),
    title: nonEmptyText(product?.name) ?? '公開商品',
  };
}

function publishedCategories(products) {
  const categories = new Map();
  for (const product of products) {
    const category = product?.category;
    if (!validCategories([category]).length || categories.has(category.slug)) continue;
    categories.set(category.slug, { slug: category.slug, name: category.name });
  }
  return [...categories.values()];
}

function createProductCard(product) {
  const preview = productCardPreview(product);
  const article = element('article', { className: 'catalog-product-card' });
  const category = element('p', { className: 'catalog-product-card__category', text: preview.category });
  const title = element('h2', { text: preview.title });
  const purpose = element('p', { className: 'catalog-product-card__purpose', text: preview.purpose });
  const facts = element('ul', { className: 'catalog-product-card__facts' });
  for (const fact of preview.facts) facts.append(element('li', { text: fact }));
  if (!preview.facts.length) facts.append(element('li', { text: '請查看詳細內容確認公開資訊。' }));

  const actions = element('div', { className: 'catalog-product-card__actions' });
  const detail = element('a', { className: 'showcase-button showcase-button--text', text: '查看詳細內容' });
  detail.href = preview.detailHref;
  const quote = element('a', { className: 'showcase-button', text: '帶著此商品詢價' });
  quote.href = preview.quoteHref;
  actions.append(detail, quote);
  article.append(category, title, purpose, facts, actions);
  return article;
}

function loadPage() {
  const elements = {
    error: document.querySelector('#catalog-error'),
    filters: document.querySelector('#catalog-category-filters'),
    results: document.querySelector('#catalog-results'),
    retry: document.querySelector('#catalog-retry'),
    status: document.querySelector('#catalog-status'),
  };
  if (Object.values(elements).some((node) => !node)) return;

  let allProducts = [];
  let categories = [];
  let selectedCategory = null;
  let requestSequence = 0;

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setBusy(isBusy) {
    elements.results.setAttribute('aria-busy', String(isBusy));
  }

  function renderFilters() {
    const group = document.createDocumentFragment();
    const filterOptions = [{ slug: null, name: '全部商品' }, ...categories];
    for (const category of filterOptions) {
      const button = element('button', {
        className: 'catalog-filter__option',
        text: category.name,
      });
      button.type = 'button';
      button.dataset.category = category.slug ?? '';
      button.setAttribute('aria-pressed', String(category.slug === selectedCategory));
      button.addEventListener('click', () => void selectCategory(category.slug));
      group.append(button);
    }
    elements.filters.replaceChildren(group);
  }

  function renderLoading() {
    setBusy(true);
    elements.error.hidden = true;
    elements.results.replaceChildren(...Array.from({ length: 3 }, () => {
      const placeholder = element('article', { className: 'catalog-product-card catalog-product-card--loading' });
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.append(element('span'), element('strong'), element('p'), element('i'));
      return placeholder;
    }));
    setStatus('正在載入公開商品。');
  }

  function renderProducts(products) {
    setBusy(false);
    elements.error.hidden = true;
    if (!products.length) {
      const empty = element('section', { className: 'catalog-message' });
      empty.append(
        element('h2', { text: '目前沒有可展示的商品。' }),
        element('p', { text: '可改選其他分類，或留下需求讓服務人員協助確認。' }),
      );
      const quote = element('a', { className: 'showcase-button', text: '回首頁留下需求' });
      quote.href = '/?intent=quote#apply';
      empty.append(quote);
      elements.results.replaceChildren(empty);
      setStatus('此分類目前沒有可展示的商品。');
      return;
    }
    elements.results.replaceChildren(...products.map(createProductCard));
    setStatus(`已顯示 ${products.length} 項公開商品。`);
  }

  function renderError() {
    setBusy(false);
    elements.results.replaceChildren();
    elements.error.hidden = false;
    setStatus('商品資料暫時無法載入，請重試。');
  }

  function updateUrl(category, mode = 'push') {
    const url = new URL(window.location.href);
    if (category) url.searchParams.set('category', category);
    else url.searchParams.delete('category');
    window.history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function fetchProducts(category) {
    const response = await fetch(catalogRequestPath(category, categories), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('CATALOG_UNAVAILABLE');
    const body = await response.json();
    if (!Array.isArray(body.products)) throw new Error('INVALID_CATALOG_RESPONSE');
    return body.products;
  }

  async function selectCategory(category, { historyMode = 'push' } = {}) {
    const nextCategory = validCategories(categories).some(({ slug }) => slug === category) ? category : null;
    selectedCategory = nextCategory;
    const sequence = ++requestSequence;
    updateUrl(nextCategory, historyMode);
    renderFilters();
    if (!nextCategory) {
      renderProducts(allProducts);
      return;
    }
    renderLoading();
    try {
      const products = await fetchProducts(nextCategory);
      if (sequence !== requestSequence) return;
      renderProducts(products);
    } catch {
      if (sequence !== requestSequence) return;
      renderError();
    }
  }

  async function initialise() {
    renderLoading();
    const sequence = ++requestSequence;
    try {
      allProducts = await fetchProducts(null);
      if (sequence !== requestSequence) return;
      categories = publishedCategories(allProducts);
      const suppliedCategory = hasSingleSearchValue(new URLSearchParams(window.location.search), 'category');
      selectedCategory = categoryFromSearch(window.location.search, categories);
      renderFilters();
      if (suppliedCategory && !selectedCategory) {
        updateUrl(null, 'replace');
        renderProducts(allProducts);
        setStatus('找不到指定分類，已顯示全部公開商品。');
        return;
      }
      if (selectedCategory) {
        await selectCategory(selectedCategory, { historyMode: 'replace' });
        return;
      }
      renderProducts(allProducts);
    } catch {
      if (sequence !== requestSequence) return;
      renderError();
    }
  }

  elements.retry.addEventListener('click', () => void selectCategory(selectedCategory, { historyMode: 'replace' }));
  window.addEventListener('popstate', () => void selectCategory(
    categoryFromSearch(window.location.search, categories),
    { historyMode: 'replace' },
  ));
  void initialise();
}

if (typeof document !== 'undefined') loadPage();
