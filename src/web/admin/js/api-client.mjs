let csrfToken = null;

export class AdminApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function requestEnvelope(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      payload.error?.code ?? 'REQUEST_FAILED',
      payload.error?.message ?? '後台請求失敗',
      payload.error?.details ?? [],
    );
  }
  if (payload.data?.csrfToken) csrfToken = payload.data.csrfToken;
  return payload;
}

async function request(path, options) {
  return (await requestEnvelope(path, options)).data;
}

export function clearAdminSession() {
  csrfToken = null;
}

export function getAdminSession() {
  return request('/api/v1/admin/auth/session');
}

export function getAdminBootstrap() {
  return request('/api/v1/admin/auth/bootstrap');
}

export function getDevelopmentUsers() {
  return request('/api/v1/admin/auth/development-users');
}

export function getAdminDashboard() {
  return request('/api/v1/admin/dashboard');
}

export function getAdminOperationalReports(search = '') {
  return request(`/api/v1/admin/reports/operational${search}`);
}

export function getAdminNotifications() {
  return request('/api/v1/admin/notifications');
}

export function getAdminInquiries(search = '') {
  return requestEnvelope(`/api/v1/admin/inquiries${search}`);
}

export function getAdminInquiry(inquiryId) {
  return request(`/api/v1/admin/inquiries/${encodeURIComponent(inquiryId)}`);
}

export function getAdminInquiryAssignees() {
  return request('/api/v1/admin/inquiries/assignees');
}

export function updateAdminInquiry(inquiryId, update) {
  return request(`/api/v1/admin/inquiries/${encodeURIComponent(inquiryId)}`, {
    method: 'PATCH',
    body: update,
  });
}

export function convertAdminInquiry(inquiryId, conversion) {
  return request(`/api/v1/admin/inquiries/${encodeURIComponent(inquiryId)}/conversion`, {
    method: 'POST', body: conversion,
  });
}

export function getAdminCustomers(search = '') {
  return requestEnvelope(`/api/v1/admin/customers${search}`);
}

export async function downloadAdminCustomerExport(search = '') {
  const response = await fetch(`/api/v1/admin/customers/export.csv${search}`, {
    headers: { Accept: 'text/csv' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Keep server failures private when they do not return the standard JSON envelope.
    }
    throw new AdminApiError(
      response.status,
      payload?.error?.code ?? 'EXPORT_FAILED',
      payload?.error?.message ?? '客戶匯出失敗，未建立檔案。',
      payload?.error?.details ?? [],
    );
  }
  if (!/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new AdminApiError(502, 'INVALID_EXPORT_FORMAT', '匯出格式不正確，未建立檔案。');
  }
  return { csv: await response.text(), filename: 'customers-export.csv' };
}

export function getAdminCustomer(customerId, { sensitive = false } = {}) {
  const suffix = sensitive ? '/sensitive' : '';
  return request(`/api/v1/admin/customers/${encodeURIComponent(customerId)}${suffix}`);
}

export function getAdminServiceAreas() {
  return request('/api/v1/admin/customers/service-areas');
}

export function createAdminCustomer(customer) {
  return request('/api/v1/admin/customers', { method: 'POST', body: customer });
}

export function updateAdminCustomer(customerId, customer) {
  return request(`/api/v1/admin/customers/${encodeURIComponent(customerId)}`, {
    method: 'PATCH', body: customer,
  });
}

export function saveAdminCustomerContact(customerId, contactId, contact) {
  const suffix = contactId ? `/contacts/${encodeURIComponent(contactId)}` : '/contacts';
  return request(`/api/v1/admin/customers/${encodeURIComponent(customerId)}${suffix}`, {
    method: contactId ? 'PATCH' : 'POST', body: contact,
  });
}

export function saveAdminServiceLocation(customerId, locationId, location) {
  const suffix = locationId ? `/locations/${encodeURIComponent(locationId)}` : '/locations';
  return request(`/api/v1/admin/customers/${encodeURIComponent(customerId)}${suffix}`, {
    method: locationId ? 'PATCH' : 'POST', body: location,
  });
}

export function getAdminPlans(search = '') {
  return requestEnvelope(`/api/v1/admin/catalog/plans${search}`);
}

export function getAdminPlan(planId) {
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}`);
}

export function getAdminPlanPreview(planId) {
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}/preview`);
}

export function createAdminPlan(plan) {
  return request('/api/v1/admin/catalog/plans', { method: 'POST', body: plan });
}

export function updateAdminPlan(planId, plan) {
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}`, {
    method: 'PATCH', body: plan,
  });
}

export function publishAdminPlan(planId, expectedUpdatedAt, isPublished) {
  const action = isPublished ? 'publish' : 'unpublish';
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}/${action}`, {
    method: 'POST', body: { expectedUpdatedAt },
  });
}

export function deleteAdminPlan(planId, expectedUpdatedAt) {
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}`, {
    method: 'DELETE', body: { expectedUpdatedAt },
  });
}

export function getAdminPlanPrices(planId) {
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}/prices`);
}

export function saveAdminPlanPrice(planId, priceId, price) {
  const suffix = priceId ? `/${encodeURIComponent(priceId)}` : '';
  return request(`/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}/prices${suffix}`, {
    method: priceId ? 'PATCH' : 'POST', body: price,
  });
}

export function deleteAdminPlanPrice(planId, priceId, expectedUpdatedAt) {
  return request(
    `/api/v1/admin/catalog/plans/${encodeURIComponent(planId)}/prices/${encodeURIComponent(priceId)}`,
    { method: 'DELETE', body: { expectedUpdatedAt } },
  );
}

export function getAdminCatalogCategories() {
  return request('/api/v1/admin/catalog-v2/categories');
}

export function createAdminCatalogCategory(category) {
  return request('/api/v1/admin/catalog-v2/categories', { method: 'POST', body: category });
}

export function updateAdminCatalogCategory(categoryId, category) {
  return request(`/api/v1/admin/catalog-v2/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH', body: category,
  });
}

export function moveAdminCatalogCategory(categoryId, update) {
  return request(`/api/v1/admin/catalog-v2/categories/${encodeURIComponent(categoryId)}/move`, {
    method: 'POST', body: update,
  });
}

export function getAdminCatalogProducts(search = '') {
  return requestEnvelope(`/api/v1/admin/catalog-v2/products${search}`);
}

export function getAdminCatalogProduct(productId) {
  return request(`/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}`);
}

export function createAdminCatalogProduct(product) {
  return request('/api/v1/admin/catalog-v2/products', { method: 'POST', body: product });
}

export function updateAdminCatalogProduct(productId, product) {
  return request(`/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH', body: product,
  });
}

export function deleteAdminCatalogProduct(productId, expectedVersion) {
  return request(`/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}`, {
    method: 'DELETE', body: { expectedVersion },
  });
}

export function publishAdminCatalogProduct(productId, publication) {
  return request(`/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}/publish`, {
    method: 'POST', body: publication,
  });
}

export function archiveAdminCatalogProduct(productId, expectedVersion) {
  return request(`/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}/archive`, {
    method: 'POST', body: { expectedVersion },
  });
}

function catalogV2ProductPath(productId) {
  return `/api/v1/admin/catalog-v2/products/${encodeURIComponent(productId)}`;
}

export function getAdminCatalogProductContent(productId, locale) {
  return request(`${catalogV2ProductPath(productId)}/content/${encodeURIComponent(locale)}`);
}

export function createAdminCatalogProductContent(productId, content) {
  return request(`${catalogV2ProductPath(productId)}/content`, { method: 'POST', body: content });
}

export function updateAdminCatalogProductContent(productId, locale, content) {
  return request(`${catalogV2ProductPath(productId)}/content/${encodeURIComponent(locale)}`, {
    method: 'PATCH', body: content,
  });
}

export function createAdminCatalogProductSection(productId, locale, section) {
  return request(`${catalogV2ProductPath(productId)}/content/${encodeURIComponent(locale)}/sections`, {
    method: 'POST', body: section,
  });
}

export function updateAdminCatalogProductSection(productId, sectionId, section) {
  return request(`${catalogV2ProductPath(productId)}/sections/${encodeURIComponent(sectionId)}`, {
    method: 'PATCH', body: section,
  });
}

export function createAdminCatalogProductSpec(productId, locale, spec) {
  return request(`${catalogV2ProductPath(productId)}/content/${encodeURIComponent(locale)}/specs`, {
    method: 'POST', body: spec,
  });
}

export function updateAdminCatalogProductSpec(productId, specId, spec) {
  return request(`${catalogV2ProductPath(productId)}/specs/${encodeURIComponent(specId)}`, {
    method: 'PATCH', body: spec,
  });
}

export function getAdminCatalogProductMedia(productId) {
  return request(`${catalogV2ProductPath(productId)}/media`);
}

export function createAdminCatalogProductMedia(productId, media) {
  return request(`${catalogV2ProductPath(productId)}/media`, { method: 'POST', body: media });
}

export function updateAdminCatalogProductMedia(productId, mediaId, media) {
  return request(`${catalogV2ProductPath(productId)}/media/${encodeURIComponent(mediaId)}`, {
    method: 'PATCH', body: media,
  });
}

export function deleteAdminCatalogProductMedia(productId, mediaId, expectedVersion) {
  return request(`${catalogV2ProductPath(productId)}/media/${encodeURIComponent(mediaId)}`, {
    method: 'DELETE', body: { expectedVersion },
  });
}

export function getAdminCatalogBrands() {
  return request('/api/v1/admin/catalog-v2/brands');
}

export function createAdminCatalogBrand(brand) {
  return request('/api/v1/admin/catalog-v2/brands', { method: 'POST', body: brand });
}

export function updateAdminCatalogBrand(brandId, brand) {
  return request(`/api/v1/admin/catalog-v2/brands/${encodeURIComponent(brandId)}`, {
    method: 'PATCH', body: brand,
  });
}

export function getAdminCatalogProductBrands(productId) {
  return request(`${catalogV2ProductPath(productId)}/brands`);
}

export function createAdminCatalogProductBrand(productId, brand) {
  return request(`${catalogV2ProductPath(productId)}/brands`, { method: 'POST', body: brand });
}

export function updateAdminCatalogProductBrand(productId, brandId, brand) {
  return request(`${catalogV2ProductPath(productId)}/brands/${encodeURIComponent(brandId)}`, {
    method: 'PATCH', body: brand,
  });
}

export function getAdminOrders() {
  return request('/api/v1/admin/orders');
}

export function getAdminOrder(orderId) {
  return request(`/api/v1/admin/orders/${encodeURIComponent(orderId)}`);
}

export function createAdminOrder(order, idempotencyKey) {
  return request('/api/v1/admin/orders', {
    method: 'POST',
    body: order,
    idempotencyKey,
  });
}

export function transitionAdminOrder(orderId, action, expectedUpdatedAt, reason = null) {
  return request(`/api/v1/admin/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: 'POST', body: { expectedUpdatedAt, reason },
  });
}

export function getAdminWorkOrders(search = '') {
  return request(`/api/v1/admin/work-orders${search}`);
}

export function getAdminWorkOrder(workOrderId) {
  return request(`/api/v1/admin/work-orders/${encodeURIComponent(workOrderId)}`);
}

export function createAdminWorkOrder(workOrder) {
  return request('/api/v1/admin/work-orders', { method: 'POST', body: workOrder });
}

export function transitionAdminWorkOrder(workOrderId, action, body) {
  return request(`/api/v1/admin/work-orders/${encodeURIComponent(workOrderId)}/${action}`, {
    method: 'POST', body,
  });
}

export function getAdminSubscriptions(search = '') {
  return request(`/api/v1/admin/subscriptions${search}`);
}

export function getAdminSubscription(subscriptionId) {
  return request(`/api/v1/admin/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export function transitionAdminSubscription(subscriptionId, action, body) {
  return request(`/api/v1/admin/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`, {
    method: 'POST', body,
  });
}

export function saveAdminServiceAccount(subscriptionId, account) {
  return request(`/api/v1/admin/subscriptions/${encodeURIComponent(subscriptionId)}/account`, {
    method: 'PATCH', body: account,
  });
}

export function getAdminOutages(search = '') {
  return request(`/api/v1/admin/outages${search}`);
}

export function getAdminOutage(incidentId) {
  return request(`/api/v1/admin/outages/${encodeURIComponent(incidentId)}`);
}

export function createAdminOutage(incident) {
  return request('/api/v1/admin/outages', { method: 'POST', body: incident });
}

export function transitionAdminOutage(incidentId, action, body) {
  return request(`/api/v1/admin/outages/${encodeURIComponent(incidentId)}/${action}`, {
    method: 'POST', body,
  });
}

export function addAdminOutageSubscription(incidentId, body) {
  return request(`/api/v1/admin/outages/${encodeURIComponent(incidentId)}/subscriptions`, {
    method: 'POST', body,
  });
}

export function removeAdminOutageSubscription(incidentId, subscriptionId, expectedUpdatedAt) {
  return request(`/api/v1/admin/outages/${encodeURIComponent(incidentId)}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE', body: { expectedUpdatedAt, notes: null },
  });
}

export function getAdminInvoices(search = '') {
  return request(`/api/v1/admin/invoices${search}`);
}

export function getAdminInvoice(invoiceId) {
  return request(`/api/v1/admin/invoices/${encodeURIComponent(invoiceId)}`);
}

export function generateAdminInvoice(invoice) {
  return request('/api/v1/admin/invoices', { method: 'POST', body: invoice });
}

export function generateAdminInvoiceBatch(period) {
  return request('/api/v1/admin/invoices/batch', { method: 'POST', body: period });
}

export function transitionAdminInvoice(invoiceId, action, body) {
  return request(`/api/v1/admin/invoices/${encodeURIComponent(invoiceId)}/${action}`, {
    method: 'POST', body,
  });
}

export function getAdminBillingActivity(invoiceId) {
  return request(`/api/v1/admin/billing/invoices/${encodeURIComponent(invoiceId)}/activity`);
}

export function postAdminPayment(payment) {
  return request('/api/v1/admin/payments', { method: 'POST', body: payment });
}

export function requestAdminBillingAdjustment(adjustment) {
  return request('/api/v1/admin/billing-adjustments', { method: 'POST', body: adjustment });
}

export function getAdminBillingAdjustments(search = '') {
  return request(`/api/v1/admin/billing-adjustments${search}`);
}

export function decideAdminBillingAdjustment(requestId, action, expectedUpdatedAt) {
  return request(`/api/v1/admin/billing-adjustments/${encodeURIComponent(requestId)}/${action}`, {
    method: 'POST', body: { expectedUpdatedAt },
  });
}

export function getAdminInventory() {
  return request('/api/v1/admin/inventory');
}

export function createAdminWarehouse(warehouse) {
  return request('/api/v1/admin/inventory/warehouses', { method: 'POST', body: warehouse });
}

export function createAdminStockItem(item) {
  return request('/api/v1/admin/inventory/items', { method: 'POST', body: item });
}

export function createAdminStockMovement(movement) {
  return request('/api/v1/admin/inventory/movements', { method: 'POST', body: movement });
}

export function getAdminContent() {
  return request('/api/v1/admin/content');
}

export function createAdminContent(type, content) {
  return request(`/api/v1/admin/content/${encodeURIComponent(type)}`, { method: 'POST', body: content });
}

export function updateAdminContent(type, contentId, content) {
  return request(`/api/v1/admin/content/${encodeURIComponent(type)}/${encodeURIComponent(contentId)}`, {
    method: 'PATCH', body: content,
  });
}

export function publishAdminContent(type, contentId, expectedUpdatedAt, isPublished) {
  const action = isPublished ? 'publish' : 'unpublish';
  return request(`/api/v1/admin/content/${encodeURIComponent(type)}/${encodeURIComponent(contentId)}/${action}`, {
    method: 'POST', body: { expectedUpdatedAt },
  });
}

export function getAdminAccess() {
  return request('/api/v1/admin/access');
}

export function createAdminStaff(staff) {
  return request('/api/v1/admin/access/staff', { method: 'POST', body: staff });
}

export function updateAdminStaff(staffUserId, staff) {
  return request(`/api/v1/admin/access/staff/${encodeURIComponent(staffUserId)}`, { method: 'PATCH', body: staff });
}

export function deleteAdminStaff(staffUserId, expectedUpdatedAt) {
  return request(`/api/v1/admin/access/staff/${encodeURIComponent(staffUserId)}`, {
    method: 'DELETE', body: { expectedUpdatedAt },
  });
}

export function replaceAdminStaffRoles(staffUserId, roles) {
  return request(`/api/v1/admin/access/staff/${encodeURIComponent(staffUserId)}/roles`, { method: 'PUT', body: roles });
}

export function getAdminAudit(search = '') {
  return requestEnvelope(`/api/v1/admin/audit${search}`);
}

export function getAdminAuditDetail(auditId) {
  return request(`/api/v1/admin/audit/${encodeURIComponent(auditId)}`);
}

export function loginPasswordUser(identifier, password) {
  return request('/api/v1/admin/auth/login', {
    method: 'POST',
    body: { identifier, password },
  });
}

export function loginDevelopmentUser(staffUserId) {
  return request('/api/v1/admin/auth/development-login', {
    method: 'POST',
    body: { staffUserId },
  });
}

export async function logoutAdmin() {
  const result = await request('/api/v1/admin/auth/logout', { method: 'POST' });
  clearAdminSession();
  return result;
}

export async function getSystemHealth() {
  const response = await fetch('/api/v1/health', { credentials: 'same-origin' });
  if (!response.ok) throw new AdminApiError(response.status, 'HEALTH_FAILED', '系統狀態異常');
  return response.json();
}
