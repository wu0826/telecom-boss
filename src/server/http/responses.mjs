const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ');

export class HttpError extends Error {
  constructor(status, code, message, { details = [], headers = {} } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function applySecurityHeaders(response, requestId) {
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Request-Id', requestId);
}

export function sendJson(response, status, payload, { requestId, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  sendText(response, status, body, {
    requestId,
    headers,
    contentType: 'application/json; charset=utf-8',
  });
}

export function sendText(response, status, body, {
  requestId,
  headers = {},
  contentType = 'text/plain; charset=utf-8',
} = {}) {
  if (typeof body !== 'string') throw new TypeError('Response body must be a string');
  applySecurityHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', Buffer.byteLength(body));
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

export function sendError(response, error, requestId) {
  const safeError = error instanceof HttpError
    ? error
    : new HttpError(500, 'INTERNAL_ERROR', '伺服器發生未預期錯誤');
  sendJson(response, safeError.status, {
    error: {
      code: safeError.code,
      message: safeError.message,
      details: safeError.details,
    },
  }, { requestId, headers: safeError.headers });
}
