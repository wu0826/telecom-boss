import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminReportError } from './report-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminReportError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

async function operationalHandler({ response, configuration, requestId, url, authContext }) {
  try {
    const data = await configuration.adminReportService.operational(authContext.permissions, url.searchParams);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

export function registerAdminReportRoutes(router) {
  router.register({
    method: 'GET',
    path: '/api/v1/admin/reports/operational',
    authentication: 'required',
    permission: 'session.read',
    handler: operationalHandler,
  });
}
