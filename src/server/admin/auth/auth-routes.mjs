import { isIP } from 'node:net';

import { HttpError, sendJson } from '../../http/responses.mjs';
import {
  AuthServiceError,
  readSessionToken,
} from './auth-service.mjs';

function authHttpError(error) {
  if (!(error instanceof AuthServiceError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function adminPayload(data, requestId) {
  return { data, meta: { requestId } };
}

function assertSameOrigin(request) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'CROSS_SITE_REQUEST', '不接受跨網站後台請求');
  }
}

function isLoopbackAddress(address) {
  if (!address) return false;
  if (address === '::1') return true;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

function clientIpAddress(request) {
  const remoteAddress = request.socket.remoteAddress ?? null;
  if (!isLoopbackAddress(remoteAddress)) return remoteAddress;

  const forwardedHeader = request.headers['x-forwarded-for'];
  const forwarded = Array.isArray(forwardedHeader)
    ? forwardedHeader.join(',')
    : forwardedHeader;
  if (typeof forwarded !== 'string') return remoteAddress;

  // Apache mod_proxy appends the directly connected client address to any existing
  // X-Forwarded-For chain. Trust the rightmost valid entry only when the immediate
  // peer is loopback, because the Node service is not exposed publicly.
  const addresses = forwarded
    .split(',')
    .map((value) => value.trim())
    .filter((value) => isIP(value) !== 0);
  return addresses.at(-1) ?? remoteAddress;
}

function auditRequest(request) {
  return {
    ipAddress: clientIpAddress(request),
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function developmentUsersHandler({ response, configuration, requestId }) {
  try {
    const users = await configuration.authService.listDevelopmentUsers();
    sendJson(response, 200, adminPayload({ users }, requestId), { requestId });
  } catch (error) {
    throw authHttpError(error);
  }
}

async function bootstrapHandler({ request, response, configuration, requestId }) {
  const token = readSessionToken(request);
  if (!token) {
    sendJson(response, 200, adminPayload({ authenticated: false, capabilities: configuration.authService.capabilities() }, requestId), { requestId });
    return;
  }
  try {
    const access = await configuration.authService.authenticate(token);
    sendJson(response, 200, adminPayload({
      authenticated: true,
      ...safeAccessContext({ token, ...access }),
    }, requestId), {
      requestId,
      headers: { 'Set-Cookie': await configuration.authService.sessionCookie(token) },
    });
  } catch (error) {
    if (!(error instanceof AuthServiceError)) throw error;
    sendJson(response, 200, adminPayload({
      authenticated: false,
      capabilities: configuration.authService.capabilities(),
    }, requestId), {
      requestId,
      headers: { 'Set-Cookie': configuration.authService.clearedSessionCookie() },
    });
  }
}


async function passwordLoginHandler({ request, response, configuration, requestId, requestBody }) {
  assertSameOrigin(request);
  const retryAfter = configuration.passwordLoginRateLimiter.take(
    clientIpAddress(request) ?? 'unknown',
  );
  if (retryAfter !== null) {
    throw new HttpError(429, 'RATE_LIMITED', '登入嘗試次數過多，請稍後再試', {
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
  try {
    const { identifier, password } = configuration.authService.validatePasswordLoginPayload(requestBody);
    const result = await configuration.authService.loginPasswordUser(
      identifier, password, readSessionToken(request),
    );
    await configuration.auditService.record({
      actorStaffUserId: result.user.id,
      action: 'ADMIN_LOGIN_SUCCEEDED',
      entityType: 'SESSION',
      entityId: String(result.user.id),
      requestId,
      ...auditRequest(request),
    });
    sendJson(response, 200, adminPayload({
      user: result.user,
      csrfToken: result.csrfToken,
    }, requestId), {
      requestId,
      headers: { 'Set-Cookie': await configuration.authService.sessionCookie(result.token) },
    });
  } catch (error) {
    await configuration.auditService.record({
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'SESSION',
      requestId,
      ...auditRequest(request),
    });
    throw authHttpError(error);
  }
}

async function developmentLoginHandler({ request, response, configuration, requestId, requestBody }) {
  assertSameOrigin(request);
  try {
    await configuration.authService.assertDevelopmentEnabled();
    const staffUserId = await configuration.authService.validateDevelopmentLoginPayload(requestBody);
    const retryAfter = configuration.developmentLoginRateLimiter.take(
      clientIpAddress(request) ?? 'unknown',
    );
    if (retryAfter !== null) {
      throw new HttpError(429, 'RATE_LIMITED', '登入嘗試次數過多，請稍後再試', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    }
    const result = await configuration.authService.loginDevelopmentUser(
      staffUserId,
      readSessionToken(request),
    );
    await configuration.auditService.record({
      actorStaffUserId: result.user.id,
      action: 'ADMIN_LOGIN_SUCCEEDED',
      entityType: 'SESSION',
      entityId: String(result.user.id),
      requestId,
      ...auditRequest(request),
    });
    sendJson(response, 200, adminPayload({
      user: result.user,
      csrfToken: result.csrfToken,
    }, requestId), {
      requestId,
      headers: { 'Set-Cookie': await configuration.authService.sessionCookie(result.token) },
    });
  } catch (error) {
    await configuration.auditService.record({
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'SESSION',
      requestId,
      ...auditRequest(request),
    });
    throw authHttpError(error);
  }
}

function safeAccessContext(authContext) {
  return {
    user: authContext.user,
    roles: authContext.roles,
    permissions: authContext.permissions,
    csrfToken: authContext.csrfToken,
    expiresAt: authContext.expiresAt,
  };
}

async function sessionHandler({ response, configuration, requestId, authContext }) {
  sendJson(response, 200, adminPayload(safeAccessContext(authContext), requestId), {
    requestId,
    headers: { 'Set-Cookie': await configuration.authService.sessionCookie(authContext.token) },
  });
}

async function accessContextHandler({ response, requestId, authContext }) {
  sendJson(response, 200, adminPayload(safeAccessContext(authContext), requestId), { requestId });
}

async function logoutHandler({ request, response, configuration, requestId, authContext }) {
  await configuration.authService.logout(authContext.token);
  await configuration.auditService.record({
    actorStaffUserId: authContext.user.id,
    action: 'ADMIN_LOGOUT_SUCCEEDED',
    entityType: 'SESSION',
    entityId: String(authContext.user.id),
    requestId,
    ...auditRequest(request),
  });
  sendJson(response, 200, adminPayload({ loggedOut: true }, requestId), {
    requestId,
    headers: { 'Set-Cookie': configuration.authService.clearedSessionCookie() },
  });
}

export function registerAdminAuthRoutes(router) {
  router.register({
    method: 'GET',
    path: '/api/v1/admin/auth/bootstrap',
    handler: bootstrapHandler,
  });
  router.register({
    method: 'GET',
    path: '/api/v1/admin/auth/development-users',
    handler: developmentUsersHandler,
  });
  router.register({
    method: 'POST',
    path: '/api/v1/admin/auth/login',
    handler: passwordLoginHandler,
  });
  router.register({
    method: 'POST',
    path: '/api/v1/admin/auth/development-login',
    handler: developmentLoginHandler,
  });
  router.register({
    method: 'GET',
    path: '/api/v1/admin/auth/session',
    authentication: 'required',
    permission: 'session.read',
    handler: sessionHandler,
  });
  router.register({
    method: 'GET',
    path: '/api/v1/admin/auth/access-context',
    authentication: 'required',
    permission: 'access.manage',
    handler: accessContextHandler,
  });
  router.register({
    method: 'POST',
    path: '/api/v1/admin/auth/logout',
    authentication: 'required',
    permission: 'session.logout',
    handler: logoutHandler,
  });
}
