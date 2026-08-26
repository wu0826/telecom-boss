import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminProductContentError } from './content-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminProductContentError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId,
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function read(action) {
  return async ({ response, configuration, requestId, params }) => {
    try {
      const data = await action(configuration.adminProductContentService, params);
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

function write(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminProductContentService,
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

export function registerAdminProductContentRoutes(router) {
  const permission = 'catalog.manage';
  const authentication = 'required';

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/products/:productId/content/:locale', authentication, permission,
    handler: read((service, params) => service.contentDetail(params.productId, params.locale)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:productId/content', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createContent(
      params.productId, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:productId/content/:locale', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateContent(
      params.productId, params.locale, body, actor, audit,
    )),
  });

  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:productId/content/:locale/sections', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createSection(
      params.productId, params.locale, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:productId/sections/:sectionId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateSection(
      params.productId, params.sectionId, body, actor, audit,
    )),
  });

  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:productId/content/:locale/specs', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createSpec(
      params.productId, params.locale, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:productId/specs/:specId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateSpec(
      params.productId, params.specId, body, actor, audit,
    )),
  });

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/products/:productId/media', authentication, permission,
    handler: read((service, params) => service.listMedia(params.productId)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:productId/media', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createMedia(
      params.productId, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:productId/media/:mediaId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateMedia(
      params.productId, params.mediaId, body, actor, audit,
    )),
  });
  router.register({
    method: 'DELETE', path: '/api/v1/admin/catalog-v2/products/:productId/media/:mediaId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.deleteMedia(
      params.productId, params.mediaId, body, actor, audit,
    )),
  });

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/brands', authentication, permission,
    handler: read((service) => service.listBrands()),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/brands', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createBrand(body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/brands/:brandId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateBrand(
      params.brandId, body, actor, audit,
    )),
  });

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/products/:productId/brands', authentication, permission,
    handler: read((service, params) => service.listProductBrands(params.productId)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:productId/brands', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.createProductBrand(
      params.productId, body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:productId/brands/:brandId', authentication, permission,
    handler: write((service, params, body, actor, audit) => service.updateProductBrand(
      params.productId, params.brandId, body, actor, audit,
    )),
  });
}
