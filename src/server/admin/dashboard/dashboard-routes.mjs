import { sendJson } from '../../http/responses.mjs';

async function dashboardHandler({ response, configuration, requestId, authContext }) {
  const data = await configuration.dashboardService.getDashboard(authContext.permissions);
  sendJson(response, 200, { data, meta: { requestId } }, { requestId });
}

export function registerAdminDashboardRoutes(router) {
  router.register({
    method: 'GET',
    path: '/api/v1/admin/dashboard',
    authentication: 'required',
    permission: 'session.read',
    handler: dashboardHandler,
  });
}

