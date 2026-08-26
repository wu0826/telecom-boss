import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminContentError } from './content-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminContentError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return { requestId, ipAddress: request.socket.remoteAddress ?? null, userAgent: request.headers['user-agent'] ?? null };
}

function read(action) {
  return async ({ response, configuration, requestId, params }) => {
    try { sendJson(response, 200, { data: await action(configuration.adminContentService, params), meta: { requestId } }, { requestId }); }
    catch (error) { throw httpError(error); }
  };
}

function write(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(configuration.adminContentService, params, requestBody, authContext.user, auditContext(request, requestId));
      sendJson(response, status, { data, meta: { requestId } }, { requestId });
    } catch (error) { throw httpError(error); }
  };
}

export function registerAdminContentRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/content', authentication: 'required', permission: 'content.manage',
    handler: read((service) => service.list()),
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/content/:type/:id/preview', authentication: 'required', permission: 'content.manage',
    handler: read((service, params) => service.detail(params.type, params.id)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/content/:type', authentication: 'required', permission: 'content.manage',
    handler: write((service, params, body, actor, audit) => service.create(params.type, body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/content/:type/:id', authentication: 'required', permission: 'content.manage',
    handler: write((service, params, body, actor, audit) => service.update(params.type, params.id, body, actor, audit)),
  });
  for (const [action, isPublished] of [['publish', true], ['unpublish', false]]) {
    router.register({
      method: 'POST', path: `/api/v1/admin/content/:type/:id/${action}`,
      authentication: 'required', permission: 'access.manage',
      handler: write((service, params, body, actor, audit) => service.setPublication(
        params.type, params.id, body, isPublished, actor, audit,
      )),
    });
  }
}
