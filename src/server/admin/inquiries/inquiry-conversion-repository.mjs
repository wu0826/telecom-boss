import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

class ConversionConflictSignal extends Error {}

async function inquiryById(database, inquiryId) {
  return await database.prepare(`
    SELECT id, inquiry_no, customer_id, prospect_name, phone, email, address_text,
      requested_plan_id, status, assigned_staff_user_id, updated_at
    FROM service_inquiries WHERE id = ?
  `).get(inquiryId) ?? null;
}

async function customerById(database, customerId) {
  return await database.prepare(`
    SELECT id, customer_no, status FROM customers WHERE id = ?
  `).get(customerId) ?? null;
}

async function serviceAreaById(database, serviceAreaId) {
  if (serviceAreaId === null) return null;
  return await database.prepare(`
    SELECT id, is_active FROM service_areas WHERE id = ?
  `).get(serviceAreaId) ?? null;
}

export async function convertInquiryRows({
  databasePath,
  inquiryId,
  expectedUpdatedAt,
  conversion,
  validate,
  afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  conversion = {
    ...conversion,
    timestamp: writeDateTime(database, conversion.timestamp),
  };
  try {
    return await runAtomicResult(database, async () => {
      const inquiry = await inquiryById(database, inquiryId);
      if (!inquiry) return { kind: 'not-found' };
      if (inquiry.status === 'CONVERTED') return { kind: 'already-converted' };
      if (new Date(inquiry.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };

      let customer;
      if (conversion.customer.mode === 'EXISTING') {
        customer = await customerById(database, conversion.customer.customerId);
      }
      const area = conversion.location.create
        ? await serviceAreaById(database, conversion.location.serviceAreaId)
        : null;
      await validate({ inquiry, customer, area });

      if (conversion.customer.mode === 'NEW') {
        const result = await database.prepare(`
          INSERT INTO customers (
            customer_no, customer_type, display_name, legal_name,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'LEAD', ?, ?)
        `).run(
          conversion.customer.customerNo,
          conversion.customer.customerType,
          conversion.customer.displayName,
          conversion.customer.legalName,
          conversion.timestamp,
          conversion.timestamp,
        );
        customer = await customerById(database, Number(result.lastInsertRowid));
      }

      const primaryExists = Boolean(await database.prepare(`
        SELECT 1 FROM customer_contacts
        WHERE customer_id = ? AND is_primary = 1 AND is_active = 1 LIMIT 1
      `).get(customer.id));
      const contactResult = await database.prepare(`
        INSERT INTO customer_contacts (
          customer_id, contact_name, contact_type, phone, email,
          is_primary, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        customer.id,
        inquiry.prospect_name,
        primaryExists ? 'OTHER' : 'PRIMARY',
        inquiry.phone,
        inquiry.email,
        primaryExists ? 0 : 1,
        conversion.timestamp,
        conversion.timestamp,
      );

      let locationId = null;
      if (conversion.location.create) {
        const locationResult = await database.prepare(`
          INSERT INTO service_locations (
            location_no, customer_id, service_area_id, postal_code, city, district,
            address_line, floor_unit, access_notes, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          conversion.location.locationNo,
          customer.id,
          conversion.location.serviceAreaId,
          conversion.location.postalCode,
          conversion.location.city,
          conversion.location.district,
          conversion.location.addressLine,
          conversion.location.floorUnit,
          conversion.location.accessNotes,
          conversion.location.status,
          conversion.timestamp,
          conversion.timestamp,
        );
        locationId = Number(locationResult.lastInsertRowid);
      }

      const orderResult = await database.prepare(`
        INSERT INTO sales_orders (
          order_no, customer_id, service_location_id, engineering_project_id,
          order_type, status, sales_staff_user_id, ordered_at,
          subtotal_amount, tax_amount, total_amount, notes, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'NEW_SERVICE', 'DRAFT', ?, ?, 0, 0, 0, NULL, ?, ?)
      `).run(
        conversion.orderNo,
        customer.id,
        locationId,
        conversion.actorStaffUserId,
        conversion.timestamp,
        conversion.timestamp,
        conversion.timestamp,
      );
      const orderId = Number(orderResult.lastInsertRowid);

      const updated = await database.prepare(`
        UPDATE service_inquiries
        SET customer_id = ?, status = 'CONVERTED', updated_at = ?
        WHERE id = ? AND updated_at = ? AND status = 'QUALIFIED'
      `).run(customer.id, conversion.timestamp, inquiryId, inquiry.updated_at);
      if (Number(updated.changes) !== 1) throw new ConversionConflictSignal();

      const result = {
        customerId: Number(customer.id),
        contactId: Number(contactResult.lastInsertRowid),
        locationId,
        orderId,
        orderNo: conversion.orderNo,
      };
      await afterWrite(database, inquiry, result);
      return { kind: 'converted', result };
    });
  } catch (error) {
    if (error instanceof ConversionConflictSignal) return { kind: 'conflict' };
    throw error;
  } finally {
    database.close();
  }
}
