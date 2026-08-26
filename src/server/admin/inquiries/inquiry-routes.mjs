import { HttpError, sendJson } from '../../http/responses.mjs';
import { AdminInquiryError } from './inquiry-service.mjs';
import { InquiryConversionError } from './inquiry-conversion-service.mjs';

function httpError(error) {
  if (!(error instanceof AdminInquiryError) && !(error instanceof InquiryConversionError)) return error;
  return new HttpError(error.status, error.code, error.message, { details: error.details });
}

async function conversionHandler({ request, response, configuration, requestId, requestBody, params, authContext }) {
  try {
    const data = await configuration.inquiryConversionService.convert(
      params.id,
      requestBody,
      authContext.user,
      {
        requestId,
        ipAddress: request.socket.remoteAddress ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    sendJson(response, 201, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function listHandler({ response, configuration, requestId, url }) {
  try {
    const result = await configuration.adminInquiryService.list(url.searchParams);
    sendJson(response, 200, {
      data: result.data,
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        requestId,
      },
    }, { requestId });
  } catch (error) {
    console.error('[admin-inquiries:list]',{
      requestId,
      query:url.search,
      name: error?.name,
      message:error?.message,
      code:error?.code,
      errno:error?.errno,
      sqlState:error?.sqlMessage,
      sql:error?.sql,
      stack:error?.stack,
     });
    throw httpError(error);
  }
}

async function assigneesHandler({ response, configuration, requestId }) {
  const data = await configuration.adminInquiryService.assignees();
  sendJson(response, 200, { data, meta: { requestId } }, { requestId });
}

async function detailHandler({ request, response, configuration, requestId, params, authContext }) {
  try {
    const data = await configuration.adminInquiryService.detail(Number(params.id), authContext.permissions);
    if (authContext.permissions.includes('customer.write')) {
      await configuration.auditService.record({
        actorStaffUserId: authContext.user.id,
        action: 'INQUIRY_CONTACT_VIEWED',
        entityType: 'SERVICE_INQUIRY',
        entityId: String(data.id),
        requestId,
        ipAddress: request.socket.remoteAddress ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    throw httpError(error);
  }
}

async function updateHandler({ request, response, configuration, requestId, requestBody, params, authContext }) {
  try {
    const data = await configuration.adminInquiryService.update(
      Number(params.id),
      requestBody,
      authContext.user,
      {
        requestId,
        ipAddress: request.socket.remoteAddress ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    sendJson(response, 200, { data, meta: { requestId } }, { requestId });
  } catch (error) {
    console.error('[admin-inquiries:update]', {
      requestId,
      inquiryId: params.id,
      body: requestBody,
      name: error?.name,
      message: error?.message,
      code: error?.code,
      errno: error?.errno,
      sqlState: error?.sqlState,
      sqlMessage: error?.sqlMessage,
      sql: error?.sql,
      stack: error?.stack,
    });

    throw httpError(error);
  }
}

export function registerAdminInquiryRoutes(router) {
  router.register({
    method: 'GET',
    path: '/api/v1/admin/inquiries',
    authentication: 'required',
    permission: 'customer.read',
    handler: listHandler,
  });
  router.register({
    method: 'GET',
    path: '/api/v1/admin/inquiries/assignees',
    authentication: 'required',
    permission: 'customer.write',
    handler: assigneesHandler,
  });
  router.register({
    method: 'GET',
      path: '/api/v1/admin/inquiries/:id',
    authentication: 'required',
    permission: 'customer.read',
    handler: detailHandler,
  });
  router.register({
    method: 'PATCH',
    path: '/api/v1/admin/inquiries/:id',
    authentication: 'required',
    permission: 'customer.write',
    handler: updateHandler,
  });
  router.register({
    method: 'POST',
    path: '/api/v1/admin/inquiries/:id/conversion',
    authentication: 'required',
    permission: 'customer.write',
    handler: conversionHandler,
  });
}
