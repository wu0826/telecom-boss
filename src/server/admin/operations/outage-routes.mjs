import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminOutageError } from './outage-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminOutageError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return { requestId, ipAddress: request.socket.remoteAddress ?? null, userAgent: request.headers['user-agent'] ?? null };
}

function writeHandler(action) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const service = configuration.adminOutageService;
      let data;
      if (action === 'create') data = await service.create(requestBody, authContext.user, auditContext(request, requestId));
      else if (['add', 'remove'].includes(action)) data = await service.membership(params.id, action, requestBody, authContext.user, auditContext(request, requestId));
      else data = await service.transition(params.id, action, requestBody, authContext.user, auditContext(request, requestId));
      sendJson(response, action === 'create' ? 201 : 200, { data, meta: { requestId } }, { requestId });
    } catch (error) { throw httpError(error); }
  };
}

export function registerAdminOutageRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/outages', authentication: 'required', permission: 'operations.manage',
    async handler({ response, configuration, requestId, url }) {
      try { sendJson(response, 200, { data: await configuration.adminOutageService.list(url.searchParams), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/outages/:id', authentication: 'required', permission: 'operations.manage',
    async handler({ response, configuration, requestId, params }) {
      try { sendJson(response, 200, { data: await configuration.adminOutageService.detail(params.id), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  router.register({ method: 'POST', path: '/api/v1/admin/outages', authentication: 'required', permission: 'operations.manage', handler: writeHandler('create') });
  router.register({ method: 'POST', path: '/api/v1/admin/outages/:id/subscriptions', authentication: 'required', permission: 'operations.manage', handler: writeHandler('add') });
  router.register({ method: 'DELETE', path: '/api/v1/admin/outages/:id/subscriptions/:subscriptionId', authentication: 'required', permission: 'operations.manage', async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
    try {
      const data = await configuration.adminOutageService.membership(params.id, 'remove', { ...requestBody, subscriptionId: Number(params.subscriptionId) }, authContext.user, auditContext(request, requestId));
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) { throw httpError(error); }
  } });
  for (const [pathAction, action] of [['identify', 'identify'], ['monitor', 'monitor'], ['resolve', 'resolve']]) {
    router.register({ method: 'POST', path: `/api/v1/admin/outages/:id/${pathAction}`, authentication: 'required', permission: 'operations.manage', handler: writeHandler(action) });
  }
}
