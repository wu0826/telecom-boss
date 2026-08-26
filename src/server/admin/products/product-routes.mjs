import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminProductError } from './product-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminProductError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId,
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function categoryRead(action) {
  return async ({ response, configuration, requestId, params }) => {
    try {
      const data = await action(configuration.adminProductService, params);
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

function categoryWrite(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminProductService,
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

async function productList({ response, configuration, requestId, url }) {
  try {
    const result = await configuration.adminProductService.listProducts(url.searchParams);
    sendJson(response, 200, {
      data: result.data,
      meta: { page: result.page, pageSize: result.pageSize, total: result.total, requestId },
    }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

function productRead(action) {
  return async ({ response, configuration, requestId, params }) => {
    try {
      const data = await action(configuration.adminProductService, params);
      sendJson(response, 200, { data, meta: { requestId } }, { requestId });
    } catch (error) {
      throw httpError(error);
    }
  };
}

function productWrite(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminProductService,
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

export function registerAdminProductRoutes(router) {
  const permission = 'catalog.manage';
  const authentication = 'required';

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/categories', authentication, permission,
    handler: categoryRead((service) => service.listCategories()),
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/categories/:id', authentication, permission,
    handler: categoryRead((service, params) => service.categoryDetail(params.id)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/categories', authentication, permission,
    handler: categoryWrite((service, params, body, actor, audit) => service.createCategory(
      body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/categories/:id', authentication, permission,
    handler: categoryWrite((service, params, body, actor, audit) => service.updateCategory(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/categories/:id/move', authentication, permission,
    handler: categoryWrite((service, params, body, actor, audit) => service.moveCategory(
      params.id, body, actor, audit,
    )),
  });

  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/products', authentication, permission,
    handler: productList,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/catalog-v2/products/:id', authentication, permission,
    handler: productRead((service, params) => service.productDetail(params.id)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products', authentication, permission,
    handler: productWrite((service, params, body, actor, audit) => service.createProduct(
      body, actor, audit,
    ), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/catalog-v2/products/:id', authentication, permission,
    handler: productWrite((service, params, body, actor, audit) => service.updateProduct(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'DELETE', path: '/api/v1/admin/catalog-v2/products/:id', authentication, permission,
    handler: productWrite((service, params, body, actor, audit) => service.deleteProduct(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:id/publish', authentication, permission,
    handler: productWrite((service, params, body, actor, audit) => service.publishProduct(
      params.id, body, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/catalog-v2/products/:id/archive', authentication, permission,
    handler: productWrite((service, params, body, actor, audit) => service.archiveProduct(
      params.id, body, actor, audit,
    )),
  });
}
