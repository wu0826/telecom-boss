import { inquiryContextCopy, inquiryContextFromSearch } from './inquiry-context.mjs';

const elements = {
  body: document.body,
  catalogError: document.querySelector('#catalog-error'),
  catalogRetry: document.querySelector('#catalog-retry'),
  catalogStatus: document.querySelector('#catalog-status'),
  catalogStatusText: document.querySelector('#catalog-status-text'),
  comparisonBody: document.querySelector('#comparison-body'),
  comparisonHead: document.querySelector('#comparison-head'),
  formErrorSummary: document.querySelector('#form-error-summary'),
  inquiryAddress: document.querySelector('#inquiry-address'),
  inquiryAnother: document.querySelector('#inquiry-another'),
  inquiryCompany: document.querySelector('#inquiry-company'),
  inquiryConsent: document.querySelector('#inquiry-consent'),
  inquiryEmail: document.querySelector('#inquiry-email'),
  inquiryForm: document.querySelector('#inquiry-form'),
  inquiryName: document.querySelector('#inquiry-name'),
  inquiryNumber: document.querySelector('#inquiry-number'),
  inquiryPhone: document.querySelector('#inquiry-phone'),
  inquiryPlan: document.querySelector('#inquiry-plan'),
  inquirySubmit: document.querySelector('#inquiry-submit'),
  inquirySuccess: document.querySelector('#inquiry-success'),
  liveRegion: document.querySelector('#live-region'),
  menuToggle: document.querySelector('#menu-toggle'),
  navigation: document.querySelector('#site-navigation'),
  planDialog: document.querySelector('#plan-dialog'),
  planDialogClose: document.querySelector('#plan-dialog-close'),
  planDialogContent: document.querySelector('#plan-dialog-content'),
  planGrid: document.querySelector('#plan-grid'),
  publicAnnouncementTitle: document.querySelector('#public-announcement-title'),
  publicAnnouncementSummary: document.querySelector('#public-announcement-summary'),
  selectedPlanCopy: document.querySelector('#selected-plan-copy'),
};

const FIELD_LABELS = {
  address: '裝機地址',
  body: '申裝資料',
  company: '驗證欄位',
  consent: '資料使用同意',
  contact: '聯絡方式',
  email: '電子郵件',
  name: '姓名',
  phone: '聯絡電話',
  planId: '網路方案',
};

let detailReturnFocus = null;
let inquiryAttempt = null;
let legacyCatalogRequest = null;
let menuReturnFocus = null;

const catalogMode = new URLSearchParams(window.location.search).get('catalog') === 'legacy'
  ? 'legacy'
  : 'v2';
let legacyPlansByCode = new Map();

function createElement(tagName, { className, text } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function announce(message) {
  elements.liveRegion.textContent = '';
  window.requestAnimationFrame(() => {
    elements.liveRegion.textContent = message;
  });
}

async function loadPublicContent() {
  try {
    const response = await fetch('/api/v1/content', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const content = await response.json();
    const announcement = content.announcements?.[0];
    if (!announcement) return;
    elements.publicAnnouncementTitle.textContent = announcement.title;
    elements.publicAnnouncementSummary.textContent = announcement.summary ?? announcement.bodyText;
  } catch {
    // The static announcement remains available when optional CMS content cannot load.
  }
}

function displayAmount(amount) {
  return amount?.endsWith('.00') ? amount.slice(0, -3) : amount;
}

function speedLabel(speed) {
  return Number.isFinite(speed) ? `${speed} Mbps` : '依線路條件';
}

function planAudience(plan) {
  if (plan.downloadMbps >= 500) return '多裝置重度使用';
  if (plan.downloadMbps >= 300) return '家庭影音與遊戲';
  return '日常上網與追劇';
}

function feature(text) {
  const item = createElement('li');
  const check = createElement('span', { text: '✓' });
  check.setAttribute('aria-hidden', 'true');
  item.append(check, document.createTextNode(text));
  return item;
}

function selectPlan(plan, { focusForm = false } = {}) {
  elements.inquiryPlan.value = String(plan.id);
  elements.selectedPlanCopy.textContent = `已選擇「${plan.name}」。下一步將協助確認社區涵蓋與安裝時間。`;
  announce(`已選擇${plan.name}`);
  if (focusForm) elements.inquiryPlan.focus();
}

function detailButton(plan) {
  const button = createElement('button', {
    className: 'button button--detail',
    text: '查看完整詳情',
  });
  button.type = 'button';
  button.addEventListener('click', () => openPlanDetail(plan.id, button));
  return button;
}

function renderPlan(plan) {
  const featured = plan.downloadMbps === 300;
  const article = createElement('article', {
    className: `plan-card${featured ? ' plan-card--featured' : ''}`,
  });
  article.dataset.planCode = plan.code;

  if (featured) {
    article.append(createElement('span', { className: 'plan-card__ribbon', text: '最多家庭選擇' }));
  }
  const header = createElement('div', { className: 'plan-card__header' });
  const meta = createElement('p', {
    className: 'plan-card__meta',
    text: `${plan.technology} · ${planAudience(plan)}`,
  });
  const title = createElement('h3', { text: plan.name.replace(/^社區網路\s*/, '') });
  const speed = createElement('div', { className: 'plan-speed' });
  speed.append(
    createElement('strong', { text: String(plan.downloadMbps) }),
    createElement('span', { text: 'Mbps' }),
  );
  header.append(meta, title, speed);

  const pricing = createElement('div', { className: 'plan-pricing' });
  pricing.append(
    createElement('span', { text: '每月最低' }),
    createElement('small', { text: 'NT$' }),
    createElement('strong', { text: displayAmount(plan.lowestMonthlyAmount) }),
    createElement('span', { text: '/ 月' }),
  );
  const priceNotes = createElement('div', { className: 'price-notes' });
  for (const price of plan.prices) {
    const row = createElement('p');
    row.append(
      createElement('span', { text: price.label }),
      createElement('strong', { text: `NT$ ${displayAmount(price.amount)}` }),
    );
    priceNotes.append(row);
  }

  const features = createElement('ul', { className: 'plan-features' });
  features.append(
    feature(plan.bandwidthLabel ?? `${plan.downloadMbps}M 寬頻`),
    feature(`${plan.contractMonths} 個月方案期間`),
    feature(plan.wifiIncluded ? '含 Wi-Fi 連線服務' : '可依需求加購 Wi-Fi 設備'),
  );
  const promotion = plan.promotions.at(0);
  if (promotion?.gift) {
    features.append(feature(`首裝贈 ${promotion.gift.brand} ${promotion.gift.modelName}`));
  }

  const action = createElement('a', {
    className: `button plan-cta${featured ? ' button--primary' : ' button--outline'}`,
    text: '選擇這個方案',
  });
  action.href = '#apply';
  action.addEventListener('click', () => selectPlan(plan));
  const actions = createElement('div', { className: 'plan-card__actions' });
  actions.append(detailButton(plan), action);

  article.append(header, pricing, priceNotes, features, actions);
  return article;
}

function comparisonRow(label, plans, value) {
  const row = createElement('tr');
  const heading = createElement('th', { text: label });
  heading.scope = 'row';
  row.append(heading, ...plans.map((plan) => createElement('td', { text: value(plan) })));
  return row;
}

function renderComparison(plans) {
  const headerRow = createElement('tr');
  const category = createElement('th', { text: '比較項目' });
  category.scope = 'col';
  headerRow.append(category);
  for (const plan of plans) {
    const heading = createElement('th');
    heading.scope = 'col';
    heading.append(
      createElement('span', { text: plan.technology }),
      createElement('strong', { text: `${plan.downloadMbps}M` }),
    );
    headerRow.append(heading);
  }
  elements.comparisonHead.replaceChildren(headerRow);
  elements.comparisonBody.replaceChildren(
    comparisonRow('下載速度', plans, (plan) => speedLabel(plan.downloadMbps)),
    comparisonRow('上傳速度', plans, (plan) => speedLabel(plan.uploadMbps)),
    comparisonRow('每月最低', plans, (plan) => `NT$ ${displayAmount(plan.lowestMonthlyAmount)}`),
    comparisonRow('方案期間', plans, (plan) => `${plan.contractMonths} 個月`),
    comparisonRow('適合情境', plans, planAudience),
    comparisonRow('首裝贈品', plans, (plan) => {
      const gift = plan.promotions.at(0)?.gift;
      return gift ? `${gift.brand} ${gift.modelName}` : '—';
    }),
  );
}

function renderPlanOptions(plans) {
  const placeholder = createElement('option', { text: '請選擇網路方案' });
  placeholder.value = '';
  elements.inquiryPlan.replaceChildren(placeholder);
  for (const plan of plans) {
    const option = createElement('option', {
      text: `${plan.name.replace(/^社區網路\s*/, '')}｜NT$ ${displayAmount(plan.lowestMonthlyAmount)} 起`,
    });
    option.value = String(plan.id);
    elements.inquiryPlan.append(option);
  }
}

function renderCatalog(catalog) {
  elements.planGrid.replaceChildren(...catalog.plans.map(renderPlan));
  elements.planGrid.setAttribute('aria-busy', 'false');
  elements.catalogStatus.hidden = true;
  renderComparison(catalog.plans);
  renderPlanOptions(catalog.plans);

  if (catalog.plans.length === 0) {
    const empty = createElement('div', { className: 'catalog-empty' });
    empty.append(
      createElement('strong', { text: '目前沒有可申裝方案' }),
      createElement('p', { text: '新方案整理中，請稍後再回來看看。' }),
    );
    elements.planGrid.replaceChildren(empty);
    announce('目前沒有可申裝方案');
    return;
  }
  announce(`已載入 ${catalog.plans.length} 個網路方案`);
}

function productTitle(product) {
  return product.content?.title?.trim() || product.name;
}

function productSummary(product) {
  return product.content?.summary?.trim() || '由專人協助確認可用服務與適用方案。';
}

function productPrice(product) {
  if (product.pricing.kind === 'PLAN' && product.pricing.lowestMonthlyAmount) {
    return { label: '每月最低', amount: displayAmount(product.pricing.lowestMonthlyAmount), suffix: '/ 月' };
  }
  if (product.pricing.kind === 'STOCK' && product.pricing.sellingPrice) {
    return { label: '建議售價', amount: displayAmount(product.pricing.sellingPrice), suffix: '起' };
  }
  return { label: '服務方式', amount: '洽詢', suffix: '專人' };
}

function productPromotionLabel(product) {
  const promotion = product.promotions.at(0);
  if (!promotion) return '依社區條件確認可用服務';
  if (promotion.gift) return `${promotion.name} · 贈 ${promotion.gift.brand} ${promotion.gift.modelName}`;
  return promotion.name;
}

function safePublicUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value, window.location.origin);
    const isSameOriginAsset = url.origin === window.location.origin && value.startsWith('/');
    return url.protocol === 'https:' || isSameOriginAsset ? url.href : null;
  } catch {
    return null;
  }
}

function productImage(media, { className = 'product-card__image' } = {}) {
  const url = safePublicUrl(media?.url);
  if (!url) return null;
  const image = document.createElement('img');
  image.className = className;
  image.src = url;
  image.alt = media.altText || '';
  image.loading = 'lazy';
  return image;
}

function selectProductForInquiry(product, { focusForm = false } = {}) {
  const plan = product.inquiry?.kind === 'PLAN'
    ? legacyPlansByCode.get(product.inquiry.planCode)
    : null;
  if (plan) {
    selectPlan(plan, { focusForm });
    return;
  }

  elements.selectedPlanCopy.textContent = `想了解「${productTitle(product)}」嗎？請選擇下方網路方案並留下資料，我們會一併協助確認。`;
  announce(`已開啟 ${productTitle(product)} 的洽詢方式`);
  if (focusForm) elements.inquiryPlan.focus();
}

function restoreInquiryContext(products) {
  const context = inquiryContextFromSearch(window.location.search);
  if (!context.intent && !context.productSlug) return;

  const product = context.productSlug
    ? products.find((item) => item.slug === context.productSlug) ?? null
    : null;
  if (product) {
    const title = productTitle(product);
    const plan = product.inquiry?.kind === 'PLAN'
      ? legacyPlansByCode.get(product.inquiry.planCode)
      : null;
    if (plan) elements.inquiryPlan.value = String(plan.id);
    elements.selectedPlanCopy.textContent = `已帶入「${title}」。${inquiryContextCopy(context.intent)}`;
    announce(`已帶入${title}的詢價內容`);
  } else if (context.productSlug) {
    elements.selectedPlanCopy.textContent = `你開啟的商品目前不在公開目錄中。${inquiryContextCopy(context.intent)}`;
    announce('找不到原本的公開商品，請重新選擇方案');
  } else {
    elements.selectedPlanCopy.textContent = inquiryContextCopy(context.intent);
    announce(inquiryContextCopy(context.intent));
  }

  if (window.location.hash === '#apply') {
    window.setTimeout(() => elements.inquiryPlan.focus(), 0);
  }
}

function productDetailButton(product) {
  const button = createElement('button', {
    className: 'button button--detail',
    text: '查看完整詳情',
  });
  button.type = 'button';
  button.addEventListener('click', () => openProductDetail(product.slug, button));
  return button;
}

function renderProduct(product) {
  const featured = product.isFeatured;
  const article = createElement('article', {
    className: `plan-card product-card${featured ? ' plan-card--featured' : ''}`,
  });
  article.dataset.productSlug = product.slug;

  if (featured) article.append(createElement('span', { className: 'plan-card__ribbon', text: '精選推薦' }));
  const image = productImage(product.media);
  if (image) {
    const media = createElement('div', { className: 'product-card__media' });
    media.append(image);
    article.append(media);
  }

  const header = createElement('div', { className: 'plan-card__header product-card__header' });
  header.append(
    createElement('p', { className: 'plan-card__meta', text: product.category.name }),
    createElement('h3', { text: productTitle(product) }),
    createElement('p', { className: 'product-card__summary', text: productSummary(product) }),
  );

  const price = productPrice(product);
  const pricing = createElement('div', { className: 'plan-pricing product-pricing' });
  pricing.append(
    createElement('span', { text: price.label }),
    createElement('small', { text: price.amount === '洽詢' ? '' : 'NT$' }),
    createElement('strong', { text: price.amount }),
    createElement('span', { text: price.suffix }),
  );
  const notes = createElement('div', { className: 'price-notes product-card__notes' });
  const priceRows = product.pricing.prices;
  if (priceRows.length > 0) {
    for (const item of priceRows) {
      const row = createElement('p');
      row.append(
        createElement('span', { text: item.label }),
        createElement('strong', { text: `NT$ ${displayAmount(item.amount)}` }),
      );
      notes.append(row);
    }
  } else {
    notes.append(createElement('p', { text: productPromotionLabel(product) }));
  }

  const features = createElement('ul', { className: 'plan-features product-card__features' });
  features.append(
    feature(`商品分類：${product.category.name}`),
    feature(productPromotionLabel(product)),
  );
  const action = createElement('a', {
    className: `button plan-cta${featured ? ' button--primary' : ' button--outline'}`,
    text: product.inquiry?.kind === 'PLAN' ? '選擇此方案並申裝' : '洽詢此商品',
  });
  action.href = '#apply';
  action.addEventListener('click', () => selectProductForInquiry(product));
  const actions = createElement('div', { className: 'plan-card__actions' });
  actions.append(productDetailButton(product), action);

  article.append(header, pricing, notes, features, actions);
  return article;
}

function renderProductComparison(products) {
  const comparableProducts = products.slice(0, 3);
  const headerRow = createElement('tr');
  const category = createElement('th', { text: '比較項目' });
  category.scope = 'col';
  headerRow.append(category);
  for (const product of comparableProducts) {
    const heading = createElement('th');
    heading.scope = 'col';
    heading.append(
      createElement('span', { text: product.category.name }),
      createElement('strong', { text: productTitle(product) }),
    );
    headerRow.append(heading);
  }
  elements.comparisonHead.replaceChildren(headerRow);
  elements.comparisonBody.replaceChildren(
    comparisonRow('商品分類', comparableProducts, (product) => product.category.name),
    comparisonRow('價格', comparableProducts, (product) => {
      const price = productPrice(product);
      return price.amount === '洽詢' ? '洽詢專人' : `NT$ ${price.amount}${price.suffix}`;
    }),
    comparisonRow('目前優惠', comparableProducts, productPromotionLabel),
  );
}

function renderProductCatalog(catalog) {
  const products = catalog.products;
  elements.planGrid.replaceChildren(...products.map(renderProduct));
  elements.planGrid.setAttribute('aria-busy', 'false');
  elements.catalogStatus.hidden = true;
  renderProductComparison(products);

  if (products.length === 0) {
    const empty = createElement('div', { className: 'catalog-empty' });
    empty.append(
      createElement('strong', { text: '目前沒有公開商品' }),
      createElement('p', { text: '新服務與商品正在整理中，請稍後再回來看看。' }),
    );
    elements.planGrid.replaceChildren(empty);
    announce('目前沒有公開商品');
    return;
  }
  announce(`已載入 ${products.length} 項服務與商品`);
}

async function fetchLegacyCatalog() {
  if (!legacyCatalogRequest) {
    legacyCatalogRequest = fetch('/api/v1/catalog', { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Legacy catalog request failed: ${response.status}`);
        return response.json();
      });
  }
  return legacyCatalogRequest;
}

function loadLegacyPlanOptions(catalog) {
  legacyPlansByCode = new Map(catalog.plans.map((plan) => [plan.code, plan]));
  renderPlanOptions(catalog.plans);
}

async function loadCatalogV2() {
  const productRequest = fetch('/api/v1/catalog/products?locale=zh-TW', {
    headers: { Accept: 'application/json' },
  });
  const legacyCatalog = fetchLegacyCatalog().catch(() => null);
  const response = await productRequest;
  if (!response.ok) throw new Error(`Product catalog request failed: ${response.status}`);
  const [catalog, legacy] = await Promise.all([response.json(), legacyCatalog]);
  if (legacy) loadLegacyPlanOptions(legacy);
  else renderPlanOptions([]);
  renderProductCatalog(catalog);
  restoreInquiryContext(catalog.products);
}

async function loadLegacyCatalog() {
  const catalog = await fetchLegacyCatalog();
  loadLegacyPlanOptions(catalog);
  renderCatalog(catalog);
  restoreInquiryContext([]);
}

async function loadCatalog() {
  elements.catalogError.hidden = true;
  elements.planGrid.hidden = false;
  elements.catalogStatus.hidden = false;
  elements.catalogStatusText.textContent = catalogMode === 'legacy'
    ? '正在載入既有方案'
    : '正在載入最新商品';
  elements.planGrid.setAttribute('aria-busy', 'true');

  try {
    if (catalogMode === 'legacy') await loadLegacyCatalog();
    else await loadCatalogV2();
  } catch {
    legacyCatalogRequest = null;
    elements.planGrid.hidden = true;
    elements.catalogStatus.hidden = true;
    elements.catalogError.hidden = false;
    elements.planGrid.setAttribute('aria-busy', 'false');
    announce(catalogMode === 'legacy' ? '既有方案載入失敗，請重新載入' : '商品載入失敗，請重新載入');
  }
}

function renderDialogPlan(plan) {
  const heading = createElement('h2', {
    text: plan.name.replace(/^社區網路\s*/, ''),
  });
  heading.id = 'plan-dialog-title';
  const lead = createElement('p', {
    className: 'plan-dialog__lead',
    text: `${plan.downloadMbps}M 下載，上傳速率${speedLabel(plan.uploadMbps)}，${planAudience(plan)}。`,
  });
  const facts = createElement('dl', { className: 'plan-dialog__facts' });
  const factValues = [
    ['連線技術', plan.technology],
    ['月租最低', `NT$ ${displayAmount(plan.lowestMonthlyAmount)}`],
    ['方案期間', `${plan.contractMonths} 個月`],
    ['Wi-Fi 服務', plan.wifiIncluded ? '方案包含' : '可另行加購'],
  ];
  for (const [term, description] of factValues) {
    facts.append(createElement('dt', { text: term }), createElement('dd', { text: description }));
  }
  const priceTitle = createElement('h3', { text: '價格期間' });
  const prices = createElement('ul', { className: 'plan-dialog__prices' });
  for (const price of plan.prices) {
    const item = createElement('li');
    item.append(
      createElement('span', { text: price.label }),
      createElement('strong', { text: `NT$ ${displayAmount(price.amount)}／月` }),
    );
    prices.append(item);
  }
  const button = createElement('button', {
    className: 'button button--primary plan-dialog__select',
    text: '選擇此方案並申裝',
  });
  button.type = 'button';
  button.addEventListener('click', () => {
    selectPlan(plan);
    elements.planDialog.close();
    window.location.hash = 'apply';
    window.setTimeout(() => elements.inquiryPlan.focus(), 0);
  });
  elements.planDialogContent.replaceChildren(heading, lead, facts, priceTitle, prices, button);
}

async function openPlanDetail(planId, opener) {
  detailReturnFocus = opener;
  const loadingTitle = createElement('h2', { text: '正在載入方案詳情' });
  loadingTitle.id = 'plan-dialog-title';
  elements.planDialogContent.replaceChildren(loadingTitle);
  elements.planDialog.showModal();

  try {
    const response = await fetch(`/api/v1/catalog/plans/${planId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Plan request failed: ${response.status}`);
    renderDialogPlan((await response.json()).plan);
  } catch {
    const errorTitle = createElement('h2', { text: '暫時無法顯示方案詳情' });
    errorTitle.id = 'plan-dialog-title';
    elements.planDialogContent.replaceChildren(
      errorTitle,
      createElement('p', { text: '請關閉視窗後稍後再試。' }),
    );
  }
}

function detailPriceList(product) {
  const price = productPrice(product);
  const section = createElement('section', { className: 'product-dialog__section' });
  section.append(createElement('h3', { text: '價格與方案' }));
  const list = createElement('ul', { className: 'plan-dialog__prices' });
  if (product.pricing.prices.length > 0) {
    for (const item of product.pricing.prices) {
      const row = createElement('li');
      row.append(
        createElement('span', { text: item.label }),
        createElement('strong', { text: `NT$ ${displayAmount(item.amount)}${item.billingCycle === 'MONTHLY' ? '／月' : ''}` }),
      );
      list.append(row);
    }
  } else {
    const row = createElement('li');
    row.append(
      createElement('span', { text: price.label }),
      createElement('strong', { text: price.amount === '洽詢' ? '洽詢專人' : `NT$ ${price.amount}${price.suffix}` }),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function detailSections(product) {
  return product.sections.map((section) => {
    const wrapper = createElement('section', { className: 'product-dialog__section' });
    if (section.title) wrapper.append(createElement('h3', { text: section.title }));
    wrapper.append(createElement('p', { text: section.bodyText }));
    return wrapper;
  });
}

function detailSpecifications(product) {
  if (product.specifications.length === 0) return null;
  const section = createElement('section', { className: 'product-dialog__section' });
  section.append(createElement('h3', { text: '規格資訊' }));
  const groups = new Map();
  for (const specification of product.specifications) {
    const group = groups.get(specification.groupKey) ?? {
      label: specification.groupLabel,
      specifications: [],
    };
    group.specifications.push(specification);
    groups.set(specification.groupKey, group);
  }
  for (const group of groups.values()) {
    section.append(createElement('h4', { text: group.label }));
    const facts = createElement('dl', { className: 'plan-dialog__facts' });
    for (const specification of group.specifications) {
      facts.append(
        createElement('dt', { text: specification.label }),
        createElement('dd', { text: `${specification.value}${specification.unit ? ` ${specification.unit}` : ''}` }),
      );
    }
    section.append(facts);
  }
  return section;
}

function detailPromotions(product) {
  if (product.promotions.length === 0) return null;
  const section = createElement('section', { className: 'product-dialog__section' });
  section.append(createElement('h3', { text: '目前優惠' }));
  const list = createElement('ul', { className: 'product-dialog__list' });
  for (const promotion of product.promotions) {
    const item = createElement('li');
    item.append(createElement('strong', { text: promotion.name }));
    if (promotion.description) item.append(createElement('span', { text: promotion.description }));
    if (promotion.gift) item.append(createElement('span', { text: `贈 ${promotion.gift.brand} ${promotion.gift.modelName}` }));
    list.append(item);
  }
  section.append(list);
  return section;
}

function detailBrands(product) {
  if (product.brands.length === 0) return null;
  const section = createElement('section', { className: 'product-dialog__section' });
  section.append(createElement('h3', { text: '合作品牌' }));
  const list = createElement('ul', { className: 'product-dialog__list' });
  for (const brand of product.brands) {
    const item = createElement('li');
    const url = safePublicUrl(brand.websiteUrl);
    const title = url ? document.createElement('a') : createElement('strong');
    title.textContent = brand.name;
    if (url) {
      title.href = url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    item.append(title);
    if (brand.description) item.append(createElement('span', { text: brand.description }));
    list.append(item);
  }
  section.append(list);
  return section;
}

function detailMedia(product) {
  const media = product.media.map((item) => productImage(item, { className: 'product-dialog__image' })).filter(Boolean);
  if (media.length === 0) return null;
  const wrapper = createElement('div', { className: 'product-dialog__media' });
  wrapper.append(...media);
  return wrapper;
}

function productInquiryButton(product) {
  const button = createElement('button', {
    className: 'button button--primary plan-dialog__select',
    text: product.inquiry?.kind === 'PLAN' ? '選擇此方案並申裝' : '洽詢此商品',
  });
  button.type = 'button';
  button.addEventListener('click', () => {
    selectProductForInquiry(product);
    elements.planDialog.close();
    window.location.hash = 'apply';
    window.setTimeout(() => elements.inquiryPlan.focus(), 0);
  });
  return button;
}

function renderProductDialog(product) {
  const heading = createElement('h2', { text: productTitle(product) });
  heading.id = 'plan-dialog-title';
  const lead = createElement('p', { className: 'plan-dialog__lead', text: productSummary(product) });
  const facts = createElement('dl', { className: 'plan-dialog__facts' });
  facts.append(
    createElement('dt', { text: '商品分類' }),
    createElement('dd', { text: product.category.name }),
    createElement('dt', { text: '服務方式' }),
    createElement('dd', { text: product.inquiry?.kind === 'PLAN' ? '線上申裝洽詢' : '客服協助洽詢' }),
  );
  const content = [];
  const media = detailMedia(product);
  const body = product.content?.bodyText
    ? createElement('p', { className: 'product-dialog__body', text: product.content.bodyText })
    : null;
  const specifications = detailSpecifications(product);
  const promotions = detailPromotions(product);
  const brands = detailBrands(product);
  content.push(heading, lead, media, facts, body, detailPriceList(product), ...detailSections(product), specifications, promotions, brands, productInquiryButton(product));
  elements.planDialogContent.replaceChildren(...content.filter(Boolean));
}

async function openProductDetail(slug, opener) {
  detailReturnFocus = opener;
  const loadingTitle = createElement('h2', { text: '正在載入商品詳情' });
  loadingTitle.id = 'plan-dialog-title';
  elements.planDialogContent.replaceChildren(loadingTitle);
  elements.planDialog.showModal();

  try {
    const response = await fetch(`/api/v1/catalog/products/${encodeURIComponent(slug)}?locale=zh-TW`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      const title = createElement('h2', { text: '商品目前未開放' });
      title.id = 'plan-dialog-title';
      elements.planDialogContent.replaceChildren(
        title,
        createElement('p', { text: '這個商品連結可能已過期，請關閉視窗後查看目前公開內容。' }),
      );
      return;
    }
    if (!response.ok) throw new Error(`Product request failed: ${response.status}`);
    renderProductDialog((await response.json()).product);
  } catch {
    const errorTitle = createElement('h2', { text: '暫時無法顯示商品詳情' });
    errorTitle.id = 'plan-dialog-title';
    elements.planDialogContent.replaceChildren(
      errorTitle,
      createElement('p', { text: '請關閉視窗後稍後再試。' }),
    );
  }
}

function openMenu() {
  menuReturnFocus = document.activeElement;
  elements.body.dataset.navOpen = 'true';
  elements.menuToggle.setAttribute('aria-expanded', 'true');
  elements.menuToggle.setAttribute('aria-label', '關閉網站選單');
  window.setTimeout(() => elements.navigation.querySelector('a')?.focus(), 200);
}

function closeMenu({ restoreFocus = false } = {}) {
  delete elements.body.dataset.navOpen;
  elements.menuToggle.setAttribute('aria-expanded', 'false');
  elements.menuToggle.setAttribute('aria-label', '開啟網站選單');
  if (restoreFocus && menuReturnFocus instanceof HTMLElement) menuReturnFocus.focus();
}

function inquiryPayload() {
  return {
    planId: Number(elements.inquiryPlan.value),
    name: elements.inquiryName.value.trim(),
    phone: elements.inquiryPhone.value.trim(),
    email: elements.inquiryEmail.value.trim(),
    address: elements.inquiryAddress.value.trim(),
    consent: elements.inquiryConsent.checked,
    company: elements.inquiryCompany.value,
  };
}

function showFormErrors(details) {
  const title = createElement('strong', { text: '請確認以下欄位：' });
  const list = createElement('ul');
  for (const detail of details) {
    list.append(createElement('li', {
      text: `${FIELD_LABELS[detail.field] ?? detail.field}：${detail.message}`,
    }));
  }
  elements.formErrorSummary.replaceChildren(title, list);
  elements.formErrorSummary.hidden = false;
  elements.formErrorSummary.focus();
}

function validateContact() {
  elements.inquiryPhone.setCustomValidity('');
  if (!elements.inquiryPhone.value.trim() && !elements.inquiryEmail.value.trim()) {
    elements.inquiryPhone.setCustomValidity('電話與電子郵件至少填寫一項');
  }
}

function browserValidationDetails() {
  const details = [];
  for (const field of elements.inquiryForm.elements) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    if (!field.validity.valid) {
      details.push({ field: field.name === 'planId' ? 'planId' : field.name, message: field.validationMessage });
    }
  }
  return details;
}

async function submitInquiry(event) {
  event.preventDefault();
  elements.formErrorSummary.hidden = true;
  validateContact();
  if (!elements.inquiryForm.checkValidity()) {
    showFormErrors(browserValidationDetails());
    return;
  }

  const payload = inquiryPayload();
  const serializedPayload = JSON.stringify(payload);
  if (inquiryAttempt?.payload !== serializedPayload) {
    inquiryAttempt = { key: crypto.randomUUID(), payload: serializedPayload };
  }

  elements.inquirySubmit.disabled = true;
  elements.inquirySubmit.textContent = '正在安全送出…';
  try {
    const response = await fetch('/api/v1/inquiries', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': inquiryAttempt.key,
      },
      body: serializedPayload,
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error?.message ?? '申裝送件失敗');
      error.details = body.error?.details ?? [];
      throw error;
    }

    elements.inquiryNumber.textContent = body.inquiryNo;
    elements.inquiryForm.hidden = true;
    elements.inquirySuccess.hidden = false;
    elements.inquirySuccess.focus();
    elements.inquiryForm.reset();
    inquiryAttempt = null;
    announce(`申裝洽詢已送出，洽詢編號 ${body.inquiryNo}`);
  } catch (error) {
    const details = Array.isArray(error.details) && error.details.length > 0
      ? error.details
      : [{ field: 'body', message: error.message || '暫時無法送出，請稍後再試' }];
    showFormErrors(details);
  } finally {
    elements.inquirySubmit.disabled = false;
    elements.inquirySubmit.textContent = '送出申裝洽詢';
  }
}

elements.menuToggle.addEventListener('click', () => {
  if (elements.body.dataset.navOpen === 'true') closeMenu({ restoreFocus: true });
  else openMenu();
});
elements.navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
elements.catalogRetry.addEventListener('click', loadCatalog);
elements.planDialogClose.addEventListener('click', () => elements.planDialog.close());
elements.planDialog.addEventListener('click', (event) => {
  if (event.target === elements.planDialog) elements.planDialog.close();
});
elements.planDialog.addEventListener('close', () => {
  if (detailReturnFocus instanceof HTMLElement) detailReturnFocus.focus();
});
elements.inquiryForm.addEventListener('submit', submitInquiry);
elements.inquiryPhone.addEventListener('input', validateContact);
elements.inquiryEmail.addEventListener('input', validateContact);
elements.inquiryAnother.addEventListener('click', () => {
  elements.inquirySuccess.hidden = true;
  elements.inquiryForm.hidden = false;
  elements.inquiryPlan.focus();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.body.dataset.navOpen === 'true') {
    closeMenu({ restoreFocus: true });
  }
});

loadCatalog();
loadPublicContent();
