const INTENT_COPY = new Map([
  ['coverage', '你正在確認可用涵蓋與方案。'],
  ['enterprise', '你想諮詢企業網路服務。'],
  ['quote', '你想進一步確認這項服務或商品。'],
  ['rental', '你想了解訂閱式設備租賃。'],
  ['site-survey', '你想安排現場需求評估。'],
]);
const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function singleSearchValue(searchParams, name) {
  const values = searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

export function inquiryContextFromSearch(search) {
  const searchParams = new URLSearchParams(search);
  const intent = singleSearchValue(searchParams, 'intent');
  const productSlug = singleSearchValue(searchParams, 'product');
  return {
    intent: intent && INTENT_COPY.has(intent) ? intent : null,
    productSlug: productSlug && PRODUCT_SLUG_PATTERN.test(productSlug) ? productSlug : null,
  };
}

export function inquiryContextCopy(intent) {
  return INTENT_COPY.get(intent) ?? '我們會依你的需求協助確認下一步。';
}
