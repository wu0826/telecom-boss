import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminNotificationError } from './notification-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminNotificationError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

async function notificationHandler({ response, configuration, requestId, url, authContext }) {
  try {
    const data = await configuration.adminNotificationService.list(authContext.permissions, url.searchParams);
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

export function registerAdminNotificationRoutes(router) {
  router.register({
    method: 'GET',
    path: '/api/v1/admin/notifications',
    authentication: 'required',
    permission: 'session.read',
    handler: notificationHandler,
  });
}
