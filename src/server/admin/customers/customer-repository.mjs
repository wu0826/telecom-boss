import { openRuntimeDatabase, runAtomicResult } from '../../db/runtime-database.mjs';

const SORT_COLUMNS = Object.freeze({
  createdAt: 'created_at',
  customerNo: 'customer_no',
  displayName: 'display_name',
  status: 'status',
});

function escapeLike(value) {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

export function mysqlDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid MySQL datetime value');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function writeDateTime(database, value) {
  return database.kind === 'mysql' ? mysqlDateTime(value) : value;
}

async function customerFilterWhere(query) {
  const clauses = [];
  const values = [];
  if (query.keyword) {
    const keyword = `%${await escapeLike(query.keyword)}%`;
    clauses.push(`(
      customers.customer_no LIKE ? ESCAPE '!'
      OR customers.display_name LIKE ? ESCAPE '!'
      OR customers.legal_name LIKE ? ESCAPE '!'
    )`);
    values.push(keyword, keyword, keyword);
  }
  for (const [column, value] of [
    ['customer_type', query.customerType],
    ['status', query.status],
  ]) {
    if (value !== null) {
      clauses.push(`customers.${column} = ?`);
      values.push(value);
    }
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

async function customerById(database, customerId) {
  return await database.prepare(`
    SELECT id, customer_no, customer_type, display_name, legal_name, status, created_at, updated_at
    FROM customers WHERE id = ?
  `).get(customerId) ?? null;
}

async function contactById(database, customerId, contactId) {
  return await database.prepare(`
    SELECT id, customer_id, contact_name, contact_type, phone, email,
      is_primary, is_active, created_at, updated_at
    FROM customer_contacts WHERE id = ? AND customer_id = ?
  `).get(contactId, customerId) ?? null;
}

async function locationById(database, customerId, locationId) {
  return await database.prepare(`
    SELECT service_locations.*, service_areas.area_code, service_areas.area_name,
      service_areas.access_technology, service_areas.is_active AS service_area_active
    FROM service_locations
    LEFT JOIN service_areas ON service_areas.id = service_locations.service_area_id
    WHERE service_locations.id = ? AND service_locations.customer_id = ?
  `).get(locationId, customerId) ?? null;
}

async function serviceAreaById(database, serviceAreaId) {
  if (serviceAreaId === null) return null;
  return await database.prepare(`
    SELECT id, area_code, area_name, access_technology, is_active
    FROM service_areas WHERE id = ?
  `).get(serviceAreaId) ?? null;
}

export async function searchCustomerRows({ databasePath, query }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const { where, values } = await customerFilterWhere(query);
    const total = Number((await database.prepare(
      `SELECT COUNT(*) AS count FROM customers ${where}`,
    ).get(...values)).count);
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.pageSize;
    const rows = await database.prepare(`
      SELECT id, customer_no, customer_type, display_name, legal_name, status, created_at, updated_at
      FROM customers ${where}
      ORDER BY ${SORT_COLUMNS[query.sort]} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...values, query.pageSize, offset);
    return { rows, total };
  } finally {
    database.close();
  }
}

export async function exportCustomerRows({ databasePath, query, limit }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const { where, values } = await customerFilterWhere(query);
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    return await database.prepare(`
      SELECT
        customers.customer_no,
        customers.customer_type,
        customers.display_name,
        customers.status,
        primary_contact.contact_name,
        primary_contact.phone,
        primary_contact.email,
        primary_location.city,
        primary_location.district,
        primary_location.address_line,
        primary_location.floor_unit
      FROM customers
      LEFT JOIN customer_contacts AS primary_contact ON primary_contact.id = (
        SELECT candidate.id
        FROM customer_contacts AS candidate
        WHERE candidate.customer_id = customers.id AND candidate.is_active = 1
        ORDER BY candidate.is_primary DESC, candidate.id
        LIMIT 1
      )
      LEFT JOIN service_locations AS primary_location ON primary_location.id = (
        SELECT candidate.id
        FROM service_locations AS candidate
        WHERE candidate.customer_id = customers.id
        ORDER BY candidate.id
        LIMIT 1
      )
      ${where}
      ORDER BY customers.${SORT_COLUMNS[query.sort]} ${direction}, customers.id ${direction}
      LIMIT ?
    `).all(...values, limit);
  } finally {
    database.close();
  }
}

export async function findCustomerRecord({ databasePath, customerId }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const customer = await customerById(database, customerId);
    if (!customer) return null;
    return {
      customer,
      contacts: await database.prepare(`
        SELECT id, customer_id, contact_name, contact_type, phone, email,
          is_primary, is_active, created_at, updated_at
        FROM customer_contacts WHERE customer_id = ?
        ORDER BY is_primary DESC, is_active DESC, id
      `).all(customerId),
      locations: await database.prepare(`
        SELECT service_locations.*, service_areas.area_code, service_areas.area_name,
          service_areas.access_technology, service_areas.is_active AS service_area_active
        FROM service_locations
        LEFT JOIN service_areas ON service_areas.id = service_locations.service_area_id
        WHERE service_locations.customer_id = ?
        ORDER BY service_locations.id
      `).all(customerId),
    };
  } finally {
    database.close();
  }
}

export async function listActiveServiceAreaRows(databasePath) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await database.prepare(`
      SELECT id, area_code, area_name, postal_code, city, district, access_technology
      FROM service_areas WHERE is_active = 1
      ORDER BY city, district, area_name, id
    `).all();
  } finally {
    database.close();
  }
}

export async function createCustomerRow({ databasePath, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const result = await database.prepare(`
        INSERT INTO customers (
          customer_no, customer_type, display_name, legal_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.customerNo, values.customerType, values.displayName, values.legalName,
        values.status, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt),
      );
      const row = await customerById(database, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return row;
    });
  } finally {
    database.close();
  }
}

export async function updateCustomerRow({ databasePath, customerId, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await customerById(database, customerId);
      if (!before) return null;
      await database.prepare(`
        UPDATE customers SET customer_type = ?, display_name = ?, legal_name = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        values.customerType, values.displayName, values.legalName,
        values.status, writeDateTime(database, values.updatedAt), customerId,
      );
      const after = await customerById(database, customerId);
      await afterWrite(database, before, after);
      return after;
    });
  } finally {
    database.close();
  }
}

export async function createContactRow({ databasePath, customerId, values, validate, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await customerById(database, customerId)) return { kind: 'customer-not-found' };
      const primaryExists = Boolean(await database.prepare(`
        SELECT 1 FROM customer_contacts
        WHERE customer_id = ? AND is_primary = 1 AND is_active = 1 LIMIT 1
      `).get(customerId));
      await validate({ primaryExists });
      const result = await database.prepare(`
        INSERT INTO customer_contacts (
          customer_id, contact_name, contact_type, phone, email,
          is_primary, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customerId, values.contactName, values.contactType, values.phone, values.email,
        values.isPrimary ? 1 : 0, values.isActive ? 1 : 0, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt),
      );
      const row = await contactById(database, customerId, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateContactRow({ databasePath, customerId, contactId, values, validate, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await contactById(database, customerId, contactId);
      if (!before) return null;
      const primaryExists = Boolean(await database.prepare(`
        SELECT 1 FROM customer_contacts
        WHERE customer_id = ? AND id <> ? AND is_primary = 1 AND is_active = 1 LIMIT 1
      `).get(customerId, contactId));
      await validate({ primaryExists });
      await database.prepare(`
        UPDATE customer_contacts
        SET contact_name = ?, contact_type = ?, phone = ?, email = ?,
          is_primary = ?, is_active = ?, updated_at = ?
        WHERE id = ? AND customer_id = ?
      `).run(
        values.contactName, values.contactType, values.phone, values.email,
        values.isPrimary ? 1 : 0, values.isActive ? 1 : 0, writeDateTime(database, values.updatedAt),
        contactId, customerId,
      );
      const after = await contactById(database, customerId, contactId);
      await afterWrite(database, before, after);
      return after;
    });
  } finally {
    database.close();
  }
}

export async function createLocationRow({ databasePath, customerId, values, validate, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      if (!await customerById(database, customerId)) return { kind: 'customer-not-found' };
      const area = await serviceAreaById(database, values.serviceAreaId);
      await validate({ area });
      const result = await database.prepare(`
        INSERT INTO service_locations (
          location_no, customer_id, service_area_id, postal_code, city, district,
          address_line, floor_unit, access_notes, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.locationNo, customerId, values.serviceAreaId, values.postalCode,
        values.city, values.district, values.addressLine, values.floorUnit,
        values.accessNotes, values.status, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt),
      );
      const row = await locationById(database, customerId, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return { kind: 'created', row };
    });
  } finally {
    database.close();
  }
}

export async function updateLocationRow({ databasePath, customerId, locationId, values, validate, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await locationById(database, customerId, locationId);
      if (!before) return null;
      const area = await serviceAreaById(database, values.serviceAreaId);
      await validate({ area });
      await database.prepare(`
        UPDATE service_locations
        SET service_area_id = ?, postal_code = ?, city = ?, district = ?, address_line = ?,
          floor_unit = ?, access_notes = ?, status = ?, updated_at = ?
        WHERE id = ? AND customer_id = ?
      `).run(
        values.serviceAreaId, values.postalCode, values.city, values.district,
        values.addressLine, values.floorUnit, values.accessNotes, values.status,
        writeDateTime(database, values.updatedAt), locationId, customerId,
      );
      const after = await locationById(database, customerId, locationId);
      await afterWrite(database, before, after);
      return after;
    });
  } finally {
    database.close();
  }
}
