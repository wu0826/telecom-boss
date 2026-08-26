import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminWorkOrderError } from './work-order-service.mjs';

function asHttpError(error) {
  if (!(error instanceof AdminWorkOrderError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId,
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function listHandler({ response, configuration, requestId, url }) {
  try {
    const data = await configuration.adminWorkOrderService.list(url.searchParams);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw asHttpError(error);
  }
}

async function detailHandler({ response, configuration, requestId, params }) {
  try {
    const data = await configuration.adminWorkOrderService.detail(params.id);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw asHttpError(error);
  }
}

function writeHandler(action = null, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const service = configuration.adminWorkOrderService;
      const data = action === null
        ? await service.create(requestBody, authContext.user, auditContext(request, requestId))
        : await service.transition(
          params.id, action, requestBody, authContext.user, auditContext(request, requestId),
        );
      sendJson(response, status, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw asHttpError(error);
    }
  };
}

export function registerAdminWorkOrderRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/work-orders', authentication: 'required',
    permission: 'operations.manage', handler: listHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/work-orders/:id', authentication: 'required',
    permission: 'operations.manage', handler: detailHandler,
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/work-orders', authentication: 'required',
    permission: 'operations.manage', handler: writeHandler(null, 201),
  });
  for (const action of ['assign', 'schedule', 'start', 'complete', 'cancel']) {
    router.register({
      method: 'POST', path: `/api/v1/admin/work-orders/:id/${action}`,
      authentication: 'required', permission: 'operations.manage', handler: writeHandler(action),
    });
  }
}
