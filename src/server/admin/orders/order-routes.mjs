import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminOrderError } from './order-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminOrderError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId,
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function listHandler({ response, configuration, requestId }) {
  const data = await configuration.adminOrderService.list();
  sendJson(response, 200, { data, meta: { requestId } }, { requestId });
}

async function detailHandler({ response, configuration, requestId, params }) {
  try {
    const data = await configuration.adminOrderService.detail(params.id);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function createHandler({
  request, response, configuration, requestId, requestBody, authContext,
}) {
  try {
    const result = await configuration.adminOrderService.create(
      requestBody,
      request.headers['idempotency-key'],
      authContext.user,
      auditContext(request, requestId),
    );
    sendJson(response, result.replayed ? 200 : 201, {
      data: result.data,
      meta: { requestId, replayed: result.replayed },
    }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

function transitionHandler(action) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await configuration.adminOrderService.transition(
        params.id,
        action,
        requestBody,
        authContext.user,
        auditContext(request, requestId),
      );
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

export function registerAdminOrderRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/orders', authentication: 'required',
    permission: 'order.manage', handler: listHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/orders/:id', authentication: 'required',
    permission: 'order.manage', handler: detailHandler,
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/orders', authentication: 'required',
    permission: 'order.manage', handler: createHandler,
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/orders/:id/submit', authentication: 'required',
    permission: 'order.manage', handler: transitionHandler('submit'),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/orders/:id/approve', authentication: 'required',
    permission: 'operations.manage', handler: transitionHandler('approve'),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/orders/:id/cancel', authentication: 'required',
    permission: 'order.manage', handler: transitionHandler('cancel'),
  });
}
