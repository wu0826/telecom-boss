import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminPaymentError } from './payment-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminPaymentError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function auditContext(request, requestId) {
  return { requestId, ipAddress: request.socket.remoteAddress ?? null, userAgent: request.headers['user-agent'] ?? null };
}

export function registerAdminPaymentRoutes(router) {
  router.register({
    method: 'GET', path: '/api/v1/admin/billing/invoices/:id/activity',
    authentication: 'required', permission: 'billing.manage',
    async handler({ response, configuration, requestId, params }) {
      try { sendJson(response, 200, { data: await configuration.adminPaymentService.activity(params.id), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/payments', authentication: 'required', permission: 'billing.manage',
    async handler({ request, response, configuration, requestId, requestBody, authContext }) {
      try {
        const data = await configuration.adminPaymentService.postPayment(requestBody, authContext.user, auditContext(request, requestId));
        sendJson(response, 201, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'POST', path: '/api/v1/admin/billing-adjustments', authentication: 'required', permission: 'billing.manage',
    async handler({ request, response, configuration, requestId, requestBody, authContext }) {
      try {
        const data = await configuration.adminPaymentService.requestAdjustment(requestBody, authContext.user, auditContext(request, requestId));
        sendJson(response, 201, { data, meta: { requestId } }, { requestId });
      } catch (error) { throw httpError(error); }
    },
  });
  router.register({
    method: 'GET', path: '/api/v1/admin/billing-adjustments', authentication: 'required', permission: 'access.manage',
    async handler({ response, configuration, requestId, url }) {
      try { sendJson(response, 200, { data: await configuration.adminPaymentService.listRequests(url.searchParams), meta: { requestId } }, { requestId }); }
      catch (error) { throw httpError(error); }
    },
  });
  for (const action of ['approve', 'reject']) {
    router.register({
      method: 'POST', path: `/api/v1/admin/billing-adjustments/:id/${action}`,
      authentication: 'required', permission: 'access.manage',
      async handler({ request, response, configuration, requestId, requestBody, params, authContext }) {
        try {
          const data = await configuration.adminPaymentService.decide(
            params.id, action, requestBody, authContext.user, auditContext(request, requestId),
          );
          sendJson(response, 200, { data, meta: { requestId } }, { requestId });
        } catch (error) { throw httpError(error); }
      },
    });
  }
}
