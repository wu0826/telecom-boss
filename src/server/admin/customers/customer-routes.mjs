import { HttpError, sendJson, sendText } from '../../http/responses.mjs';
import { AdminCustomerError } from './customer-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminCustomerError)) return error;
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
    const result = await configuration.adminCustomerService.list(url.searchParams);
    sendJson(response, 200, {
      data: result.data,
      meta: { page: result.page, pageSize: result.pageSize, total: result.total, requestId },
    }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function detailHandler({ response, configuration, requestId, params }) {
  try {
    const data = await configuration.adminCustomerService.detail(params.id);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function sensitiveHandler({ request, response, configuration, requestId, params, authContext }) {
  try {
    const data = await configuration.adminCustomerService.detail(params.id, { revealSensitive: true });
    await configuration.auditService.record({
      actorStaffUserId: authContext.user.id,
      action: 'CUSTOMER_SENSITIVE_VIEWED',
      entityType: 'CUSTOMER',
      entityId: String(data.id),
      ...auditContext(request, requestId),
    });
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function serviceAreasHandler({ response, configuration, requestId }) {
  const data = await configuration.adminCustomerService.serviceAreas();
  sendJson(response, 200, { data, meta: { requestId } }, { requestId });
}

async function exportHandler({ request, response, configuration, requestId, url, authContext }) {
  try {
    const result = await configuration.adminCustomerService.exportCsv(
      url.searchParams,
      authContext.user,
      authContext.permissions,
      auditContext(request, requestId),
    );
    sendText(response, 200, result.csv, {
      requestId,
      contentType: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': 'attachment; filename="customers-export.csv"' },
    });
  } catch (error) {
    throw httpError(error);
  }
}

function writeHandler(action, status = 200) {
  return async ({ request, response, configuration, requestId, requestBody, params, authContext }) => {
    try {
      const data = await action(
        configuration.adminCustomerService,
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

export function registerAdminCustomerRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/customers', authentication: 'required',
    permission: 'customer.read', handler: listHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/customers/service-areas', authentication: 'required',
    permission: 'customer.read', handler: serviceAreasHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/customers/export.csv', authentication: 'required',
    permission: 'customer.read', handler: exportHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/customers/:id', authentication: 'required',
    permission: 'customer.read', handler: detailHandler,
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/customers/:id/sensitive', authentication: 'required',
    permission: 'customer.sensitive.read', handler: sensitiveHandler,
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/customers', authentication: 'required',
    permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.create(body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/customers/:id', authentication: 'required',
    permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.update(params.id, body, actor, audit)),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/customers/:id/contacts', authentication: 'required',
    permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.createContact(params.id, body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/customers/:customerId/contacts/:contactId',
    authentication: 'required', permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.updateContact(
      params.customerId, params.contactId, body, actor, audit,
    )),
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/customers/:id/locations', authentication: 'required',
    permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.createLocation(params.id, body, actor, audit), 201),
  });
  router.register({
    method: 'PATCH', path: '/api/v1/admin/customers/:customerId/locations/:locationId',
    authentication: 'required', permission: 'customer.write',
    handler: writeHandler((service, params, body, actor, audit) => service.updateLocation(
      params.customerId, params.locationId, body, actor, audit,
    )),
  });
}
