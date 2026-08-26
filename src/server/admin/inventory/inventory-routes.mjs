import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminInventoryError } from './inventory-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminInventoryError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return { requestId, ipAddress: request.socket.remoteAddress ?? null, userAgent: request.headers['user-agent'] ?? null };
}

function writeHandler(action) {
  return async ({ request, response, configuration, requestId, requestBody, authContext }) => {
    try {
      const service = configuration.adminInventoryService;
      const data = action === 'warehouse'
        ? await service.createWarehouse(requestBody, authContext.user, auditContext(request, requestId))
        : action === 'item'
          ? await service.createItem(requestBody, authContext.user, auditContext(request, requestId))
          : await service.move(requestBody, authContext.user, auditContext(request, requestId));
      sendJson(response, 201, { data, meta: { requestId } }, { requestId });
    } catch (error) { throw httpError(error); }
  };
}

export function registerAdminInventoryRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/inventory', authentication: 'required', permission: 'inventory.manage',
    async handler({ response, configuration, requestId }) {
      try { sendJson(response, 200, { data: await configuration.adminInventoryService.view(), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  router.register({ method: 'POST', path: '/api/v1/admin/inventory/warehouses', authentication: 'required', permission: 'inventory.manage', handler: writeHandler('warehouse') });
  router.register({ method: 'POST', path: '/api/v1/admin/inventory/items', authentication: 'required', permission: 'inventory.manage', handler: writeHandler('item') });
  router.register({ method: 'POST', path: '/api/v1/admin/inventory/movements', authentication: 'required', permission: 'inventory.manage', handler: writeHandler('movement') });
}
