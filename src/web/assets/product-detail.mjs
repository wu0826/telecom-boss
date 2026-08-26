const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVICE_ROUTE_BY_CATEGORY = new Map([
  ['services-broadband', {
    href: '/services/fiber-broadband.html',
    text: '查看寬頻服務介紹',
  }],
]);

function element(tagName, { className, text } = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeAssetUrl(value) {
  const url = nonEmptyText(value);
  if (!url) return null;
  return (url.startsWith('/') && !url.startsWith('//')) || /^https:\/\//i.test(url) ? url : null;
}

function safeWebsiteUrl(value) {
  const url = nonEmptyText(value);
  return url && /^https:\/\//i.test(url) ? url : null;
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
  return `/?${new URLSearchParams({ intent: 'quote', product }).toString()}#apply`;
}

function audienceForProduct(type) {
  if (type === 'SERVICE_PLAN') return '想先比較公開月租與申裝條件的使用者。';
  if (type === 'STOCK_ITEM') return '準備搭配網路服務評估設備的使用者。';
  return '想先了解公開商品資訊的使用者。';
}

function detailPrices(pricing) {
  const prices = Array.isArray(pricing?.prices) ? pricing.prices : [];
  const projected = prices.flatMap((price) => {
    const label = nonEmptyText(price?.label);
    const amount = formatAmount(price?.amount);
    return label && amount ? [{ label, amount }] : [];
  }).slice(0, 3);
  if (projected.length) return projected;

  const lowestMonthlyAmount = formatAmount(pricing?.lowestMonthlyAmount);
  if (lowestMonthlyAmount) return [{ label: '每月最低', amount: lowestMonthlyAmount }];
  const sellingPrice = formatAmount(pricing?.sellingPrice);
  return sellingPrice ? [{ label: '公開售價', amount: sellingPrice }] : [];
}

function detailPromotions(promotions) {
  if (!Array.isArray(promotions)) return [];
  return promotions.flatMap((promotion) => {
    const name = nonEmptyText(promotion?.name) ?? '公開優惠';
    const description = nonEmptyText(promotion?.description);
    const giftBrand = nonEmptyText(promotion?.gift?.brand);
    const giftModel = nonEmptyText(promotion?.gift?.modelName);
    const gift = giftBrand && giftModel ? `贈 ${giftBrand} ${giftModel}` : null;
    return description || gift ? [{ name, description, gift }] : [];
  }).slice(0, 2);
}

function detailSpecifications(specifications) {
  if (!Array.isArray(specifications)) return [];
  return specifications.flatMap((specification) => {
    const label = nonEmptyText(specification?.label);
    const rawValue = nonEmptyText(specification?.value);
    const unit = nonEmptyText(specification?.unit);
    if (!label || !rawValue) return [];
    return [{
      groupLabel: nonEmptyText(specification?.groupLabel) ?? '公開規格',
      label,
      value: unit ? `${rawValue} ${unit}` : rawValue,
    }];
  }).slice(0, 5);
}

function detailSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) => {
    const title = nonEmptyText(section?.title);
    const bodyText = nonEmptyText(section?.bodyText);
    return title && bodyText ? [{ title, bodyText }] : [];
  }).slice(0, 3);
}

function detailBrands(brands) {
  if (!Array.isArray(brands)) return [];
  return brands.flatMap((brand) => {
    const name = nonEmptyText(brand?.name);
    if (!name) return [];
    return [{
      name,
      description: nonEmptyText(brand?.description),
      websiteUrl: safeWebsiteUrl(brand?.websiteUrl),
    }];
  }).slice(0, 3);
}

export function productSlugFromSearch(search) {
  const values = new URLSearchParams(search).getAll('product');
  if (values.length !== 1 || !PRODUCT_SLUG_PATTERN.test(values[0])) return null;
  return values[0];
}

export function productDetailView(product) {
  const slug = typeof product?.slug === 'string' && PRODUCT_SLUG_PATTERN.test(product.slug) ? product.slug : '';
  const categorySlug = nonEmptyText(product?.category?.slug);
  const safeMedia = Array.isArray(product?.media)
    ? product.media.flatMap((media) => {
      const url = safeAssetUrl(media?.url);
      return url ? [{ url, altText: nonEmptyText(media?.altText) ?? '' }] : [];
    })
    : [];
  return {
    audience: audienceForProduct(product?.type),
    brands: detailBrands(product?.brands),
    category: nonEmptyText(product?.category?.name) ?? '公開分類',
    description: nonEmptyText(product?.content?.bodyText),
    media: safeMedia[0] ?? null,
    name: nonEmptyText(product?.content?.title) ?? nonEmptyText(product?.name) ?? '公開商品',
    prices: detailPrices(product?.pricing),
    promotions: detailPromotions(product?.promotions),
    quoteHref: quoteHref(slug),
    sections: detailSections(product?.sections),
    serviceRoute: categorySlug && SERVICE_ROUTE_BY_CATEGORY.has(categorySlug)
      ? SERVICE_ROUTE_BY_CATEGORY.get(categorySlug)
      : null,
    specifications: detailSpecifications(product?.specifications),
    summary: nonEmptyText(product?.content?.summary) ?? '目前沒有公開摘要，可先查看價格與可用方案。',
  };
}

function statusMessage(elements, message) {
  elements.status.textContent = message;
}

function renderMessage(elements, { title, copy, retry = false }) {
  elements.results.setAttribute('aria-busy', 'false');
  const message = element('section', { className: 'product-detail-message' });
  message.append(element('h1', { text: title }), element('p', { text: copy }));
  const actions = element('div', { className: 'product-detail-message__actions' });
  let retryButton = null;
  if (retry) {
    retryButton = element('button', { className: 'showcase-button', text: '重新載入商品' });
    retryButton.type = 'button';
    retryButton.id = 'product-detail-retry';
    actions.append(retryButton);
  }
  const catalog = element('a', { className: 'showcase-button showcase-button--text', text: '回商品目錄' });
  catalog.href = '/products/catalog.html';
  actions.append(catalog);
  message.append(actions);
  elements.results.replaceChildren(message);
  return retryButton;
}

function renderLoading(elements) {
  elements.results.setAttribute('aria-busy', 'true');
  const loading = element('section', { className: 'product-detail-loading' });
  loading.setAttribute('aria-hidden', 'true');
  loading.append(element('span'), element('strong'), element('p'), element('i'));
  elements.results.replaceChildren(loading);
  statusMessage(elements, '正在載入公開商品詳細內容。');
}

function appendPriceSection(target, prices) {
  const section = element('section', { className: 'product-detail-prices', text: undefined });
  section.append(element('h2', { text: '公開價格' }));
  if (!prices.length) {
    section.append(element('p', { text: '目前沒有可展示的公開價格，實際內容以服務人員確認為準。' }));
  } else {
    const list = element('dl');
    for (const price of prices) {
      list.append(element('dt', { text: price.label }), element('dd', { text: `NT$ ${price.amount}` }));
    }
    section.append(list);
  }
  target.append(section);
}

function appendDetailSection(target, heading, className, entries, createEntry, emptyCopy) {
  const section = element('section', { className });
  section.append(element('h2', { text: heading }));
  if (entries.length) section.append(...entries.map(createEntry));
  else section.append(element('p', { text: emptyCopy }));
  target.append(section);
}

function renderDetail(elements, detail) {
  elements.results.setAttribute('aria-busy', 'false');
  const fragment = document.createDocumentFragment();
  const hero = element('section', { className: 'product-detail-hero' });
  const heroGrid = element('div', { className: 'product-detail-hero__grid' });
  const copy = element('div');
  copy.append(
    element('p', { className: 'showcase-kicker', text: detail.category }),
    element('h1', { text: detail.name }),
    element('p', { className: 'product-detail-hero__summary', text: detail.summary }),
  );
  const actions = element('div', { className: 'product-detail-hero__actions' });
  const quote = element('a', { className: 'showcase-button showcase-button--coral', text: '帶著此商品詢價' });
  quote.href = detail.quoteHref;
  const catalog = element('a', { className: 'showcase-button showcase-button--text', text: '回商品目錄' });
  catalog.href = '/products/catalog.html';
  actions.append(quote, catalog);
  copy.append(actions);
  heroGrid.append(copy);
  if (detail.media) {
    const media = element('figure', { className: 'product-detail-media' });
    const image = document.createElement('img');
    image.src = detail.media.url;
    image.alt = detail.media.altText;
    image.loading = 'lazy';
    media.append(image);
    heroGrid.append(media);
  } else {
    const mediaFallback = element('aside', { className: 'product-detail-media product-detail-media--fallback' });
    mediaFallback.setAttribute('aria-label', '此商品目前沒有公開圖片');
    mediaFallback.append(element('span', { text: 'PUBLIC DATA' }), element('strong', { text: detail.category }));
    heroGrid.append(mediaFallback);
  }
  hero.append(heroGrid);
  fragment.append(hero);

  const overview = element('section', { className: 'product-detail-overview' });
  const overviewGrid = element('div', { className: 'showcase-container product-detail-overview__grid' });
  const context = element('div', { className: 'product-detail-context' });
  context.append(element('h2', { text: '這項商品適合誰？' }), element('p', { text: detail.audience }));
  if (detail.description) context.append(element('p', { text: detail.description }));
  if (detail.serviceRoute) {
    const serviceLink = element('a', { className: 'product-detail-context__link', text: detail.serviceRoute.text });
    serviceLink.href = detail.serviceRoute.href;
    context.append(serviceLink);
  }
  overviewGrid.append(context);
  appendPriceSection(overviewGrid, detail.prices);
  overview.append(overviewGrid);
  fragment.append(overview);

  const information = element('section', { className: 'showcase-section product-detail-information' });
  const informationGrid = element('div', { className: 'showcase-container product-detail-information__grid' });
  appendDetailSection(
    informationGrid,
    '公開規格',
    'product-detail-specifications',
    detail.specifications,
    (specification) => {
      const row = element('div');
      row.append(
        element('span', { text: specification.groupLabel }),
        element('strong', { text: specification.label }),
        element('b', { text: specification.value }),
      );
      return row;
    },
    '目前沒有可展示的公開規格。',
  );
  appendDetailSection(
    informationGrid,
    '公開優惠與內容',
    'product-detail-promotions',
    detail.promotions,
    (promotion) => {
      const item = element('article');
      item.append(element('h3', { text: promotion.name }));
      if (promotion.description) item.append(element('p', { text: promotion.description }));
      if (promotion.gift) item.append(element('strong', { text: promotion.gift }));
      return item;
    },
    '目前沒有可展示的公開優惠。',
  );
  information.append(informationGrid);
  fragment.append(information);

  if (detail.sections.length || detail.brands.length) {
    const supplementary = element('section', { className: 'showcase-section showcase-section--mist product-detail-supplementary' });
    const supplementaryGrid = element('div', { className: 'showcase-container product-detail-supplementary__grid' });
    if (detail.sections.length) {
      appendDetailSection(supplementaryGrid, '更多公開說明', 'product-detail-sections', detail.sections, (section) => {
        const item = element('article');
        item.append(element('h3', { text: section.title }), element('p', { text: section.bodyText }));
        return item;
      }, '');
    }
    if (detail.brands.length) {
      appendDetailSection(supplementaryGrid, '公開品牌資訊', 'product-detail-brands', detail.brands, (brand) => {
        const item = element('article');
        item.append(element('h3', { text: brand.name }));
        if (brand.description) item.append(element('p', { text: brand.description }));
        if (brand.websiteUrl) {
          const link = element('a', { text: '查看品牌網站（另開）' });
          link.href = brand.websiteUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          item.append(link);
        }
        return item;
      }, '');
    }
    supplementary.append(supplementaryGrid);
    fragment.append(supplementary);
  }

  const closing = element('section', { className: 'showcase-closing' });
  const closingInner = element('div', { className: 'showcase-container showcase-closing__inner' });
  const closingCopy = element('div');
  closingCopy.append(
    element('p', { className: 'showcase-kicker', text: 'NEXT NODE' }),
    element('h2', { text: '想確認適用條件？把這項商品一起帶回詢價。' }),
    element('p', { text: '服務人員會依實際涵蓋、安裝與需求條件協助確認下一步。' }),
  );
  const closingQuote = element('a', { className: 'showcase-button showcase-button--coral', text: '帶著此商品詢價' });
  closingQuote.href = detail.quoteHref;
  closingInner.append(closingCopy, closingQuote);
  closing.append(closingInner);
  fragment.append(closing);
  elements.results.replaceChildren(fragment);
  document.title = `${detail.name}｜比奇堡電信`;
  statusMessage(elements, `已載入${detail.name}的公開商品詳細內容。`);
}

function loadPage() {
  const elements = {
    results: document.querySelector('#product-detail-results'),
    status: document.querySelector('#product-detail-status'),
  };
  if (Object.values(elements).some((node) => !node)) return;

  const fixedSlug = nonEmptyText(document.body.dataset.productSlug);
  const productSlug = fixedSlug && PRODUCT_SLUG_PATTERN.test(fixedSlug)
    ? fixedSlug
    : productSlugFromSearch(window.location.search);
  if (!productSlug) {
    renderMessage(elements, {
      title: '請先從商品目錄選擇商品。',
      copy: '此頁需要一個目前公開的商品連結，才能載入詳細內容。',
    });
    statusMessage(elements, '尚未選擇可展示的商品。');
    return;
  }

  async function load() {
    renderLoading(elements);
    try {
      const response = await fetch(`/api/v1/catalog/products/${encodeURIComponent(productSlug)}?locale=zh-TW`, {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404) {
        renderMessage(elements, {
          title: '此商品目前無法展示。',
          copy: '商品可能已下架、連結已過期，或尚未開放公開查看。',
        });
        statusMessage(elements, '此商品目前無法展示。');
        return;
      }
      if (!response.ok) throw new Error('PRODUCT_UNAVAILABLE');
      const body = await response.json();
      if (!body.product || typeof body.product !== 'object') throw new Error('INVALID_PRODUCT_RESPONSE');
      renderDetail(elements, productDetailView(body.product));
    } catch {
      const retry = renderMessage(elements, {
        title: '商品資料暫時無法載入。',
        copy: '請重新嘗試；若問題持續，也可以回商品目錄選擇其他公開商品。',
        retry: true,
      });
      retry?.addEventListener('click', () => void load());
      statusMessage(elements, '商品資料暫時無法載入，請重試。');
    }
  }

  void load();
}

if (typeof document !== 'undefined') loadPage();
