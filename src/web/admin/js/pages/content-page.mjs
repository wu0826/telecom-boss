import {
  AdminApiError, createAdminContent, getAdminContent, publishAdminContent, updateAdminContent,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const TYPE_LABELS = { pages: '頁面', announcements: '公告', banners: '橫幅' };

function value(form, name) {
  return form.elements.namedItem(name).value.trim();
}

function nullable(form, name) {
  return value(form, name) || null;
}

function dateTime(form, name) {
  const input = value(form, name);
  return input ? new Date(input).toISOString() : null;
}

function localDateTime(valueToFormat) {
  if (!valueToFormat) return '';
  const date = new Date(valueToFormat);
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function createContentPage({
  document, page, refreshButton, status, form, formTitle, cancelButton,
  list, preview, onSessionExpired = () => {},
}) {
  const gate = createSubmissionGate();
  let publishingAllowed = false;
  let content = { pages: [], announcements: [], banners: [] };

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired(); return true;
    }
    return false;
  }

  function currentType() {
    return form.elements.namedItem('contentType').value;
  }

  function syncFields() {
    const type = currentType();
    for (const group of form.querySelectorAll('[data-content-fields]')) {
      const active = group.dataset.contentFields === type;
      group.hidden = !active;
      for (const input of group.querySelectorAll('input, textarea, select')) input.disabled = !active;
    }
  }

  function body() {
    const type = currentType();
    if (type === 'pages') return {
      slug: value(form, 'slug'), title: value(form, 'pageTitle'), bodyText: value(form, 'pageBody'),
      seoTitle: nullable(form, 'seoTitle'), seoDescription: nullable(form, 'seoDescription'),
    };
    if (type === 'announcements') return {
      title: value(form, 'announcementTitle'), summary: nullable(form, 'summary'),
      bodyText: value(form, 'announcementBody'),
      announcementType: value(form, 'announcementType'),
      startsAt: dateTime(form, 'announcementStartsAt'), endsAt: dateTime(form, 'announcementEndsAt'),
    };
    return {
      title: value(form, 'bannerTitle'), imageUrl: value(form, 'imageUrl'),
      targetUrl: nullable(form, 'targetUrl'), altText: value(form, 'altText'),
      startsAt: dateTime(form, 'bannerStartsAt'), endsAt: dateTime(form, 'bannerEndsAt'),
      sortOrder: Number(value(form, 'sortOrder')),
    };
  }

  function showPreview(item, type) {
    preview.replaceChildren();
    const eyebrow = document.createElement('span'); eyebrow.textContent = `${TYPE_LABELS[type]}預覽 · ${item.isPublished ? '已發布' : '草稿'}`;
    const title = document.createElement('h3'); title.textContent = item.title;
    const text = document.createElement('p');
    text.textContent = item.bodyText ?? item.summary ?? item.altText ?? '無預覽文字';
    const meta = document.createElement('small');
    meta.textContent = item.isCurrentlyVisible ? '目前公開可見' : '目前不會出現在公開網站';
    preview.append(eyebrow, title, text, meta);
  }

  function resetForm() {
    form.reset();
    form.elements.namedItem('contentId').value = '';
    form.elements.namedItem('expectedUpdatedAt').value = '';
    formTitle.textContent = '建立內容草稿';
    cancelButton.hidden = true;
    syncFields();
  }

  function edit(item, type) {
    resetForm();
    form.elements.namedItem('contentType').value = type;
    form.elements.namedItem('contentId').value = item.id;
    form.elements.namedItem('expectedUpdatedAt').value = item.updatedAt;
    syncFields();
    if (type === 'pages') {
      form.elements.namedItem('slug').value = item.slug;
      form.elements.namedItem('pageTitle').value = item.title;
      form.elements.namedItem('pageBody').value = item.bodyText;
      form.elements.namedItem('seoTitle').value = item.seoTitle ?? '';
      form.elements.namedItem('seoDescription').value = item.seoDescription ?? '';
    } else if (type === 'announcements') {
      form.elements.namedItem('announcementTitle').value = item.title;
      form.elements.namedItem('summary').value = item.summary ?? '';
      form.elements.namedItem('announcementBody').value = item.bodyText;
      form.elements.namedItem('announcementType').value = item.announcementType;
      form.elements.namedItem('announcementStartsAt').value = localDateTime(item.startsAt);
      form.elements.namedItem('announcementEndsAt').value = localDateTime(item.endsAt);
    } else {
      form.elements.namedItem('bannerTitle').value = item.title;
      form.elements.namedItem('imageUrl').value = item.imageUrl;
      form.elements.namedItem('targetUrl').value = item.targetUrl ?? '';
      form.elements.namedItem('altText').value = item.altText;
      form.elements.namedItem('bannerStartsAt').value = localDateTime(item.startsAt);
      form.elements.namedItem('bannerEndsAt').value = localDateTime(item.endsAt);
      form.elements.namedItem('sortOrder').value = item.sortOrder;
    }
    formTitle.textContent = `編輯${TYPE_LABELS[type]}草稿`;
    cancelButton.hidden = false;
    showPreview(item, type);
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function render() {
    list.replaceChildren();
    for (const type of ['announcements', 'pages', 'banners']) {
      const section = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = `${TYPE_LABELS[type]}（${content[type].length}）`;
      const cards = document.createElement('div'); cards.className = 'content-cards';
      for (const item of content[type]) {
        const card = document.createElement('article');
        const copy = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = item.title;
        const meta = document.createElement('small');
        meta.textContent = `${item.isPublished ? '已發布' : '草稿'} · ${item.isCurrentlyVisible ? '公開中' : '未公開'} · ${new Date(item.updatedAt).toLocaleString('zh-TW')}`;
        copy.append(title, meta);
        const actions = document.createElement('div'); actions.className = 'content-card__actions';
        const previewButton = document.createElement('button'); previewButton.type = 'button'; previewButton.className = 'secondary-button'; previewButton.textContent = '預覽';
        previewButton.addEventListener('click', () => showPreview(item, type));
        const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'secondary-button'; editButton.textContent = '編輯';
        editButton.addEventListener('click', () => edit(item, type));
        actions.append(previewButton, editButton);
        if (publishingAllowed) {
          const publishButton = document.createElement('button'); publishButton.type = 'button'; publishButton.className = item.isPublished ? 'danger-button' : 'primary-button';
          publishButton.textContent = item.isPublished ? '取消發布' : '發布';
          publishButton.addEventListener('click', async () => {
            publishButton.disabled = true;
            status.textContent = '正在更新公開狀態…';
            try {
              await publishAdminContent(type, item.id, item.updatedAt, !item.isPublished);
              status.textContent = item.isPublished ? '內容已取消發布。' : '內容已發布。';
              await load();
            } catch (error) {
              if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '無法更新公開狀態。';
            } finally { publishButton.disabled = false; }
          });
          actions.append(publishButton);
        }
        card.append(copy, actions); cards.append(card);
      }
      if (!content[type].length) {
        const empty = document.createElement('p'); empty.className = 'table-empty'; empty.textContent = `尚無${TYPE_LABELS[type]}。`; cards.append(empty);
      }
      section.append(heading, cards); list.append(section);
    }
  }

  async function load() {
    refreshButton.disabled = true; status.textContent = '正在載入網站內容…';
    try {
      content = await getAdminContent(); render();
      status.textContent = `已載入 ${Object.values(content).flat().length} 筆內容。`;
    } catch (error) {
      if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '網站內容載入失敗。';
    } finally { refreshButton.disabled = false; }
  }

  form.elements.namedItem('contentType').addEventListener('change', syncFields);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const type = currentType(); const id = value(form, 'contentId');
    status.textContent = id ? '正在儲存內容…' : '正在建立草稿…';
    try {
      const payload = body();
      if (id) payload.expectedUpdatedAt = value(form, 'expectedUpdatedAt');
      const outcome = await gate.run(() => id
        ? updateAdminContent(type, id, payload)
        : createAdminContent(type, payload));
      if (!outcome.accepted) return;
      resetForm(); status.textContent = id ? '內容已儲存。' : '草稿已建立。'; await load();
    } catch (error) {
      if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '內容儲存失敗。';
    }
  });
  cancelButton.addEventListener('click', resetForm);
  refreshButton.addEventListener('click', load);
  syncFields();

  return {
    async show({ canPublish = false } = {}) { publishingAllowed = canPublish; page.hidden = false; await load(); },
    hide() { page.hidden = true; },
  };
}
