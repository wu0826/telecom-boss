import { getPublicCatalog, getPublicPlan } from '../services/catalog-service.mjs';
import { getHealth } from '../services/health-service.mjs';
import { createPublicInquiry, InquiryServiceError } from '../services/inquiry-service.mjs';
import { getPublicCatalogProduct, getPublicCatalogProducts } from '../services/product-catalog-service.mjs';
import { HttpError, sendJson } from './responses.mjs';

const LOCALE_PATTERN = /^[A-Za-z0-9-]{2,10}$/;
const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function singleQueryValue(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : values.length === 0 ? null : undefined;
}

function productLocale(url) {
  const selectedLocale = singleQueryValue(url, 'locale');
  const locale = selectedLocale === null ? 'zh-TW' : selectedLocale;
  if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)) {
    throw new HttpError(422, 'INVALID_LOCALE', '語系代碼格式不正確');
  }
  return locale;
}

function productCategory(url) {
  const category = singleQueryValue(url, 'category');
  if (category === null) return null;
  if (typeof category !== 'string' || !CATEGORY_SLUG_PATTERN.test(category)) {
    throw new HttpError(422, 'INVALID_CATEGORY', '分類網址代稱格式不正確');
  }
  return category;
}

function inquiryHttpError(error) {
  if (!(error instanceof InquiryServiceError)) return error;
  const status = error.code === 'IDEMPOTENCY_CONFLICT'
    ? 409
    : error.code === 'INVALID_IDEMPOTENCY_KEY'
      ? 400
      : 422;
  return new HttpError(status, error.code, error.message, { details: error.details });
}

async function healthHandler({ response, configuration, requestId }) {
  const health = await getHealth(configuration);
  if (!health.healthy) {
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', '資料庫健康檢查失敗');
  }
  sendJson(response, 200, health.response, { requestId });
}

async function catalogHandler({ response, configuration, requestId }) {
  sendJson(response, 200, await getPublicCatalog(configuration.telecomDatabasePath, { clock: configuration.catalogClock }), { requestId });
}

async function productListHandler({ response, configuration, requestId, url }) {
  const locale = productLocale(url);
  const category = productCategory(url);
  sendJson(response, 200, await getPublicCatalogProducts(configuration.telecomDatabasePath, {
    locale,
    category,
    clock: configuration.catalogClock,
  }), { requestId });
}

async function productDetailHandler({ response, configuration, requestId, params, url }) {
  const locale = productLocale(url);
  if (!CATEGORY_SLUG_PATTERN.test(params.slug)) {
    throw new HttpError(404, 'PRODUCT_NOT_FOUND', '找不到可用的商品');
  }
  const product = await getPublicCatalogProduct(configuration.telecomDatabasePath, params.slug, {
    locale,
    clock: configuration.catalogClock,
  });
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', '找不到可用的商品');
  sendJson(response, 200, { product }, { requestId });
}

async function contentHandler({ response, configuration, requestId }) {
  sendJson(response, 200, await configuration.adminContentService.publicContent(), { requestId });
}

async function planHandler({ response, configuration, requestId, params }) {
  if (!/^[1-9]\d*$/.test(params.id)) {
    throw new HttpError(404, 'PLAN_NOT_FOUND', '找不到可用的網路方案');
  }
  const planId = Number(params.id);
  if (!Number.isSafeInteger(planId)) {
    throw new HttpError(404, 'PLAN_NOT_FOUND', '找不到可用的網路方案');
  }
  const plan = await getPublicPlan(configuration.telecomDatabasePath, planId, { clock: configuration.catalogClock });
  if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '找不到可用的網路方案');
  sendJson(response, 200, { plan }, { requestId });
}

async function inquiryHandler({ request, response, configuration, requestId, requestBody }) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'CROSS_SITE_REQUEST', '不接受跨網站申裝請求');
  }
  const idempotencyKey = request.headers['idempotency-key'];
  if (!idempotencyKey) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key 標頭');
  }
  const retryAfter = configuration.inquiryRateLimiter.take(
    request.socket.remoteAddress ?? 'unknown',
  );
  if (retryAfter !== null) {
    throw new HttpError(429, 'RATE_LIMITED', '申裝送件次數過多，請稍後再試', {
      headers: { 'Retry-After': String(retryAfter) },
    });
  }

  let result;
  try {
    result = await createPublicInquiry({
      telecomDatabasePath: configuration.telecomDatabasePath,
      payload: requestBody,
      idempotencyKey,
    });
  } catch (error) {
    throw inquiryHttpError(error);
  }
  sendJson(response, result.duplicate ? 200 : 201, result, { requestId });
}

export function registerPublicRoutes(router) {
  router.register({ method: 'GET', path: '/api/v1/health', handler: healthHandler });
  router.register({ method: 'GET', path: '/api/v1/catalog', handler: catalogHandler });
  router.register({ method: 'GET', path: '/api/v1/catalog/products', handler: productListHandler });
  router.register({ method: 'GET', path: '/api/v1/catalog/products/:slug', handler: productDetailHandler });
  router.register({ method: 'GET', path: '/api/v1/content', handler: contentHandler });
  router.register({ method: 'GET', path: '/api/v1/catalog/plans/:id', handler: planHandler });
  router.register({ method: 'POST', path: '/api/v1/inquiries', handler: inquiryHandler });
}
