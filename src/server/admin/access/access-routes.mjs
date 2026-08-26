import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminAccessError } from './access-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminAccessError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}
function auditContext(request, requestId) { return { requestId, ipAddress: request.socket.remoteAddress ?? null, userAgent: request.headers['user-agent'] ?? null }; }

export function registerAdminAccessRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/access', authentication: 'required', permission: 'access.manage',
    async handler({ response, configuration, requestId }) {
      try { sendJson(response, 200, { data: await configuration.adminAccessService.matrix(), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/access/staff', authentication: 'required', permission: 'role.manage',
    async handler({ request, response, configuration, requestId, requestBody, authContext }) {
      try {
        const data = await configuration.adminAccessService.createStaff(requestBody, authContext.user, auditContext(request, requestId));
        sendJson(response, 201, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/access/staff/:id', authentication: 'required', permission: 'access.manage',
    async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
      try {
        const data = await configuration.adminAccessService.updateStaff(params.id, requestBody, authContext.user, auditContext(request, requestId));
        sendJson(response, 200, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'DELETE', path: '/api/v1/admin/access/staff/:id', authentication: 'required', permission: 'role.manage',
    async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
      try {
        const data = await configuration.adminAccessService.deleteStaff(
          params.id, requestBody, authContext.user, auditContext(request, requestId),
        );
        sendJson(response, 200, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'PUT', path: '/api/v1/admin/access/staff/:id/roles', authentication: 'required', permission: 'role.manage',
    async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
      try {
        const data = await configuration.adminAccessService.replaceRoles(params.id, requestBody, authContext.user, auditContext(request, requestId));
        sendJson(response, 200, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/audit', authentication: 'required', permission: 'audit.read',
    async handler({ response, configuration, requestId, url }) {
      try {
        const result = await configuration.adminAccessService.auditList(url.searchParams);
        sendJson(response, 200, { data: result.data, meta: { requestId, total: result.total, page: result.page, pageSize: result.pageSize } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/audit/:id', authentication: 'required', permission: 'audit.read',
    async handler({ response, configuration, requestId, params }) {
      try { sendJson(response, 200, { data: await configuration.adminAccessService.auditDetail(params.id), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
}
