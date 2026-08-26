import { timingSafeEqual } from 'node:crypto';

import { HttpError } from '../../http/responses.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

function tokensEqual(actual, expected) {
  if (!TOKEN_PATTERN.test(actual ?? '') || !TOKEN_PATTERN.test(expected ?? '')) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function enforceCsrf(request, expectedToken) {
  if (!MUTATING_METHODS.has(request.method)) return;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'CROSS_SITE_REQUEST', '不接受跨網站後台請求');
  }
  if (!tokensEqual(request.headers['x-csrf-token'], expectedToken)) {
    throw new HttpError(403, 'CSRF_FAILED', '後台請求驗證失敗');
  }
}
