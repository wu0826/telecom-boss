const page = document.body;

function element(tagName, { className, text } = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link({ href, text, className } = {}) {
  const node = element('a', { className, text });
  node.href = href;
  return node;
}

function quoteHref(intent, product) {
  const url = new URL('/', window.location.origin);
  const query = new URLSearchParams();
  if (intent) query.set('intent', intent);
  if (product) query.set('product', product);
  url.search = query.toString();
  url.hash = 'apply';
  return `${url.pathname}${url.search}${url.hash}`;
}

function renderBrand() {
  const brand = link({ href: '/', className: 'showcase-brand' });
  brand.setAttribute('aria-label', '比奇堡電信首頁');
  const logo = element('img', { className: 'showcase-brand__logo' });
  logo.src = '/assets/images/Bikini-bottom-telecom-logo.png';
  logo.alt = '';
  logo.width = 2172;
  logo.height = 724;
  brand.append(logo);
  return brand;
}

function renderHeader() {
  const target = document.querySelector('#site-header');
  if (!target) return;
  const container = element('div', { className: 'showcase-container showcase-header__inner' });
  const navigation = element('nav', { className: 'showcase-navigation' });
  navigation.setAttribute('aria-label', '主要導覽');
  navigation.append(
    link({ href: '/#plans', text: '網路方案' }),
    link({ href: '/services/fiber-broadband.html', text: '服務方案' }),
    link({ href: '/products/catalog.html', text: '商品目錄' }),
    link({ href: quoteHref('quote'), text: '立即諮詢', className: 'showcase-navigation__cta' }),
  );
  container.append(renderBrand(), navigation);
  target.replaceChildren(container);
}

function renderBreadcrumb() {
  const target = document.querySelector('#showcase-breadcrumb');
  if (!target) return;
  const entries = String(page.dataset.breadcrumb ?? '').split('|').filter(Boolean);
  const list = element('ol');
  const home = element('li');
  home.append(link({ href: '/', text: '首頁' }));
  list.append(home);
  for (const [index, entry] of entries.entries()) {
    const item = element('li', { text: entry });
    if (index === entries.length - 1) item.setAttribute('aria-current', 'page');
    list.append(item);
  }
  target.replaceChildren(list);
}

function renderFooter() {
  const target = document.querySelector('#site-footer');
  if (!target) return;
  const container = element('div', { className: 'showcase-container showcase-footer__inner' });
  const label = element('p', { text: '從需求到交付，讓每一條連線都有清楚的下一步。' });
  const links = element('nav');
  links.setAttribute('aria-label', '頁尾導覽');
  links.append(
    link({ href: '/services/fiber-broadband.html', text: '服務介紹' }),
    link({ href: '/products/catalog.html', text: '商品目錄' }),
    link({ href: quoteHref('quote'), text: '送出需求' }),
  );
  const notice = element('small', { text: '本頁為服務內容展示；實際涵蓋、施工與報價以專人確認為準。' });
  container.append(label, links, notice);
  target.replaceChildren(container);
}

function hydrateQuoteLinks() {
  for (const anchor of document.querySelectorAll('[data-quote-link]')) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    anchor.href = quoteHref(anchor.dataset.quoteIntent, anchor.dataset.product);
  }
}

renderHeader();
renderBreadcrumb();
renderFooter();
hydrateQuoteLinks();
