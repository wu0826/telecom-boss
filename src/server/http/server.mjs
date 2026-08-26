import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { registerAdminAuthRoutes } from '../admin/auth/auth-routes.mjs';
import { createAdminGuard } from '../admin/auth/admin-guard.mjs';
import { createAuthService } from '../admin/auth/auth-service.mjs';
import { createSessionStore } from '../admin/auth/session-store.mjs';
import { createAuditService } from '../admin/audit/audit-service.mjs';
import { registerAdminCatalogRoutes } from '../admin/catalog/catalog-routes.mjs';
import { createAdminPlanService } from '../admin/catalog/plan-service.mjs';
import { createAdminPriceService } from '../admin/catalog/price-service.mjs';
import { registerAdminProductRoutes } from '../admin/products/product-routes.mjs';
import { createAdminProductService } from '../admin/products/product-service.mjs';
import { registerAdminProductContentRoutes } from '../admin/products/content-routes.mjs';
import { createAdminProductContentService } from '../admin/products/content-service.mjs';
import { registerAdminCustomerRoutes } from '../admin/customers/customer-routes.mjs';
import { createAdminCustomerService } from '../admin/customers/customer-service.mjs';
import { registerAdminDashboardRoutes } from '../admin/dashboard/dashboard-routes.mjs';
import { createDashboardService } from '../admin/dashboard/dashboard-service.mjs';
import { registerAdminReportRoutes } from '../admin/reports/report-routes.mjs';
import { createAdminReportService } from '../admin/reports/report-service.mjs';
import { registerAdminNotificationRoutes } from '../admin/notifications/notification-routes.mjs';
import { createAdminNotificationService } from '../admin/notifications/notification-service.mjs';
import { registerAdminInquiryRoutes } from '../admin/inquiries/inquiry-routes.mjs';
import { createAdminInquiryService } from '../admin/inquiries/inquiry-service.mjs';
import { createInquiryConversionService } from '../admin/inquiries/inquiry-conversion-service.mjs';
import { registerAdminOrderRoutes } from '../admin/orders/order-routes.mjs';
import { createAdminOrderService } from '../admin/orders/order-service.mjs';
import { registerAdminWorkOrderRoutes } from '../admin/operations/work-order-routes.mjs';
import { createAdminWorkOrderService } from '../admin/operations/work-order-service.mjs';
import { registerAdminOutageRoutes } from '../admin/operations/outage-routes.mjs';
import { createAdminOutageService } from '../admin/operations/outage-service.mjs';
import { registerAdminInvoiceRoutes } from '../admin/billing/invoice-routes.mjs';
import { createAdminInvoiceService } from '../admin/billing/invoice-service.mjs';
import { registerAdminPaymentRoutes } from '../admin/billing/payment-routes.mjs';
import { createAdminPaymentService } from '../admin/billing/payment-service.mjs';
import { registerAdminInventoryRoutes } from '../admin/inventory/inventory-routes.mjs';
import { createAdminInventoryService } from '../admin/inventory/inventory-service.mjs';
import { registerAdminContentRoutes } from '../admin/content/content-routes.mjs';
import { createAdminContentService } from '../admin/content/content-service.mjs';
import { registerAdminAccessRoutes } from '../admin/access/access-routes.mjs';
import { createAdminAccessService } from '../admin/access/access-service.mjs';
import { registerAdminSubscriptionRoutes } from '../admin/subscriptions/subscription-routes.mjs';
import { createSqliteRuntimeDatabase } from '../db/runtime-database.mjs';
import { createAdminSubscriptionService } from '../admin/subscriptions/subscription-service.mjs';
import { registerPublicRoutes } from './public-routes.mjs';
import { readJsonRequestBody } from './request-body.mjs';
import { createRouter } from './router.mjs';
import { HttpError, sendError } from './responses.mjs';
import { serveStaticFile } from './static-files.mjs';
import { assertRuntimeReadiness } from '../services/health-service.mjs';

const API_PREFIX = '/api/v1';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_INQUIRY_RATE_LIMIT = Object.freeze({ maxAttempts: 5, windowMs: 10 * 60_000 });
const DEFAULT_LOGIN_RATE_LIMIT = Object.freeze({ maxAttempts: 10, windowMs: 15 * 60_000 });
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

function createRateLimiter({ maxAttempts, windowMs }) {
  const attemptsByClient = new Map();
  return {
    take(client, now = Date.now()) {
      const cutoff = now - windowMs;
      const attempts = (attemptsByClient.get(client) ?? []).filter((time) => time > cutoff);
      if (attempts.length >= maxAttempts) {
        const retryAfterSeconds = Math.max(1, Math.ceil((attempts[0] + windowMs - now) / 1_000));
        attemptsByClient.set(client, attempts);
        return retryAfterSeconds;
      }
      attempts.push(now);
      attemptsByClient.set(client, attempts);
      return null;
    },
  };
}

async function routeRequest(request, response, configuration, router, requestId) {
  if (!request.url || request.url.length > 2_048) {
    throw new HttpError(414, 'URI_TOO_LONG', '請求網址過長');
  }

  let url;
  try {
    url = new URL(request.url, `http://${LOOPBACK_HOST}`);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '請求網址格式不正確');
  }

  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    await serveStaticFile({
      request,
      response,
      pathname: url.pathname,
      webRoot: configuration.webRoot,
      requestId,
    });
    return;
  }

  const requestBody = await readJsonRequestBody(request, {
    limitBytes: configuration.bodyLimitBytes,
  });
  const resolution = router.resolve(request.method, url.pathname);
  if (resolution.kind === 'not-found') {
    throw new HttpError(404, 'NOT_FOUND', '找不到要求的資源');
  }
  if (resolution.kind === 'method-not-allowed') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此端點不支援該 HTTP 方法', {
      headers: { Allow: resolution.allowedMethods.join(', ') },
    });
  }
  await resolution.handler({
    request,
    response,
    configuration,
    requestId,
    requestBody,
    url,
    params: resolution.params,
    authContext: await configuration.adminGuard.authorize(request, resolution, requestId),
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

export async function startApplicationServer({
  host = LOOPBACK_HOST,
  port = 4_173,
  metadataDatabasePath,
  telecomDatabasePath,
  metadataDatabase = null,
  telecomDatabase = null,
  bodyLimitBytes = 64 * 1_024,
  inquiryRateLimit = DEFAULT_INQUIRY_RATE_LIMIT,
  enableDevelopmentLogin = false,
  developmentLoginRateLimit = DEFAULT_LOGIN_RATE_LIMIT,
  passwordLoginRateLimit = DEFAULT_LOGIN_RATE_LIMIT,
  passwordLoginPolicy = { threshold: 5, observationWindowMs: 15 * 60_000, lockDurationMs: 15 * 60_000 },
  passwordHasher = undefined,
  secureSessionCookie = false,
  sessionIdleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  sessionClock = Date.now,
  dashboardClock = Date.now,
  reportClock = Date.now,
  notificationClock = Date.now,
  inquiryWorkflowClock = Date.now,
  customerClock = Date.now,
  inquiryConversionClock = Date.now,
  planClock = Date.now,
  priceClock = Date.now,
  orderClock = Date.now,
  orderWorkflowClock = orderClock,
  workOrderClock = Date.now,
  subscriptionClock = Date.now,
  outageClock = Date.now,
  invoiceClock = Date.now,
  paymentClock = Date.now,
  inventoryClock = Date.now,
  contentClock = Date.now,
  accessClock = Date.now,
  productClock = Date.now,
  catalogClock = Date.now,
  requireStartupReadiness = false,
  webRoot = resolve(import.meta.dirname, '..', '..', 'web'),
}) {
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Local server must bind to ${LOOPBACK_HOST}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid server port: ${port}`);
  }
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error('bodyLimitBytes must be a positive integer');
  }
  if (
    !Number.isInteger(inquiryRateLimit?.maxAttempts)
    || inquiryRateLimit.maxAttempts < 1
    || !Number.isInteger(inquiryRateLimit?.windowMs)
    || inquiryRateLimit.windowMs < 1
  ) {
    throw new Error('inquiryRateLimit must contain positive integer limits');
  }
  if (typeof enableDevelopmentLogin !== 'boolean') {
    throw new Error('enableDevelopmentLogin must be a boolean');
  }
  if (
    !Number.isInteger(developmentLoginRateLimit?.maxAttempts)
    || developmentLoginRateLimit.maxAttempts < 1
    || !Number.isInteger(developmentLoginRateLimit?.windowMs)
    || developmentLoginRateLimit.windowMs < 1
  ) {
    throw new Error('developmentLoginRateLimit must contain positive integer limits');
  }
  if (
    !Number.isInteger(passwordLoginRateLimit?.maxAttempts)
    || passwordLoginRateLimit.maxAttempts < 1
    || !Number.isInteger(passwordLoginRateLimit?.windowMs)
    || passwordLoginRateLimit.windowMs < 1
  ) {
    throw new Error('passwordLoginRateLimit must contain positive integer limits');
  }
  if (
    !Number.isInteger(passwordLoginPolicy?.threshold) || passwordLoginPolicy.threshold < 1
    || !Number.isInteger(passwordLoginPolicy?.observationWindowMs) || passwordLoginPolicy.observationWindowMs < 1
    || !Number.isInteger(passwordLoginPolicy?.lockDurationMs) || passwordLoginPolicy.lockDurationMs < 1
  ) {
    throw new Error('passwordLoginPolicy must contain positive integer limits');
  }
  if (typeof secureSessionCookie !== 'boolean') throw new Error('secureSessionCookie must be a boolean');
  if (!Number.isInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1) {
    throw new Error('sessionIdleTimeoutMs must be a positive integer');
  }
  if (typeof requireStartupReadiness !== 'boolean') {
    throw new Error('requireStartupReadiness must be a boolean');
  }
  const runtimeMetadataDatabase = metadataDatabase ?? createSqliteRuntimeDatabase(metadataDatabasePath);
  const runtimeTelecomDatabase = telecomDatabase ?? createSqliteRuntimeDatabase(telecomDatabasePath);
  const sessionStore = createSessionStore({ idleTimeoutMs: sessionIdleTimeoutMs, clock: sessionClock });

  const authService = createAuthService({
    telecomDatabasePath: runtimeTelecomDatabase,
    sessionStore,
    enableDevelopmentLogin,
    sessionIdleTimeoutMs,
    secureSessionCookie,
    passwordPolicy: passwordLoginPolicy,
    ...(passwordHasher ? { passwordHasher } : {}),
    clock: sessionClock,
  });
  const auditService = createAuditService({ databasePath: runtimeTelecomDatabase });
  const dashboardService = createDashboardService({
    databasePath: runtimeTelecomDatabase,
    clock: dashboardClock,
  });
  const adminReportService = createAdminReportService({
    databasePath: runtimeTelecomDatabase,
    clock: reportClock,
  });
  const adminNotificationService = createAdminNotificationService({
    databasePath: runtimeTelecomDatabase,
    clock: notificationClock,
  });
  const adminInquiryService = createAdminInquiryService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: inquiryWorkflowClock,
  });
  const adminCustomerService = createAdminCustomerService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: customerClock,
  });
  const inquiryConversionService = createInquiryConversionService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: inquiryConversionClock,
  });
  const adminPlanService = createAdminPlanService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: planClock,
  });
  const adminPriceService = createAdminPriceService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: priceClock,
  });
  const adminOrderService = createAdminOrderService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: orderWorkflowClock,
  });
  const adminWorkOrderService = createAdminWorkOrderService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: workOrderClock,
  });
  const adminSubscriptionService = createAdminSubscriptionService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: subscriptionClock,
  });
  const adminOutageService = createAdminOutageService({
    databasePath: runtimeTelecomDatabase, auditService, clock: outageClock,
  });
  const adminInvoiceService = createAdminInvoiceService({
    databasePath: runtimeTelecomDatabase, auditService, clock: invoiceClock,
  });
  const adminPaymentService = createAdminPaymentService({
    databasePath: runtimeTelecomDatabase, auditService, clock: paymentClock,
  });
  const adminInventoryService = createAdminInventoryService({
    databasePath: runtimeTelecomDatabase, auditService, clock: inventoryClock,
  });
  const adminContentService = createAdminContentService({
    databasePath: runtimeTelecomDatabase, auditService, clock: contentClock,
  });
  const adminAccessService = createAdminAccessService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    revokeUserSessions: (staffUserId) => authService.revokeUserSessions(staffUserId),
    clock: accessClock,
  });
  const adminProductService = createAdminProductService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: productClock,
  });
  const adminProductContentService = createAdminProductContentService({
    databasePath: runtimeTelecomDatabase,
    auditService,
    clock: productClock,
  });
  const configuration = {
    metadataDatabasePath: runtimeMetadataDatabase,
    telecomDatabasePath: runtimeTelecomDatabase,
    catalogClock,
    bodyLimitBytes,
    inquiryRateLimiter: createRateLimiter(inquiryRateLimit),
    developmentLoginRateLimiter: createRateLimiter(developmentLoginRateLimit),
    passwordLoginRateLimiter: createRateLimiter(passwordLoginRateLimit),
    authService,
    auditService,
    dashboardService,
    adminReportService,
    adminNotificationService,
    adminInquiryService,
    adminCustomerService,
    inquiryConversionService,
    adminPlanService,
    adminPriceService,
    adminOrderService,
    adminWorkOrderService,
    adminSubscriptionService,
    adminOutageService,
    adminInvoiceService,
    adminPaymentService,
    adminInventoryService,
    adminContentService,
    adminAccessService,
    adminProductService,
    adminProductContentService,
    adminGuard: createAdminGuard({ authService, auditService }),
    webRoot,
  };
  if (requireStartupReadiness) {
    try {
      await assertRuntimeReadiness(configuration);
    } catch (error) {
      const databases = [...new Set([runtimeMetadataDatabase, runtimeTelecomDatabase])];
      await Promise.allSettled(databases.map((database) => database.close()));
      throw error;
    }
  }

  const router = createRouter();
  registerPublicRoutes(router);
  registerAdminAuthRoutes(router);
  registerAdminDashboardRoutes(router);
  registerAdminReportRoutes(router);
  registerAdminNotificationRoutes(router);
  registerAdminInquiryRoutes(router);
  registerAdminCustomerRoutes(router);
  registerAdminCatalogRoutes(router);
  registerAdminProductRoutes(router);
  registerAdminProductContentRoutes(router);
  registerAdminOrderRoutes(router);
  registerAdminWorkOrderRoutes(router);
  registerAdminSubscriptionRoutes(router);
  registerAdminOutageRoutes(router);
  registerAdminInvoiceRoutes(router);
  registerAdminPaymentRoutes(router);
  registerAdminInventoryRoutes(router);
  registerAdminContentRoutes(router);
  registerAdminAccessRoutes(router);
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    void routeRequest(request, response, configuration, router, requestId)
      .catch((error) => sendError(response, error, requestId));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  return {
    server,
    origin: `http://${LOOPBACK_HOST}:${address.port}`,
    async close() {
      await closeServer(server);
      const databases = [...new Set([runtimeMetadataDatabase, runtimeTelecomDatabase])];
      await Promise.all(databases.map((database) => database.close()));
    },
  };
}
