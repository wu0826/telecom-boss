import {
  AdminApiError,
  createAdminCatalogBrand,
  createAdminCatalogProductBrand,
  createAdminCatalogProductContent,
  createAdminCatalogProductMedia,
  createAdminCatalogProductSection,
  createAdminCatalogProductSpec,
  deleteAdminCatalogProductMedia,
  getAdminCatalogBrands,
  getAdminCatalogProductBrands,
  getAdminCatalogProductContent,
  getAdminCatalogProductMedia,
  updateAdminCatalogBrand,
  updateAdminCatalogProductBrand,
  updateAdminCatalogProductContent,
  updateAdminCatalogProductMedia,
  updateAdminCatalogProductSection,
  updateAdminCatalogProductSpec,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createDialogController, createTabsController } from '../components.mjs?v=20260817-dialog-escape';
import { clearFormErrors, createSubmissionGate, showFormErrors } from '../form-controller.mjs';

const CONTENT_FIELDS = ['locale', 'title', 'summary', 'bodyText', 'seoTitle', 'seoDescription'];
const SECTION_FIELDS = ['sectionKey', 'sectionType', 'title', 'bodyText', 'sortOrder', 'isActive'];
const SPEC_FIELDS = ['specKey', 'groupKey', 'groupLabel', 'specLabel', 'specValue', 'unit', 'sortOrder'];
const MEDIA_FIELDS = ['mediaUsage', 'url', 'altText', 'isPrimary', 'sortOrder'];
const BRAND_FIELDS = ['brandCode', 'slug', 'brandName', 'description', 'websiteUrl', 'logoUrl', 'sortOrder', 'isActive'];
const BRAND_LINK_FIELDS = ['brandId', 'isPrimary', 'sortOrder'];
const FIELD_LABELS = {
  locale: '語系代碼', title: '頁面標題', summary: '摘要', bodyText: '純文字內容',
  seoTitle: 'SEO 標題', seoDescription: 'SEO 說明', sectionKey: '區塊代碼',
  sectionType: '區塊類型', sortOrder: '排序', isActive: '啟用設定', specKey: '規格代碼',
  groupKey: '群組代碼', groupLabel: '群組名稱', specLabel: '規格名稱', specValue: '數值',
  unit: '單位', mediaUsage: '圖片用途', url: '圖片網址', altText: '替代文字',
  isPrimary: '主圖設定', brandCode: '品牌代碼', slug: '網址代稱', brandName: '品牌名稱',
  description: '品牌說明', websiteUrl: '官方網址', logoUrl: 'Logo 網址', brandId: '品牌',
  expectedProductVersion: '商品版本',
};

function byId(document, id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing product content element: ${id}`);
  return element;
}

function text(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function optionalText(form, name) {
  return text(form, name) || null;
}

function number(form, name) {
  return Number(text(form, name));
}

function setValue(form, name, value) {
  const control = form.elements.namedItem(name);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = Boolean(value);
  else control.value = value ?? '';
}

function appendText(document, parent, tagName, value, className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function actionButton(document, label, callback, tone = 'table-action') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = tone;
  button.textContent = label;
  button.addEventListener('click', callback);
  return button;
}

function emptyList(document, container, message) {
  container.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'product-content-list__empty';
  empty.textContent = message;
  container.append(empty);
}

function truncate(value, maximum = 180) {
  const normalized = String(value ?? '').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

function contentPayload(form) {
  return {
    locale: text(form, 'locale'),
    title: text(form, 'title'),
    summary: optionalText(form, 'summary'),
    bodyText: optionalText(form, 'bodyText'),
    seoTitle: optionalText(form, 'seoTitle'),
    seoDescription: optionalText(form, 'seoDescription'),
  };
}

function sectionPayload(form) {
  return {
    sectionKey: text(form, 'sectionKey'),
    sectionType: text(form, 'sectionType'),
    title: optionalText(form, 'title'),
    bodyText: text(form, 'bodyText'),
    sortOrder: number(form, 'sortOrder'),
    isActive: form.elements.namedItem('isActive').checked,
  };
}

function specPayload(form) {
  return {
    specKey: text(form, 'specKey'),
    groupKey: text(form, 'groupKey'),
    groupLabel: text(form, 'groupLabel'),
    specLabel: text(form, 'specLabel'),
    specValue: text(form, 'specValue'),
    unit: optionalText(form, 'unit'),
    sortOrder: number(form, 'sortOrder'),
  };
}

function mediaPayload(form) {
  const isPrimary = form.elements.namedItem('isPrimary').checked;
  const selectedUsage = text(form, 'mediaUsage');
  return {
    mediaUsage: isPrimary ? 'PRIMARY' : (selectedUsage === 'PRIMARY' ? 'GALLERY' : selectedUsage),
    url: text(form, 'url'),
    altText: text(form, 'altText'),
    isPrimary,
    sortOrder: number(form, 'sortOrder'),
  };
}

function brandPayload(form) {
  return {
    brandCode: text(form, 'brandCode'),
    slug: text(form, 'slug'),
    brandName: text(form, 'brandName'),
    description: optionalText(form, 'description'),
    websiteUrl: optionalText(form, 'websiteUrl'),
    logoUrl: optionalText(form, 'logoUrl'),
    sortOrder: number(form, 'sortOrder'),
    isActive: form.elements.namedItem('isActive').checked,
  };
}

export function createProductContentEditor({
  document,
  onSessionExpired = () => {},
  onProductVersion = () => {},
}) {
  const editor = byId(document, 'product-content-editor');
  const status = byId(document, 'product-content-status');
  const refreshButton = byId(document, 'product-content-refresh');
  const tabList = byId(document, 'product-content-tabs');
  const tabs = [
    byId(document, 'product-content-tab'),
    byId(document, 'product-sections-tab'),
    byId(document, 'product-assets-tab'),
  ];
  const panels = [
    byId(document, 'product-content-panel'),
    byId(document, 'product-sections-panel'),
    byId(document, 'product-assets-panel'),
  ];
  const contentForm = byId(document, 'product-content-form');
  const contentErrors = byId(document, 'product-content-errors');
  const contentLoadButton = byId(document, 'product-content-load');
  const sectionForm = byId(document, 'product-section-form');
  const sectionErrors = byId(document, 'product-section-errors');
  const sectionList = byId(document, 'product-section-list');
  const specForm = byId(document, 'product-spec-form');
  const specErrors = byId(document, 'product-spec-errors');
  const specList = byId(document, 'product-spec-list');
  const mediaForm = byId(document, 'product-media-form');
  const mediaErrors = byId(document, 'product-media-errors');
  const mediaList = byId(document, 'product-media-list');
  const brandForm = byId(document, 'product-brand-form');
  const brandErrors = byId(document, 'product-brand-errors');
  const brandList = byId(document, 'product-brand-list');
  const brandLinkForm = byId(document, 'product-brand-link-form');
  const brandLinkErrors = byId(document, 'product-brand-link-errors');
  const brandLinkSelect = byId(document, 'product-brand-link-id');
  const preview = byId(document, 'product-content-preview');
  const deleteDialog = byId(document, 'product-content-delete-dialog');
  const deleteDialogMessage = byId(document, 'product-content-delete-dialog-message');
  const deleteCancelButton = byId(document, 'product-content-delete-cancel');
  const deleteConfirmButton = byId(document, 'product-content-delete-confirm');
  const tabsController = createTabsController({ tabList, tabs, panels });
  const deleteDialogController = createDialogController({
    dialog: deleteDialog,
    initialFocus: deleteCancelButton,
  });
  const submissionGate = createSubmissionGate();
  let currentProduct = null;
  let projection = { content: null, sections: [], specs: [] };
  let media = [];
  let brands = [];
  let productBrands = [];
  let pendingMediaDelete = null;

  function currentLocale() {
    return text(contentForm, 'locale') || 'zh-TW';
  }

  function setStatus(message) {
    status.textContent = message;
  }

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function showWriteError({ error, form, summary, fields, fallback }) {
    if (error instanceof AdminApiError) {
      const hasFieldErrors = showFormErrors({
        form,
        summary,
        errors: error.details,
        allowedFields: fields,
        fieldLabels: FIELD_LABELS,
      });
      if (hasFieldErrors) {
        setStatus('請修正標示欄位後再送出。');
      } else if (error.code.endsWith('_CONFLICT')) {
        setStatus('資料已被其他人更新。請重新載入後，確認並重新輸入變更。');
      } else {
        setStatus(error.message);
      }
      return;
    }
    setStatus(fallback);
  }

  function setProductVersion(rowVersion) {
    if (!currentProduct || !Number.isSafeInteger(rowVersion)) return;
    currentProduct = { ...currentProduct, rowVersion };
    setValue(brandLinkForm, 'expectedProductVersion', rowVersion);
    onProductVersion(rowVersion);
  }

  function resetSectionForm() {
    sectionForm.reset();
    setValue(sectionForm, 'sectionId', '');
    setValue(sectionForm, 'expectedVersion', '');
    setValue(sectionForm, 'sectionType', 'TEXT');
    setValue(sectionForm, 'sortOrder', 0);
    setValue(sectionForm, 'isActive', true);
    clearFormErrors(sectionForm, sectionErrors);
  }

  function resetSpecForm() {
    specForm.reset();
    setValue(specForm, 'specId', '');
    setValue(specForm, 'expectedVersion', '');
    setValue(specForm, 'sortOrder', 0);
    clearFormErrors(specForm, specErrors);
  }

  function resetMediaForm() {
    mediaForm.reset();
    setValue(mediaForm, 'mediaId', '');
    setValue(mediaForm, 'expectedVersion', '');
    setValue(mediaForm, 'mediaUsage', 'GALLERY');
    setValue(mediaForm, 'sortOrder', 0);
    setValue(mediaForm, 'isPrimary', false);
    clearFormErrors(mediaForm, mediaErrors);
  }

  function resetBrandForm() {
    brandForm.reset();
    setValue(brandForm, 'brandId', '');
    setValue(brandForm, 'expectedVersion', '');
    setValue(brandForm, 'sortOrder', 0);
    setValue(brandForm, 'isActive', true);
    clearFormErrors(brandForm, brandErrors);
  }

  function resetBrandLinkForm() {
    brandLinkForm.reset();
    setValue(brandLinkForm, 'linkedBrandId', '');
    setValue(brandLinkForm, 'expectedProductVersion', currentProduct?.rowVersion ?? '');
    setValue(brandLinkForm, 'sortOrder', 0);
    setValue(brandLinkForm, 'isPrimary', false);
    clearFormErrors(brandLinkForm, brandLinkErrors);
  }

  function resetContentForm({ keepLocale = true } = {}) {
    const locale = keepLocale ? currentLocale() : 'zh-TW';
    contentForm.reset();
    setValue(contentForm, 'locale', locale);
    setValue(contentForm, 'expectedVersion', '');
    clearFormErrors(contentForm, contentErrors);
  }

  function fillContentForm(content) {
    if (!content) {
      resetContentForm();
      return;
    }
    for (const field of CONTENT_FIELDS) setValue(contentForm, field, content[field]);
    setValue(contentForm, 'expectedVersion', content.rowVersion);
    clearFormErrors(contentForm, contentErrors);
  }

  function fillSectionForm(section) {
    for (const field of SECTION_FIELDS) setValue(sectionForm, field, section[field]);
    setValue(sectionForm, 'sectionId', section.id);
    setValue(sectionForm, 'expectedVersion', section.rowVersion);
    clearFormErrors(sectionForm, sectionErrors);
    tabsController.select(1, true);
  }

  function fillSpecForm(spec) {
    for (const field of SPEC_FIELDS) setValue(specForm, field, spec[field]);
    setValue(specForm, 'specId', spec.id);
    setValue(specForm, 'expectedVersion', spec.rowVersion);
    clearFormErrors(specForm, specErrors);
    tabsController.select(1, true);
  }

  function fillMediaForm(item) {
    for (const field of MEDIA_FIELDS) setValue(mediaForm, field, item[field]);
    setValue(mediaForm, 'mediaId', item.id);
    setValue(mediaForm, 'expectedVersion', item.rowVersion);
    clearFormErrors(mediaForm, mediaErrors);
    tabsController.select(2, true);
  }

  function fillBrandForm(brand) {
    for (const field of BRAND_FIELDS) setValue(brandForm, field, brand[field]);
    setValue(brandForm, 'brandId', brand.id);
    setValue(brandForm, 'expectedVersion', brand.rowVersion);
    clearFormErrors(brandForm, brandErrors);
    tabsController.select(2, true);
  }

  function fillBrandLinkForm(link) {
    setValue(brandLinkForm, 'linkedBrandId', link.brandId);
    setValue(brandLinkForm, 'brandId', link.brandId);
    setValue(brandLinkForm, 'isPrimary', link.isPrimary);
    setValue(brandLinkForm, 'sortOrder', link.sortOrder);
    setValue(brandLinkForm, 'expectedProductVersion', link.productRowVersion);
    clearFormErrors(brandLinkForm, brandLinkErrors);
    tabsController.select(2, true);
  }

  function renderBrandOptions() {
    const selected = text(brandLinkForm, 'brandId');
    brandLinkSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = brands.length ? '請選擇品牌' : '請先建立或載入品牌';
    brandLinkSelect.append(placeholder);
    for (const brand of brands) {
      const option = document.createElement('option');
      option.value = String(brand.id);
      option.textContent = `${brand.brandName}｜${brand.brandCode}${brand.isActive ? '' : '（停用）'}`;
      brandLinkSelect.append(option);
    }
    brandLinkSelect.value = selected;
  }

  function renderSections() {
    if (!projection.sections.length) {
      emptyList(document, sectionList, '尚未建立展示區塊。可從下方新增第一個區塊。');
      return;
    }
    sectionList.replaceChildren();
    for (const section of projection.sections) {
      const card = document.createElement('article');
      card.className = 'product-content-card';
      appendText(document, card, 'strong', section.title || section.sectionKey);
      appendText(document, card, 'span', `${section.sectionType}｜排序 ${section.sortOrder}｜${section.isActive ? '顯示' : '停用'}`);
      appendText(document, card, 'p', truncate(section.bodyText));
      card.append(actionButton(document, '編輯', () => fillSectionForm(section)));
      sectionList.append(card);
    }
  }

  function renderSpecs() {
    if (!projection.specs.length) {
      emptyList(document, specList, '尚未建立規格。可用結構化欄位加入商品規格。');
      return;
    }
    specList.replaceChildren();
    for (const spec of projection.specs) {
      const card = document.createElement('article');
      card.className = 'product-content-card';
      appendText(document, card, 'strong', `${spec.specLabel}：${spec.specValue}${spec.unit ? ` ${spec.unit}` : ''}`);
      appendText(document, card, 'span', `${spec.groupLabel}｜${spec.specKey}｜排序 ${spec.sortOrder}`);
      card.append(actionButton(document, '編輯', () => fillSpecForm(spec)));
      specList.append(card);
    }
  }

  function renderMedia() {
    if (!media.length) {
      emptyList(document, mediaList, '尚未加入圖片。所有圖片都必須提供替代文字。');
      return;
    }
    mediaList.replaceChildren();
    for (const item of media) {
      const card = document.createElement('article');
      card.className = 'product-content-card';
      appendText(document, card, 'strong', item.altText);
      appendText(document, card, 'span', `${item.isPrimary ? '主圖' : item.mediaUsage}｜排序 ${item.sortOrder}`);
      appendText(document, card, 'p', item.url);
      const actions = document.createElement('div');
      actions.className = 'product-content-card__actions';
      actions.append(
        actionButton(document, '編輯', () => fillMediaForm(item)),
        actionButton(document, '刪除', (event) => {
          pendingMediaDelete = item;
          deleteDialogMessage.textContent = `將刪除「${item.altText}」。此操作無法從後台復原。`;
          deleteDialogController.open(event.currentTarget);
        }),
      );
      card.append(actions);
      mediaList.append(card);
    }
  }

  function renderBrands() {
    if (!brands.length) {
      emptyList(document, brandList, '尚未建立品牌主檔。建立後可在下方連結至目前商品。');
      return;
    }
    const linkedById = new Map(productBrands.map((link) => [link.brandId, link]));
    brandList.replaceChildren();
    for (const brand of brands) {
      const card = document.createElement('article');
      card.className = 'product-content-card';
      const link = linkedById.get(brand.id);
      appendText(document, card, 'strong', brand.brandName);
      appendText(document, card, 'span', `${brand.brandCode}｜${brand.isActive ? '啟用' : '停用'}${link ? `｜已連結${link.isPrimary ? '（主要）' : ''}` : ''}`);
      appendText(document, card, 'p', brand.description || brand.websiteUrl || '尚未填寫品牌說明。');
      const actions = document.createElement('div');
      actions.className = 'product-content-card__actions';
      actions.append(actionButton(document, '編輯主檔', () => fillBrandForm(brand)));
      if (link) actions.append(actionButton(document, '編輯連結', () => fillBrandLinkForm(link)));
      card.append(actions);
      brandList.append(card);
    }
  }

  function renderPreview() {
    preview.replaceChildren();
    appendText(document, preview, 'span', 'SAFE PRODUCT PREVIEW');
    appendText(document, preview, 'h5', projection.content?.title || currentProduct?.productName || '尚未選擇商品');
    appendText(document, preview, 'p', projection.content?.summary || '尚未建立此語系的摘要；公開頁會顯示可讀取的空白狀態。');
    if (media.find((item) => item.isPrimary)) {
      const image = document.createElement('img');
      const primary = media.find((item) => item.isPrimary);
      image.className = 'product-content-preview__media';
      image.src = primary.url;
      image.alt = primary.altText;
      preview.append(image);
    }
    appendText(document, preview, 'h6', '內容區塊');
    if (!projection.sections.length) appendText(document, preview, 'p', '尚未建立內容區塊。');
    else {
      const list = document.createElement('ul');
      for (const section of projection.sections.filter(({ isActive }) => isActive)) {
        const item = document.createElement('li');
        item.textContent = section.title || section.sectionKey;
        list.append(item);
      }
      preview.append(list);
    }
    appendText(document, preview, 'h6', '商品規格');
    if (!projection.specs.length) appendText(document, preview, 'p', '尚未建立商品規格。');
    else {
      const list = document.createElement('ul');
      for (const spec of projection.specs) {
        const item = document.createElement('li');
        item.textContent = `${spec.specLabel}：${spec.specValue}${spec.unit ? ` ${spec.unit}` : ''}`;
        list.append(item);
      }
      preview.append(list);
    }
  }

  function renderAll() {
    fillContentForm(projection.content);
    renderBrandOptions();
    renderSections();
    renderSpecs();
    renderMedia();
    renderBrands();
    renderPreview();
  }

  async function load() {
    if (!currentProduct) return;
    editor.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    setStatus(`正在載入 ${currentLocale()} 商品內容、圖片、規格與品牌…`);
    try {
      const locale = currentLocale();
      const content = await getAdminCatalogProductContent(currentProduct.id, locale).catch((error) => {
        if (error instanceof AdminApiError && error.code === 'CONTENT_NOT_FOUND') return null;
        throw error;
      });
      const [nextMedia, nextBrands, nextProductBrands] = await Promise.all([
        getAdminCatalogProductMedia(currentProduct.id),
        getAdminCatalogBrands(),
        getAdminCatalogProductBrands(currentProduct.id),
      ]);
      projection = content ?? { content: null, sections: [], specs: [] };
      media = nextMedia;
      brands = nextBrands;
      productBrands = nextProductBrands;
      renderAll();
      setValue(brandLinkForm, 'expectedProductVersion', currentProduct.rowVersion);
      setStatus(content
        ? `已載入 ${locale} 的內容投影；預覽只呈現已通過 API 驗證的文字與圖片。`
        : `尚未建立 ${locale} 內容。先填寫標題後儲存，再加入區塊與規格。`);
    } catch (error) {
      if (!(await expireSession(error))) setStatus('載入商品內容失敗。請重新載入，確認工作階段與網路狀態。');
    } finally {
      editor.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function markUnsaved() {
    if (currentProduct && !submissionGate.pending) setStatus('尚有未儲存的內容變更。儲存後才會更新安全預覽。');
  }

  contentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(contentForm, contentErrors);
    setStatus('正在儲存內容與 SEO…');
    try {
      const payload = contentPayload(contentForm);
      const existingVersion = number(contentForm, 'expectedVersion');
      const outcome = await submissionGate.run(() => (
        existingVersion
          ? updateAdminCatalogProductContent(currentProduct.id, payload.locale, {
            title: payload.title,
            summary: payload.summary,
            bodyText: payload.bodyText,
            seoTitle: payload.seoTitle,
            seoDescription: payload.seoDescription,
            expectedVersion: existingVersion,
          })
          : createAdminCatalogProductContent(currentProduct.id, payload)
      ));
      if (!outcome.accepted) return;
      await load();
      setStatus('內容與 SEO 已儲存；安全預覽已更新。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: contentForm, summary: contentErrors, fields: CONTENT_FIELDS, fallback: '儲存內容失敗。',
      });
    }
  });

  sectionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(sectionForm, sectionErrors);
    setStatus('正在儲存展示區塊…');
    try {
      const sectionId = text(sectionForm, 'sectionId');
      const payload = sectionPayload(sectionForm);
      const outcome = await submissionGate.run(() => (
        sectionId
          ? updateAdminCatalogProductSection(currentProduct.id, sectionId, { ...payload, expectedVersion: number(sectionForm, 'expectedVersion') })
          : createAdminCatalogProductSection(currentProduct.id, currentLocale(), payload)
      ));
      if (!outcome.accepted) return;
      resetSectionForm();
      await load();
      setStatus('展示區塊已儲存；可使用排序數字調整公開順序。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: sectionForm, summary: sectionErrors, fields: SECTION_FIELDS, fallback: '儲存展示區塊失敗。',
      });
    }
  });

  specForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(specForm, specErrors);
    setStatus('正在儲存商品規格…');
    try {
      const specId = text(specForm, 'specId');
      const payload = specPayload(specForm);
      const outcome = await submissionGate.run(() => (
        specId
          ? updateAdminCatalogProductSpec(currentProduct.id, specId, { ...payload, expectedVersion: number(specForm, 'expectedVersion') })
          : createAdminCatalogProductSpec(currentProduct.id, currentLocale(), payload)
      ));
      if (!outcome.accepted) return;
      resetSpecForm();
      await load();
      setStatus('商品規格已儲存；公開排序已更新。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: specForm, summary: specErrors, fields: SPEC_FIELDS, fallback: '儲存商品規格失敗。',
      });
    }
  });

  mediaForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(mediaForm, mediaErrors);
    setStatus('正在儲存圖片…');
    try {
      const mediaId = text(mediaForm, 'mediaId');
      const payload = mediaPayload(mediaForm);
      const outcome = await submissionGate.run(() => (
        mediaId
          ? updateAdminCatalogProductMedia(currentProduct.id, mediaId, { ...payload, expectedVersion: number(mediaForm, 'expectedVersion') })
          : createAdminCatalogProductMedia(currentProduct.id, payload)
      ));
      if (!outcome.accepted) return;
      resetMediaForm();
      await load();
      setStatus(payload.isPrimary ? '主圖已更新；先前主圖已安全改為一般圖片。' : '圖片已儲存。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: mediaForm, summary: mediaErrors, fields: MEDIA_FIELDS, fallback: '儲存圖片失敗。',
      });
    }
  });

  brandForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(brandForm, brandErrors);
    setStatus('正在儲存品牌主檔…');
    try {
      const brandId = text(brandForm, 'brandId');
      const payload = brandPayload(brandForm);
      const outcome = await submissionGate.run(() => (
        brandId
          ? updateAdminCatalogBrand(brandId, { ...payload, expectedVersion: number(brandForm, 'expectedVersion') })
          : createAdminCatalogBrand(payload)
      ));
      if (!outcome.accepted) return;
      resetBrandForm();
      await load();
      setStatus('品牌主檔已儲存；可在下方選擇連結至目前商品。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: brandForm, summary: brandErrors, fields: BRAND_FIELDS, fallback: '儲存品牌主檔失敗。',
      });
    }
  });

  brandLinkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    clearFormErrors(brandLinkForm, brandLinkErrors);
    setStatus('正在儲存商品品牌連結…');
    try {
      const linkedBrandId = text(brandLinkForm, 'linkedBrandId');
      const payload = {
        isPrimary: brandLinkForm.elements.namedItem('isPrimary').checked,
        sortOrder: number(brandLinkForm, 'sortOrder'),
        expectedProductVersion: number(brandLinkForm, 'expectedProductVersion'),
      };
      const brandId = linkedBrandId || text(brandLinkForm, 'brandId');
      const outcome = await submissionGate.run(() => (
        linkedBrandId
          ? updateAdminCatalogProductBrand(currentProduct.id, linkedBrandId, payload)
          : createAdminCatalogProductBrand(currentProduct.id, { ...payload, brandId: Number(brandId) })
      ));
      if (!outcome.accepted) return;
      setProductVersion(outcome.value.productRowVersion);
      resetBrandLinkForm();
      await load();
      setStatus('商品品牌連結已儲存；商品版本已更新。');
    } catch (error) {
      if (!(await expireSession(error))) showWriteError({
        error, form: brandLinkForm, summary: brandLinkErrors, fields: BRAND_LINK_FIELDS, fallback: '儲存商品品牌連結失敗。',
      });
    }
  });

  deleteConfirmButton.addEventListener('click', async () => {
    if (!currentProduct || !pendingMediaDelete) return;
    setStatus('正在刪除圖片…');
    try {
      const target = pendingMediaDelete;
      const outcome = await submissionGate.run(() => deleteAdminCatalogProductMedia(
        currentProduct.id, target.id, target.rowVersion,
      ));
      if (!outcome.accepted) return;
      pendingMediaDelete = null;
      deleteDialogController.close();
      await load();
      setStatus('圖片已刪除；安全預覽已移除這個項目。');
    } catch (error) {
      if (!(await expireSession(error))) setStatus(error instanceof AdminApiError ? error.message : '刪除圖片失敗。');
    }
  });

  refreshButton.addEventListener('click', () => { void load(); });
  contentLoadButton.addEventListener('click', () => { void load(); });
  byId(document, 'product-media-primary').addEventListener('change', (event) => {
    if (event.currentTarget.checked) setValue(mediaForm, 'mediaUsage', 'PRIMARY');
  });
  byId(document, 'product-media-usage').addEventListener('change', (event) => {
    setValue(mediaForm, 'isPrimary', event.currentTarget.value === 'PRIMARY');
  });
  for (const button of document.querySelectorAll('[data-product-content-reset]')) {
    button.addEventListener('click', () => {
      const { productContentReset: target } = button.dataset;
      if (target === 'section') resetSectionForm();
      if (target === 'spec') resetSpecForm();
      if (target === 'media') resetMediaForm();
      if (target === 'brand') resetBrandForm();
      if (target === 'brand-link') resetBrandLinkForm();
    });
  }
  for (const form of [contentForm, sectionForm, specForm, mediaForm, brandForm, brandLinkForm]) {
    form.addEventListener('input', markUnsaved);
    form.addEventListener('change', markUnsaved);
  }

  return {
    async setProduct(product) {
      currentProduct = product;
      editor.hidden = false;
      tabsController.select(0);
      projection = { content: null, sections: [], specs: [] };
      media = [];
      brands = [];
      productBrands = [];
      resetContentForm({ keepLocale: true });
      resetSectionForm();
      resetSpecForm();
      resetMediaForm();
      resetBrandForm();
      resetBrandLinkForm();
      preview.replaceChildren();
      await load();
    },
    hide() {
      editor.hidden = true;
      currentProduct = null;
      projection = { content: null, sections: [], specs: [] };
      media = [];
      brands = [];
      productBrands = [];
      pendingMediaDelete = null;
      preview.replaceChildren();
    },
  };
}
