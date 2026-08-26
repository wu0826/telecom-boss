import { openRuntimeDatabase } from '../../db/runtime-database.mjs';
import { insertAudit } from './audit-repository.mjs';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_FIELDS = new Set([
  'altText',
  'assignedStaffUserId',
  'brandCode',
  'brandName',
  'categoryCode',
  'categoryName',
  'columnSet',
  'filterFields',
  'groupKey',
  'isActive',
  'isFeatured',
  'isPrimary',
  'locale',
  'logoUrl',
  'mediaUsage',
  'parentId',
  'permissionCodes',
  'productCode',
  'productName',
  'productType',
  'publishFrom',
  'publishUntil',
  'priority',
  'roleCodes',
  'rowCount',
  'slug',
  'sortOrder',
  'sourceId',
  'sectionKey',
  'sectionType',
  'specKey',
  'specLabel',
  'staffNo',
  'status',
  'unit',
  'url',
  'websiteUrl',
  'title',
]);

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength) || null;
}

function safeValue(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return cleanText(value, 128);
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);
  return null;
}

function safeJson(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of allowedFields) {
    if (!SAFE_FIELDS.has(field) || !Object.hasOwn(value, field)) continue;
    result[field] = safeValue(value[field]);
  }
  return Object.keys(result).length === 0 ? null : JSON.stringify(result);
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Audit event must be an object');
  }
  if (!CODE_PATTERN.test(event.action ?? '')) throw new TypeError('Invalid audit action');
  if (!CODE_PATTERN.test(event.entityType ?? '')) throw new TypeError('Invalid audit entity type');
  if (event.requestId !== null && event.requestId !== undefined && !REQUEST_ID_PATTERN.test(event.requestId)) {
    throw new TypeError('Invalid audit requestId');
  }
  if (
    event.actorStaffUserId !== null
    && event.actorStaffUserId !== undefined
    && (!Number.isSafeInteger(event.actorStaffUserId) || event.actorStaffUserId < 1)
  ) {
    throw new TypeError('Invalid audit actor');
  }
}

export function createAuditService({ databasePath }) {
  return {
    async record(event, { database = null } = {}) {
      validateEvent(event);
      const allowedFields = Array.isArray(event.allowedFields) ? event.allowedFields.slice(0, 32) : [];
      const record = {
        actorStaffUserId: event.actorStaffUserId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: cleanText(event.entityId, 128),
        requestId: event.requestId ?? null,
        ipAddress: cleanText(event.ipAddress, 64),
        userAgent: cleanText(event.userAgent, 256),
        beforeJson: safeJson(event.before, allowedFields),
        afterJson: safeJson(event.after, allowedFields),
      };
      if (database) return (await insertAudit(database, record));
      const ownedDatabase = openRuntimeDatabase(databasePath);
      try {
        return await insertAudit(ownedDatabase, record);
      } finally {
        await ownedDatabase.close();
      }
    },
  };
}
