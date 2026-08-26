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
const TABLES = Object.freeze({
  pages: 'cms_pages',
  announcements: 'cms_announcements',
  banners: 'cms_banners',
});

function tableFor(type) {
  const table = TABLES[type];
  if (!table) throw new TypeError('Unsupported content type');
  return table;
}

async function selectRow(database, type, id) {
  const table = await tableFor(type);
  return await database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

export async function readContentRows({ databasePath }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return {
      pages: await database.prepare('SELECT * FROM cms_pages ORDER BY updated_at DESC, id DESC').all(),
      announcements: await database.prepare('SELECT * FROM cms_announcements ORDER BY updated_at DESC, id DESC').all(),
      banners: await database.prepare('SELECT * FROM cms_banners ORDER BY sort_order, id').all(),
    };
  } finally {
    database.close();
  }
}

export async function findContentRow({ databasePath, type, id }) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return await selectRow(database, type, id);
  } finally {
    database.close();
  }
}

export async function createContentRow({ databasePath, type, values, afterWrite }) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      let result;
      if (type === 'pages') {
        result = await database.prepare(`INSERT INTO cms_pages
          (slug, title, body_html, seo_title, seo_description, status,
            published_at, author_staff_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'DRAFT', NULL, ?, ?, ?)`)
          .run(values.slug, values.title, values.bodyText, values.seoTitle,
            values.seoDescription, values.authorStaffUserId, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt));
      } else if (type === 'announcements') {
        result = await database.prepare(`INSERT INTO cms_announcements
          (title, summary, body_html, announcement_type, status, starts_at,
            ends_at, author_staff_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`)
          .run(values.title, values.summary, values.bodyText, values.announcementType,
            writeDateTime(database, values.startsAt), writeDateTime(database, values.endsAt), values.authorStaffUserId, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt));
      } else if (type === 'banners') {
        result = await database.prepare(`INSERT INTO cms_banners
          (title, image_url, target_url, alt_text, starts_at, ends_at,
            sort_order, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
          .run(values.title, values.imageUrl, values.targetUrl, values.altText,
            writeDateTime(database, values.startsAt), writeDateTime(database, values.endsAt), values.sortOrder, writeDateTime(database, values.createdAt), writeDateTime(database, values.updatedAt));
      } else {
        await tableFor(type);
      }
      const row = await selectRow(database, type, Number(result.lastInsertRowid));
      await afterWrite(database, row);
      return row;
    });
  } finally {
    database.close();
  }
}

export async function updateContentRow({
  databasePath, type, id, expectedUpdatedAt, updatedAt, values, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectRow(database, type, id);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      let update;
      if (type === 'pages') {
        update = await database.prepare(`UPDATE cms_pages SET slug = ?, title = ?, body_html = ?,
          seo_title = ?, seo_description = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
          .run(values.slug, values.title, values.bodyText, values.seoTitle,
            values.seoDescription, writeDateTime(database, updatedAt), id, before.updated_at);
      } else if (type === 'announcements') {
        update = await database.prepare(`UPDATE cms_announcements SET title = ?, summary = ?,
          body_html = ?, announcement_type = ?, starts_at = ?, ends_at = ?, updated_at = ?
          WHERE id = ? AND updated_at = ?`)
          .run(values.title, values.summary, values.bodyText, values.announcementType,
            writeDateTime(database, values.startsAt), writeDateTime(database, values.endsAt), writeDateTime(database, updatedAt), id, before.updated_at);
      } else if (type === 'banners') {
        update = await database.prepare(`UPDATE cms_banners SET title = ?, image_url = ?, target_url = ?,
          alt_text = ?, starts_at = ?, ends_at = ?, sort_order = ?, updated_at = ?
          WHERE id = ? AND updated_at = ?`)
          .run(values.title, values.imageUrl, values.targetUrl, values.altText, values.startsAt,
            writeDateTime(database, values.endsAt), values.sortOrder, writeDateTime(database, updatedAt), id, before.updated_at);
      } else {
        await tableFor(type);
      }
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectRow(database, type, id);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}

export async function setContentPublicationRow({
  databasePath, type, id, expectedUpdatedAt, isPublished, updatedAt, afterWrite,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await runAtomicResult(database, async () => {
      const before = await selectRow(database, type, id);
      if (!before) return { kind: 'not-found' };
      if (new Date(before.updated_at).toISOString() !== expectedUpdatedAt) return { kind: 'conflict' };
      let update;
      if (type === 'banners') {
        update = await database.prepare(`UPDATE cms_banners SET is_active = ?, updated_at = ?
            WHERE id = ? AND updated_at = ?`)
          .run(isPublished ? 1 : 0, writeDateTime(database, updatedAt), id, before.updated_at);
      } else if (type === 'pages') {
        update = await database.prepare(`UPDATE cms_pages SET status = ?, published_at = ?, updated_at = ?
            WHERE id = ? AND updated_at = ?`)
          .run(isPublished ? 'PUBLISHED' : 'DRAFT', isPublished ? writeDateTime(database, updatedAt) : null,
        writeDateTime(database, updatedAt), id, before.updated_at);
      } else {
        update = await database.prepare(`UPDATE cms_announcements SET status = ?, updated_at = ?
            WHERE id = ? AND updated_at = ?`)
          .run(isPublished ? 'PUBLISHED' : 'DRAFT', writeDateTime(database, updatedAt), id, before.updated_at);
      }
      if (Number(update.changes) !== 1) return { kind: 'conflict' };
      const after = await selectRow(database, type, id);
      await afterWrite(database, before, after);
      return { kind: 'updated', row: after };
    });
  } finally {
    database.close();
  }
}
