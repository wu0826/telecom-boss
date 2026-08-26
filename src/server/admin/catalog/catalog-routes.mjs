import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminPlanError } from './plan-service.mjs';
import { AdminPriceError } from './price-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminPlanError) && !(error instanceof AdminPriceError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

async function priceListHandler({ response, configuration, requestId, params }) {
  try {
    const data = await configuration.adminPriceService.list(params.planId);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

function priceWriteHandler(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminPriceService,
        params,
        requestBody,
        authContext.user,
        auditContext(request, requestId),
      );
      sendJson(response, status, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
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
    const result = await configuration.adminPlanService.list(url.searchParams);
    sendJson(response, 200, {
      data: result.data,
      meta: { page: result.page, pageSize: result.pageSize, total: result.total, requestId },
    }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

function readHandler(action) {
  return async ({ response, configuration, requestId, params }) => {
    try {
      const data = await action(configuration.adminPlanService, params);
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

function writeHandler(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminPlanService,
        params,
        requestBody,
        authContext.user,
        auditContext(request, requestId),
      );
      sendJson(response, status, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

export function registerAdminCatalogRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog/plans', authentication: 'required',
    permission: 'catalog.manage', handler: listHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog/plans/:id', authentication: 'required',
    permission: 'catalog.manage', handler: readHandler((service, params) => service.detail(params.id)),
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog/plans/:id/preview', authentication: 'required',
    permission: 'catalog.manage', handler: readHandler((service, params) => service.preview(params.id)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog/plans', authentication: 'required',
    permission: 'catalog.manage',
    handler: writeHandler((service, params, body, actor, audit) => service.create(body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog/plans/:id', authentication: 'required',
    permission: 'catalog.manage',
    handler: writeHandler((service, params, body, actor, audit) => service.update(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog/plans/:id/publish', authentication: 'required',
    permission: 'catalog.manage',
    handler: writeHandler((service, params, body, actor, audit) => service.setPublication(
      params.id, body, true, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog/plans/:id/unpublish', authentication: 'required',
    permission: 'catalog.manage',
    handler: writeHandler((service, params, body, actor, audit) => service.setPublication(
      params.id, body, false, actor, audit,
    )),
  });
  router.register({
    method: 'DELETE', path: '/api/v1/admin/catalog/plans/:id', authentication: 'required',
    permission: 'catalog.manage',
    handler: writeHandler((service, params, body, actor, audit) => service.delete(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog/plans/:planId/prices', authentication: 'required',
    permission: 'catalog.manage', handler: priceListHandler,
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog/plans/:planId/prices', authentication: 'required',
    permission: 'catalog.manage',
    handler: priceWriteHandler((service, params, body, actor, audit) => service.create(
      params.planId, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog/plans/:planId/prices/:priceId',
    authentication: 'required', permission: 'catalog.manage',
    handler: priceWriteHandler((service, params, body, actor, audit) => service.update(
      params.planId, params.priceId, body, actor, audit,
    )),
  });
  router.register({
    method: 'DELETE', path: '/api/v1/admin/catalog/plans/:planId/prices/:priceId',
    authentication: 'required', permission: 'catalog.manage',
    handler: priceWriteHandler((service, params, body, actor, audit) => service.delete(
      params.planId, params.priceId, body, actor, audit,
    )),
  });
}
