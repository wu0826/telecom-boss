import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminInvoiceError } from './invoice-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminInvoiceError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return {
    requestId,
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export function registerAdminInvoiceRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/invoices', authentication: 'required', permission: 'billing.manage',
    async handler({ response, configuration, requestId, url }) {
      try {
        sendJson(response, 200, {
          data: await configuration.adminInvoiceService.list(url.searchParams), meta: { requestId },
        }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/invoices/:id', authentication: 'required', permission: 'billing.manage',
    async handler({ response, configuration, requestId, params }) {
      try {
        sendJson(response, 200, {
          data: await configuration.adminInvoiceService.detail(params.id), meta: { requestId },
        }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/invoices', authentication: 'required', permission: 'billing.manage',
    async handler({ request, response, configuration, requestId, requestBody, authContext }) {
      try {
        const data = await configuration.adminInvoiceService.generate(
          requestBody, authContext.user, auditContext(request, requestId),
        );
        sendJson(response, 201, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/invoices/batch', authentication: 'required', permission: 'billing.manage',
    async handler({ request, response, configuration, requestId, requestBody, authContext }) {
      try {
        const data = await configuration.adminInvoiceService.batch(
          requestBody, authContext.user, auditContext(request, requestId),
        );
        sendJson(response, 200, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  for (const action of ['issue', 'overdue', 'void']) {
    router.register({
      method: 'POST', path: `/api/v1/admin/invoices/:id/${action}`,
      authentication: 'required', permission: 'billing.manage',
      async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
        try {
          const data = await configuration.adminInvoiceService.transition(
            params.id, action, requestBody, authContext.user, auditContext(request, requestId),
          );
          sendJson(response, 200, { data, meta: { requestId } }, { requestId });
        } catch (error) { throw httpError(error); }
      },
    });
  }
}
