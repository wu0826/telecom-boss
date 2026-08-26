import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

async function login(app, staffUserId) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = session ? { cookie: session.cookie } : {};
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

const page = (overrides = {}) => ({
  slug: 'service-notice',
  title: '服務說明',
  bodyText: '這是公開頁面內容。',
  seoTitle: '服務說明',
  seoDescription: '官方服務說明',
  ...overrides,
});

const announcement = (overrides = {}) => ({
  title: '維護公告',
  summary: '北區例行維護',
  bodyText: '維護期間部分服務可能短暫中斷。',
  announcementType: 'MAINTENANCE',
  startsAt: '2026-07-21T11:00:00.000Z',
  endsAt: '2026-07-21T13:00:00.000Z',
  ...overrides,
});

const banner = (overrides = {}) => ({
  title: '夏季升速活動',
  imageUrl: '/assets/images/hero-network.svg',
  targetUrl: '#plans',
  altText: '夏季升速活動',
  startsAt: '2026-07-21T11:00:00.000Z',
  endsAt: '2026-07-21T13:00:00.000Z',
  sortOrder: 10,
  ...overrides,
});

async function create(app, admin, type, body) {
  return request(app, admin, `/api/v1/admin/content/${type}`, { method: 'POST', body });
}

async function publish(app, admin, type, item) {
  return request(app, admin, `/api/v1/admin/content/${type}/${item.id}/publish`, {
    method: 'POST', body: { expectedUpdatedAt: item.updatedAt },
  });
}

test('CMS drafts are private and admin previews return plain-text DTOs', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true, contentClock: () => NOW });
  const admin = await login(app, 1);
  const createdPage = await create(app, admin, 'pages', page());
  const createdAnnouncement = await create(app, admin, 'announcements', announcement());
  const createdBanner = await create(app, admin, 'banners', banner());
  assert.equal(createdPage.response.status, 201);
  assert.equal(createdAnnouncement.response.status, 201);
  assert.equal(createdBanner.response.status, 201);
  assert.equal(createdPage.body.data.status, 'DRAFT');
  assert.equal(createdBanner.body.data.isPublished, false);

  const preview = await request(app, admin, `/api/v1/admin/content/pages/${createdPage.body.data.id}/preview`);
  assert.deepEqual(preview.body.data, createdPage.body.data);
  const publicContent = await request(app, null, '/api/v1/content');
  assert.equal(publicContent.response.status, 200);
  assert.deepEqual(publicContent.body, { pages: [], announcements: [], banners: [] });
});

test('public CMS output applies publication windows and deterministic banner ordering', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true, contentClock: () => NOW });
  const admin = await login(app, 1);
  const currentAnnouncement = (await create(app, admin, 'announcements', announcement())).body.data;
  const futureAnnouncement = (await create(app, admin, 'announcements', announcement({
    title: '未來公告', startsAt: '2026-07-22T11:00:00.000Z', endsAt: null,
  }))).body.data;
  const laterBanner = (await create(app, admin, 'banners', banner({ title: '排序二', sortOrder: 20 }))).body.data;
  const firstBanner = (await create(app, admin, 'banners', banner({ title: '排序一', sortOrder: 1 }))).body.data;
  const visiblePage = (await create(app, admin, 'pages', page())).body.data;
  for (const [type, item] of [
    ['announcements', currentAnnouncement], ['announcements', futureAnnouncement],
    ['banners', laterBanner], ['banners', firstBanner], ['pages', visiblePage],
  ]) {
    assert.equal((await publish(app, admin, type, item)).response.status, 200);
  }
  const publicContent = await request(app, null, '/api/v1/content');
  assert.equal(publicContent.body.pages.length, 1);
  assert.deepEqual(publicContent.body.announcements.map(({ title }) => title), ['維護公告']);
  assert.deepEqual(publicContent.body.banners.map(({ title }) => title), ['排序一', '排序二']);
});

test('CMS treats script payloads as inert text and rejects unsafe banner URLs', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true, contentClock: () => NOW });
  const admin = await login(app, 1);
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const created = await create(app, admin, 'pages', page({ title: payload, bodyText: payload }));
  assert.equal(created.response.status, 201);
  const published = await publish(app, admin, 'pages', created.body.data);
  assert.equal(published.response.status, 200);
  const publicContent = await request(app, null, '/api/v1/content');
  assert.equal(publicContent.body.pages[0].title, payload);
  assert.equal(publicContent.body.pages[0].bodyText, payload);
  const unsafe = await create(app, admin, 'banners', banner({ imageUrl: 'javascript:alert(1)' }));
  assert.equal(unsafe.response.status, 422);
});

test('CMS separates edit and publish permissions, enforces versions, audits, and rolls back audit failures', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true, contentClock: () => NOW });
  const database = new DatabaseSync(app.telecomDatabasePath);
  database.prepare(`INSERT INTO role_permissions (grant_key, role_id, permission_id)
    VALUES ('2:8', 2, 8)`).run();
  database.close();
  const editor = await login(app, 2);
  const admin = await login(app, 1);
  const created = await create(app, editor, 'pages', page());
  assert.equal(created.response.status, 201);
  assert.equal((await publish(app, editor, 'pages', created.body.data)).response.status, 403);
  const published = await publish(app, admin, 'pages', created.body.data);
  assert.equal(published.response.status, 200);
  assert.equal((await publish(app, admin, 'pages', created.body.data)).response.status, 409);

  const verify = new DatabaseSync(app.telecomDatabasePath);
  assert.equal(Number(verify.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CONTENT_PUBLISHED'").get().count), 1);
  verify.exec(`CREATE TRIGGER fail_content_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'CONTENT_UNPUBLISHED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  verify.close();
  const failed = await request(app, admin, `/api/v1/admin/content/pages/${created.body.data.id}/unpublish`, {
    method: 'POST', body: { expectedUpdatedAt: published.body.data.updatedAt },
  });
  assert.equal(failed.response.status, 500);
  const finalDatabase = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(finalDatabase.prepare('SELECT status FROM cms_pages WHERE id = ?').get(created.body.data.id).status, 'PUBLISHED');
  finalDatabase.close();
});
