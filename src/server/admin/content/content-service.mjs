import {
  createContentRow, findContentRow, readContentRows, setContentPublicationRow, updateContentRow,
} from './content-repository.mjs';

const TYPES = new Set(['pages', 'announcements', 'banners']);
const PAGE_FIELDS = new Set(['bodyText', 'seoDescription', 'seoTitle', 'slug', 'title']);
const ANNOUNCEMENT_FIELDS = new Set([
  'announcementType', 'bodyText', 'endsAt', 'startsAt', 'summary', 'title',
]);
const BANNER_FIELDS = new Set([
  'altText', 'endsAt', 'imageUrl', 'sortOrder', 'startsAt', 'targetUrl', 'title',
]);
const VERSION_FIELDS = new Set(['expectedUpdatedAt']);
const ANNOUNCEMENT_TYPES = new Set(['NEWS', 'MAINTENANCE', 'OUTAGE', 'PROMOTION']);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AdminContentError extends Error {
  constructor(status, code, message, details = []) {
    super(message); this.name = 'AdminContentError';
    this.status = status; this.code = code; this.details = details;
  }
}

function fail(field, message) {
  throw new AdminContentError(422, 'INVALID_BODY', '內容資料格式不正確。', [{ field, message }]);
}

function contentType(value) {
  if (!TYPES.has(value)) throw new AdminContentError(404, 'CONTENT_NOT_FOUND', '找不到內容。');
  return value;
}

function positiveId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) throw new AdminContentError(404, 'CONTENT_NOT_FOUND', '找不到內容。');
  return id;
}

function objectPayload(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('body', '必須是 JSON 物件。');
  const unknown = Object.keys(payload).find((field) => !fields.has(field));
  if (unknown) fail(unknown, '不支援此欄位。');
}

function requiredText(payload, field, max) {
  if (typeof payload[field] !== 'string') fail(field, '必須是文字。');
  const value = payload[field].trim();
  if (!value || value.length > max) fail(field, `長度必須介於 1 到 ${max} 字。`);
  return value;
}

function optionalText(payload, field, max) {
  if (payload[field] === null || payload[field] === undefined || payload[field] === '') return null;
  if (typeof payload[field] !== 'string') fail(field, '必須是文字或 null。');
  const value = payload[field].trim();
  if (!value || value.length > max) fail(field, `最多 ${max} 字。`);
  return value;
}

function iso(payload, field) {
  const value = payload[field];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(field, '必須是 UTC ISO 8601 時間或 null。');
  }
  return value;
}

function schedule(payload) {
  const startsAt = iso(payload, 'startsAt');
  const endsAt = iso(payload, 'endsAt');
  if (startsAt && endsAt && endsAt < startsAt) fail('endsAt', '結束時間不可早於開始時間。');
  return { startsAt, endsAt };
}

function safePath(value, field, { fragment = false } = {}) {
  if (value === null) return null;
  if (!(value.startsWith('/') && !value.startsWith('//')) && !(fragment && /^#[a-zA-Z][\w-]*$/.test(value))) {
    fail(field, '只允許本站絕對路徑或頁內錨點。');
  }
  return value;
}

function valuesFor(type, payload, update = false) {
  const fields = type === 'pages' ? PAGE_FIELDS : type === 'announcements' ? ANNOUNCEMENT_FIELDS : BANNER_FIELDS;
  objectPayload(payload, update ? new Set([...fields, 'expectedUpdatedAt']) : fields);
  if (type === 'pages') {
    const slug = requiredText(payload, 'slug', 191);
    if (!SLUG_PATTERN.test(slug)) fail('slug', '只能使用小寫英數與單一連字號分隔。');
    return {
      slug,
      title: requiredText(payload, 'title', 200),
      bodyText: requiredText(payload, 'bodyText', 20_000),
      seoTitle: optionalText(payload, 'seoTitle', 200),
      seoDescription: optionalText(payload, 'seoDescription', 500),
    };
  }
  if (type === 'announcements') {
    if (!ANNOUNCEMENT_TYPES.has(payload.announcementType)) fail('announcementType', '公告類型不正確。');
    return {
      title: requiredText(payload, 'title', 200),
      summary: optionalText(payload, 'summary', 500),
      bodyText: requiredText(payload, 'bodyText', 20_000),
      announcementType: payload.announcementType,
      ...schedule(payload),
    };
  }
  const sortOrder = payload.sortOrder;
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100_000) fail('sortOrder', '必須是 0 到 100000 的整數。');
  const imageUrl = safePath(requiredText(payload, 'imageUrl', 500), 'imageUrl');
  const target = optionalText(payload, 'targetUrl', 500);
  return {
    title: requiredText(payload, 'title', 150), imageUrl,
    targetUrl: safePath(target, 'targetUrl', { fragment: true }),
    altText: requiredText(payload, 'altText', 255), sortOrder, ...schedule(payload),
  };
}

function expectedUpdatedAt(payload) {
  const value = payload.expectedUpdatedAt;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('expectedUpdatedAt', '必須是 UTC ISO 8601 時間。');
  }
  return value;
}

function utc(value) {
  return value ? new Date(value).toISOString() : null;
}

function dto(type, row, now) {
  const common = { id: Number(row.id), title: row.title, createdAt: utc(row.created_at), updatedAt: utc(row.updated_at) };
  if (type === 'pages') return {
    ...common, slug: row.slug, bodyText: row.body_html, seoTitle: row.seo_title,
    seoDescription: row.seo_description, status: row.status, isPublished: row.status === 'PUBLISHED',
    publishedAt: utc(row.published_at), isCurrentlyVisible: row.status === 'PUBLISHED',
  };
  if (type === 'announcements') return {
    ...common, summary: row.summary, bodyText: row.body_html, announcementType: row.announcement_type,
    status: row.status, isPublished: row.status === 'PUBLISHED', startsAt: utc(row.starts_at), endsAt: utc(row.ends_at),
    isCurrentlyVisible: row.status === 'PUBLISHED'
      && (!row.starts_at || row.starts_at <= now) && (!row.ends_at || row.ends_at >= now),
  };
  return {
    ...common, imageUrl: row.image_url, targetUrl: row.target_url, altText: row.alt_text,
    startsAt: utc(row.starts_at), endsAt: utc(row.ends_at), sortOrder: Number(row.sort_order),
    isPublished: Boolean(row.is_active), isCurrentlyVisible: Boolean(row.is_active)
      && (!row.starts_at || row.starts_at <= now) && (!row.ends_at || row.ends_at >= now),
  };
}

function nextTimestamp(clock, current = null) {
  const now = Number(clock());
  if (!Number.isFinite(now)) throw new TypeError('Invalid content clock value');
  return new Date(Math.max(now, current ? Date.parse(current) + 1 : now)).toISOString();
}

function writeResult(result) {
  if (result.kind === 'not-found') throw new AdminContentError(404, 'CONTENT_NOT_FOUND', '找不到內容。');
  if (result.kind === 'conflict') throw new AdminContentError(409, 'CONTENT_CONFLICT', '內容已由其他人更新，請重新載入。');
  return result;
}

function mapUnique(error) {
  if (/UNIQUE constraint failed: cms_pages\.slug/i.test(error?.message ?? '')) {
    throw new AdminContentError(409, 'CONTENT_SLUG_CONFLICT', '頁面代稱已存在。', [{ field: 'slug', message: '不可重複。' }]);
  }
  throw error;
}

export function createAdminContentService({ databasePath, auditService, clock = Date.now }) {
  if (!auditService?.record) throw new TypeError('auditService is required');
  const now = () => nextTimestamp(clock);
  const map = (type, row) => dto(type, row, now());
  const audit = (database, actor, requestAudit, event) => auditService.record({
    actorStaffUserId: actor.id, requestId: requestAudit.requestId,
    ipAddress: requestAudit.ipAddress, userAgent: requestAudit.userAgent, ...event,
  }, { database });

  return {
    async list() {
      const rows = (await readContentRows({ databasePath }));
      return Object.fromEntries(Object.entries(rows).map(([type, items]) => [type, items.map((row) => map(type, row))]));
    },
    async detail(typeValue, idValue) {
      const type = contentType(typeValue); const id = positiveId(idValue);
      const row = (await findContentRow({ databasePath, type, id }));
      if (!row) throw new AdminContentError(404, 'CONTENT_NOT_FOUND', '找不到內容。');
      return map(type, row);
    },
    async create(typeValue, payload, actor, requestAudit = {}) {
      const type = contentType(typeValue); const values = valuesFor(type, payload);
      const createdAt = now();
      try {
        return map(type, (await createContentRow({
          databasePath, type,
          values: { ...values, authorStaffUserId: actor.id, createdAt, updatedAt: createdAt },
          async afterWrite(database, row) {
            await audit(database, actor, requestAudit, {
              action: 'CONTENT_CREATED', entityType: type.toUpperCase(), entityId: String(row.id),
              after: { status: type === 'banners' ? 'DRAFT' : row.status }, allowedFields: ['status'],
            });
          },
        })));
      } catch (error) { mapUnique(error); }
    },
    async update(typeValue, idValue, payload, actor, requestAudit = {}) {
      const type = contentType(typeValue); const id = positiveId(idValue);
      const values = valuesFor(type, payload, true); const expected = expectedUpdatedAt(payload);
      try {
        const result = writeResult((await updateContentRow({
          databasePath, type, id, values, expectedUpdatedAt: expected,
          updatedAt: nextTimestamp(clock, expected),
          async afterWrite(database) {
            await audit(database, actor, requestAudit, {
              action: 'CONTENT_UPDATED', entityType: type.toUpperCase(), entityId: String(id),
              allowedFields: [],
            });
          },
        })));
        return map(type, result.row);
      } catch (error) { if (error instanceof AdminContentError) throw error; mapUnique(error); }
    },
    async setPublication(typeValue, idValue, payload, isPublished, actor, requestAudit = {}) {
      objectPayload(payload, VERSION_FIELDS);
      const type = contentType(typeValue); const id = positiveId(idValue); const expected = expectedUpdatedAt(payload);
      const result = writeResult((await setContentPublicationRow({
        databasePath, type, id, expectedUpdatedAt: expected, isPublished,
        updatedAt: nextTimestamp(clock, expected),
        async afterWrite(database, before, after) {
          await audit(database, actor, requestAudit, {
            action: isPublished ? 'CONTENT_PUBLISHED' : 'CONTENT_UNPUBLISHED',
            entityType: type.toUpperCase(), entityId: String(id),
            before: { isActive: type === 'banners' ? Boolean(before.is_active) : before.status === 'PUBLISHED' },
            after: { isActive: type === 'banners' ? Boolean(after.is_active) : after.status === 'PUBLISHED' },
            allowedFields: ['isActive'],
          });
        },
      })));
      return map(type, result.row);
    },
    async publicContent() {
      const rows = (await readContentRows({ databasePath })); const current = now();
      return {
        pages: rows.pages.map((row) => dto('pages', row, current)).filter((item) => item.isCurrentlyVisible),
        announcements: rows.announcements.map((row) => dto('announcements', row, current)).filter((item) => item.isCurrentlyVisible),
        banners: rows.banners.map((row) => dto('banners', row, current)).filter((item) => item.isCurrentlyVisible),
      };
    },
  };
}
