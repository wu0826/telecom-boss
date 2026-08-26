import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminSubscriptionError } from './subscription-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminSubscriptionError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId, ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function readHandler(detail = false) {
  return async ({ response, configuration, requestId, url, params }) => {
    try {
      const data = detail
        ? await configuration.adminSubscriptionService.detail(params.id)
        : await configuration.adminSubscriptionService.list(url.searchParams);
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

function writeHandler(action) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const service = configuration.adminSubscriptionService;
      const data = action === 'account'
        ? await service.saveAccount(params.id, requestBody, authContext.user, auditContext(request, requestId))
        : await service.transition(
          params.id, action, requestBody, authContext.user, auditContext(request, requestId),
        );
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

export function registerAdminSubscriptionRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/subscriptions', authentication: 'required',
    permission: 'order.manage', handler: readHandler(),
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/subscriptions/:id', authentication: 'required',
    permission: 'order.manage', handler: readHandler(true),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/subscriptions/:id/account', authentication: 'required',
    permission: 'order.manage', handler: writeHandler('account'),
  });
  for (const action of ['activate', 'suspend', 'resume', 'terminate', 'expire']) {
    router.register({
      method: 'POST', path: `/api/v1/admin/subscriptions/:id/${action}`,
      authentication: 'required', permission: 'order.manage', handler: writeHandler(action),
    });
  }
}
