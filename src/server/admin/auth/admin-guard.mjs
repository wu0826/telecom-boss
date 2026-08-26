import { HttpError } from '../../http/responses.mjs';
import { AuthServiceError, readSessionToken } from './auth-service.mjs';
import { enforceCsrf } from './csrf.mjs';

const INTRINSIC_SESSION_PERMISSIONS = new Set(['session.logout', 'session.read']);

function authHttpError(error) {
  if (!(error instanceof AuthServiceError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

function requestAuditFields(request) {
  return {
    ipAddress: request.socket.remoteAddress ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export function createAdminGuard({ authService, auditService }) {
  return {
    async authorize(request, route, requestId) {
      if (route.authentication !== 'required') return null;
      const token = readSessionToken(request);
      let access;
      try {
        access = await authService.authenticate(token);
      } catch (error) {
        await auditService.record({
          action: 'ADMIN_AUTHENTICATION_FAILED',
          entityType: 'SESSION',
          requestId,
          ...requestAuditFields(request),
        });
        throw authHttpError(error);
      }
      if (
        !INTRINSIC_SESSION_PERMISSIONS.has(route.permission)
        && !access.permissions.includes(route.permission)
      ) {
        await auditService.record({
          actorStaffUserId: access.user.id,
          action: 'ADMIN_PERMISSION_DENIED',
          entityType: 'ROUTE',
          entityId: `${request.method} ${route.path}`,
          requestId,
          ...requestAuditFields(request),
        });
        throw new HttpError(403, 'PERMISSION_DENIED', '沒有執行此操作的權限');
      }
      try {
        enforceCsrf(request, access.csrfToken);
      } catch (error) {
        await auditService.record({
          actorStaffUserId: access.user.id,
          action: 'ADMIN_CSRF_DENIED',
          entityType: 'ROUTE',
          entityId: `${request.method} ${route.path}`,
          requestId,
          ...requestAuditFields(request),
        });
        throw error;
      }
      return { token, ...access };
    },
  };
}
