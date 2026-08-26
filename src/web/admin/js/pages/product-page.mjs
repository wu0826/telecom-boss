import {
  AdminApiError,
  archiveAdminCatalogProduct,
  createAdminCatalogCategory,
  createAdminCatalogProduct,
  deleteAdminCatalogProduct,
  getAdminCatalogCategories,
  getAdminCatalogProduct,
  getAdminCatalogProducts,
  moveAdminCatalogCategory,
  publishAdminCatalogProduct,
  updateAdminCatalogCategory,
  updateAdminCatalogProduct,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createDialogController, createStatusBadge } from '../components.mjs?v=20260817-dialog-escape';
import { clearFormErrors, createSubmissionGate, showFormErrors } from '../form-controller.mjs';
import { createProductContentEditor } from './product-content-page.mjs?v=20260824-outage-inline-editor';

const PRODUCT_FIELDS = [
  'productCode', 'slug', 'productName', 'productType', 'sourceId',
  'primaryCategoryId', 'sortOrder', 'isFeatured',
];
const PRODUCT_FIELD_LABELS = {
  productCode: '商品代碼', slug: '網址代稱', productName: '商品名稱', productType: '來源類型',
  sourceId: '來源 ID', primaryCategoryId: '主要分類', sortOrder: '排序', isFeatured: '精選設定',
};
const CATEGORY_FIELDS = [
  'parentId', 'categoryCode', 'slug', 'categoryName', 'description', 'sortOrder', 'isActive',
];
const CATEGORY_FIELD_LABELS = {
  parentId: '上層分類', categoryCode: '分類代碼', slug: '網址代稱', categoryName: '分類名稱',
  description: '說明', sortOrder: '排序', isActive: '啟用設定',
};
const PRODUCT_TYPE_LABELS = new Map([
  ['SERVICE_PLAN', '服務方案'], ['STOCK_ITEM', '庫存品項'], ['GENERAL', '一般商品'],
]);

function value(form, name) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function optionalId(form, name) {
  const raw = value(form, name);
  return raw ? Number(raw) : null;
}

function productPayload(form) {
  const productType = value(form, 'productType');
  return {
    productCode: value(form, 'productCode'),
    slug: value(form, 'slug'),
    productName: value(form, 'productName'),
    productType,
    sourceId: productType === 'GENERAL' ? null : optionalId(form, 'sourceId'),
    primaryCategoryId: Number(value(form, 'primaryCategoryId')),
    sortOrder: Number(value(form, 'sortOrder')),
    isFeatured: form.elements.namedItem('isFeatured').checked,
  };
}

function categoryPayload(form) {
  return {
    parentId: optionalId(form, 'parentId'),
    categoryCode: value(form, 'categoryCode'),
    slug: value(form, 'slug'),
    categoryName: value(form, 'categoryName'),
    description: value(form, 'description') || null,
    sortOrder: Number(value(form, 'sortOrder')),
    isActive: form.elements.namedItem('isActive').checked,
  };
}

function categoryUpdatePayload(form) {
  return {
    expectedVersion: Number(value(form, 'expectedVersion')),
    categoryCode: value(form, 'categoryCode'),
    slug: value(form, 'slug'),
    categoryName: value(form, 'categoryName'),
    description: value(form, 'description') || null,
    sortOrder: Number(value(form, 'sortOrder')),
    isActive: form.elements.namedItem('isActive').checked,
  };
}

function setFormValue(form, name, nextValue) {
  const control = form.elements.namedItem(name);
  if (!control) return;
  if (control.type === 'checkbox') control.checked = Boolean(nextValue);
  else control.value = nextValue ?? '';
}

function appendCell(document, row, content) {
  const cell = document.createElement('td');
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content ?? '—';
  row.append(cell);
}

function actionButton(document, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'table-action';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function sourceText(product) {
  if (!product.source) return '一般商品（無營運來源）';
  return `${PRODUCT_TYPE_LABELS.get(product.source.type) ?? product.source.type}｜${product.source.code}｜${product.source.name}`;
}

function flattenCategories(nodes, depth = 0, result = []) {
  for (const node of nodes) {
    result.push({ ...node, depth });
    flattenCategories(node.children, depth + 1, result);
  }
  return result;
}

function categoryOption(document, category, label) {
  const option = document.createElement('option');
  option.value = String(category.id);
  option.textContent = label;
  return option;
}

function previewField(document, term, description) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = description ?? '—';
  wrapper.append(dt, dd);
  return wrapper;
}

export function createProductPage({
  document,
  page,
  refreshButton,
  filterForm,
  clearButton,
  listStatus,
  results,
  resultsBody,
  categoryTree,
  categoryStatus,
  categorySelected,
  categoryCreateForm,
  categoryCreateErrors,
  categoryCreateStatus,
  categoryEditForm,
  categoryEditErrors,
  categoryEditStatus,
  categoryMoveForm,
  categoryMoveErrors,
  categoryMoveStatus,
  categoryParentSelect,
  categoryMoveParentSelect,
  createForm,
  createErrors,
  createStatus,
  createCategorySelect,
  detail,
  detailClose,
  detailStatus,
  editForm,
  editErrors,
  editCategorySelect,
  preview,
  publishButton,
  archiveButton,
  deleteButton,
  actionDialog,
  actionDialogMessage,
  actionDialogHelp,
  actionCancelButton,
  actionConfirmButton,
  onSessionExpired = () => {},
}) {
  let categoryNodes = [];
  let currentCategory = null;
  let currentProduct = null;
  let detailOpener = null;
  let pendingAction = null;
  const categoryGate = createSubmissionGate();
  const productGate = createSubmissionGate();
  const contentEditor = createProductContentEditor({
    document,
    onSessionExpired,
    onProductVersion(rowVersion) {
      if (!currentProduct) return;
      currentProduct = { ...currentProduct, rowVersion };
      setFormValue(editForm, 'expectedVersion', rowVersion);
    },
  });
  const actionDialogController = createDialogController({
    dialog: actionDialog,
    initialFocus: actionCancelButton,
  });

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired();
      return true;
    }
    return false;
  }

  function categoryRows() {
    return flattenCategories(categoryNodes);
  }

  function descendantIds(categoryId) {
    const match = categoryRows().find(({ id }) => id === categoryId);
    if (!match) return new Set();
    const ids = new Set([categoryId]);
    const visit = (node) => {
      for (const child of node.children) {
        ids.add(child.id);
        visit(child);
      }
    };
    visit(match);
    return ids;
  }

  function renderCategoryOptions(select, { includeInactive = false, excludedIds = new Set() } = {}) {
    const selected = select.value;
    select.replaceChildren();
    const root = document.createElement('option');
    root.value = '';
    root.textContent = '最上層分類';
    select.append(root);
    for (const category of categoryRows()) {
      if ((!includeInactive && !category.isActive) || excludedIds.has(category.id)) continue;
      select.append(categoryOption(document, category, `${'　'.repeat(category.depth)}${category.categoryName}`));
    }
    select.value = selected;
  }

  function renderCategorySelectors() {
    clearFormErrors(categoryEditForm, categoryEditErrors);
    renderCategoryOptions(categoryParentSelect);
    renderCategoryOptions(createCategorySelect);
    renderCategoryOptions(editCategorySelect);
    renderCategoryOptions(categoryMoveParentSelect, {
      excludedIds: currentCategory ? descendantIds(currentCategory.id) : new Set(),
    });
    if (currentCategory) {
      for (const field of CATEGORY_FIELDS.filter((name) => name !== 'parentId')) {
        setFormValue(categoryEditForm, field, currentCategory[field]);
      }
      setFormValue(categoryEditForm, 'expectedVersion', currentCategory.rowVersion);
      setFormValue(categoryMoveForm, 'expectedVersion', currentCategory.rowVersion);
      setFormValue(categoryMoveForm, 'parentId', currentCategory.parentId);
    } else {
      categoryEditForm.reset();
      setFormValue(categoryEditForm, 'expectedVersion', null);
    }
  }

  function renderCategoryTree() {
    categoryTree.replaceChildren();
    const rows = categoryRows();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'product-tree-empty';
      empty.textContent = '尚未建立分類。請先建立最上層分類。';
      categoryTree.append(empty);
      return;
    }
    for (const category of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-tree-item';
      button.dataset.depth = String(category.depth);
      button.setAttribute('role', 'treeitem');
      button.setAttribute('aria-level', String(category.depth + 1));
      button.setAttribute('aria-selected', String(currentCategory?.id === category.id));
      button.textContent = category.categoryName;
      const state = document.createElement('span');
      state.textContent = category.isActive ? '啟用' : '停用';
      state.className = category.isActive ? 'product-tree-item__state' : 'product-tree-item__state is-inactive';
      button.append(state);
      button.addEventListener('click', () => {
        currentCategory = category;
        categorySelected.textContent = `已選：${category.categoryName}`;
        renderCategoryTree();
        renderCategorySelectors();
        categoryEditStatus.textContent = `已載入分類「${category.categoryName}」的詳細內容。`;
        void loadProducts();
      });
      categoryTree.append(button);
    }
  }

  async function loadCategories({ preserveSelection = true } = {}) {
    categoryTree.setAttribute('aria-busy', 'true');
    categoryStatus.textContent = '正在載入分類樹…';
    try {
      categoryNodes = await getAdminCatalogCategories();
      const rows = categoryRows();
      if (!preserveSelection || !rows.some(({ id }) => id === currentCategory?.id)) {
        currentCategory = rows.find(({ isActive }) => isActive) ?? rows[0] ?? null;
      } else {
        currentCategory = rows.find(({ id }) => id === currentCategory.id) ?? null;
      }
      categorySelected.textContent = currentCategory ? `已選：${currentCategory.categoryName}` : '尚未選擇分類';
      renderCategoryTree();
      renderCategorySelectors();
      categoryEditStatus.textContent = currentCategory
        ? `已載入分類「${currentCategory.categoryName}」的詳細內容。`
        : '請先建立或選擇分類。';
      categoryStatus.textContent = rows.length ? `已載入 ${rows.length} 個分類。` : '尚未建立分類。';
    } catch (error) {
      if (!(await expireSession(error))) categoryStatus.textContent = '分類載入失敗，請重新整理。';
    } finally {
      categoryTree.setAttribute('aria-busy', 'false');
    }
  }

  function productSearch() {
    const params = new URLSearchParams();
    const query = value(filterForm, 'q');
    const status = value(filterForm, 'status');
    const productType = value(filterForm, 'productType');
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    if (productType) params.set('productType', productType);
    if (currentCategory) params.set('categoryId', String(currentCategory.id));
    params.set('page', '1');
    params.set('pageSize', '50');
    params.set('sort', 'updatedAt');
    params.set('direction', 'desc');
    return `?${params}`;
  }

  async function loadProducts() {
    results.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    listStatus.textContent = '正在載入商品…';
    try {
      const envelope = await getAdminCatalogProducts(productSearch());
      resultsBody.replaceChildren();
      for (const product of envelope.data) {
        const row = document.createElement('tr');
        appendCell(document, row, product.productCode);
        appendCell(document, row, product.productName);
        appendCell(document, row, sourceText(product));
        appendCell(document, row, product.primaryCategory?.categoryName ?? '未設定');
        appendCell(document, row, createStatusBadge(document, product.status));
        appendCell(document, row, actionButton(document, '管理', (event) => {
          void openDetail(product.id, event.currentTarget);
        }));
        resultsBody.append(row);
      }
      if (!envelope.data.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'table-empty';
        cell.textContent = currentCategory
          ? '這個分類尚未有符合條件的商品。'
          : '沒有符合條件的商品。';
        row.append(cell);
        resultsBody.append(row);
      }
      listStatus.textContent = `本頁 ${envelope.data.length} 筆，共 ${envelope.meta.total} 筆。`;
    } catch (error) {
      if (!(await expireSession(error))) listStatus.textContent = '商品載入失敗，請重新整理。';
    } finally {
      results.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  function fillProductForm(form, product) {
    for (const field of PRODUCT_FIELDS) {
      const nextValue = field === 'sourceId'
        ? product.source?.id ?? null
        : field === 'primaryCategoryId'
          ? product.primaryCategory?.id ?? null
          : product[field];
      setFormValue(form, field, nextValue);
    }
    setFormValue(form, 'expectedVersion', product.rowVersion);
  }

  function renderPreview(product) {
    preview.replaceChildren();
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'CATALOG V2 DATA PREVIEW';
    const heading = document.createElement('h4');
    heading.textContent = product.productName;
    const lead = document.createElement('p');
    lead.textContent = '此為上架主檔摘要；下方內容工作區會管理公開頁的文字、圖片、規格與品牌投影。';
    const fields = document.createElement('dl');
    fields.append(
      previewField(document, '商品代碼', product.productCode),
      previewField(document, '網址代稱', product.slug),
      previewField(document, '主要分類', product.primaryCategory?.categoryName ?? '未設定'),
      previewField(document, '來源', sourceText(product)),
      previewField(document, '狀態', product.status),
      previewField(document, '精選設定', product.isFeatured ? '是' : '否'),
    );
    const status = document.createElement('p');
    status.className = 'product-preview__notice';
    status.textContent = product.status === 'PUBLISHED'
      ? '商品資料已發布；公開 Catalog V2 讀取路徑尚未切換。'
      : '草稿與封存商品不會進入未來的公開 Catalog V2 清單。';
    preview.append(eyebrow, heading, lead, fields, status);
  }

  function updateDetailActions() {
    publishButton.hidden = currentProduct?.status === 'PUBLISHED';
    archiveButton.hidden = currentProduct?.status === 'ARCHIVED';
    deleteButton.disabled = !['DRAFT', 'ARCHIVED'].includes(currentProduct?.status);
    deleteButton.title = deleteButton.disabled ? '請先封存已發布或已排程商品。' : '';
  }

  async function openDetail(productId, opener = detailOpener) {
    detailOpener = opener;
    detail.hidden = false;
    detailStatus.textContent = '正在載入商品主檔…';
    detail.focus();
    try {
      currentProduct = await getAdminCatalogProduct(productId);
      fillProductForm(editForm, currentProduct);
      renderPreview(currentProduct);
      updateDetailActions();
      await contentEditor.setProduct(currentProduct);
      detailStatus.textContent = `目前狀態：${currentProduct.status}。儲存時會檢查版本衝突。`;
    } catch (error) {
      if (!(await expireSession(error))) detailStatus.textContent = '商品明細載入失敗。';
    }
  }

  function closeDetail() {
    detail.hidden = true;
    currentProduct = null;
    editForm.reset();
    clearFormErrors(editForm, editErrors);
    preview.replaceChildren();
    contentEditor.hide();
    detailOpener?.focus();
  }

  function showWriteError({ error, form, summary, allowedFields, fieldLabels, status, fallback }) {
    if (error instanceof AdminApiError) {
      const hasFieldErrors = showFormErrors({
        form,
        summary,
        errors: error.details,
        allowedFields,
        fieldLabels,
      });
      status.textContent = hasFieldErrors ? '請修正標示欄位後再送出。' : error.message;
      return;
    }
    status.textContent = fallback;
  }

  async function refreshAll() {
    await loadCategories();
    await loadProducts();
  }

  async function executeProductAction(action) {
    if (!currentProduct) return;
    const product = currentProduct;
    detailStatus.textContent = action === 'publish'
      ? '正在發布商品…'
      : action === 'archive'
        ? '正在封存商品…'
        : '正在永久刪除商品…';
    try {
      const outcome = await productGate.run(() => {
        if (action === 'publish') {
          return publishAdminCatalogProduct(product.id, { expectedVersion: product.rowVersion });
        }
        if (action === 'archive') return archiveAdminCatalogProduct(product.id, product.rowVersion);
        return deleteAdminCatalogProduct(product.id, product.rowVersion);
      });
      if (!outcome.accepted) return;
      if (action === 'delete') {
        const deletedName = product.productName;
        closeDetail();
        await loadProducts();
        listStatus.textContent = `商品「${deletedName}」已永久刪除。`;
        return;
      }
      currentProduct = outcome.value;
      fillProductForm(editForm, currentProduct);
      renderPreview(currentProduct);
      updateDetailActions();
      detailStatus.textContent = action === 'publish'
        ? '商品已發布；公開讀取路徑切換前仍可在此調整資料。'
        : '商品已封存，公開 Catalog V2 將不會顯示此商品。';
      await loadProducts();
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: editForm, summary: editErrors, allowedFields: PRODUCT_FIELDS,
          fieldLabels: PRODUCT_FIELD_LABELS, status: detailStatus,
          fallback: action === 'delete' ? '永久刪除商品失敗。' : '商品狀態變更失敗。',
        });
      }
    }
  }

  filterForm.addEventListener('submit', (event) => { event.preventDefault(); void loadProducts(); });
  clearButton.addEventListener('click', () => { filterForm.reset(); void loadProducts(); });
  refreshButton.addEventListener('click', () => { void refreshAll(); });
  detailClose.addEventListener('click', closeDetail);

  categoryCreateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    categoryCreateStatus.textContent = '正在建立分類…';
    clearFormErrors(categoryCreateForm, categoryCreateErrors);
    try {
      const outcome = await categoryGate.run(() => createAdminCatalogCategory(categoryPayload(categoryCreateForm)));
      if (!outcome.accepted) return;
      categoryCreateForm.reset();
      setFormValue(categoryCreateForm, 'sortOrder', 0);
      setFormValue(categoryCreateForm, 'isActive', true);
      currentCategory = outcome.value;
      categoryCreateStatus.textContent = `已建立分類「${outcome.value.categoryName}」。`;
      await refreshAll();
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: categoryCreateForm, summary: categoryCreateErrors, allowedFields: CATEGORY_FIELDS,
          fieldLabels: CATEGORY_FIELD_LABELS, status: categoryCreateStatus, fallback: '建立分類失敗。',
        });
      }
    }
  });

  categoryEditForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentCategory) {
      categoryEditStatus.textContent = '請先從分類樹選擇要編輯的分類。';
      return;
    }
    categoryEditStatus.textContent = '正在儲存分類內容…';
    clearFormErrors(categoryEditForm, categoryEditErrors);
    try {
      const outcome = await categoryGate.run(() => updateAdminCatalogCategory(
        currentCategory.id,
        categoryUpdatePayload(categoryEditForm),
      ));
      if (!outcome.accepted) return;
      currentCategory = outcome.value;
      await refreshAll();
      categoryEditStatus.textContent = `分類「${outcome.value.categoryName}」已更新。`;
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: categoryEditForm, summary: categoryEditErrors,
          allowedFields: CATEGORY_FIELDS.filter((field) => field !== 'parentId'),
          fieldLabels: CATEGORY_FIELD_LABELS, status: categoryEditStatus, fallback: '儲存分類內容失敗。',
        });
      }
    }
  });

  categoryMoveForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentCategory) {
      categoryMoveStatus.textContent = '請先從分類樹選擇要移動的分類。';
      return;
    }
    categoryMoveStatus.textContent = '正在移動分類…';
    clearFormErrors(categoryMoveForm, categoryMoveErrors);
    try {
      const outcome = await categoryGate.run(() => moveAdminCatalogCategory(currentCategory.id, {
        expectedVersion: Number(value(categoryMoveForm, 'expectedVersion')),
        parentId: optionalId(categoryMoveForm, 'parentId'),
      }));
      if (!outcome.accepted) return;
      currentCategory = outcome.value;
      categoryMoveStatus.textContent = `已移動分類「${outcome.value.categoryName}」。`;
      await refreshAll();
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: categoryMoveForm, summary: categoryMoveErrors,
          allowedFields: ['parentId'], fieldLabels: CATEGORY_FIELD_LABELS,
          status: categoryMoveStatus, fallback: '移動分類失敗。',
        });
      }
    }
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    createStatus.textContent = '正在建立商品草稿…';
    clearFormErrors(createForm, createErrors);
    try {
      const outcome = await productGate.run(() => createAdminCatalogProduct(productPayload(createForm)));
      if (!outcome.accepted) return;
      createForm.reset();
      setFormValue(createForm, 'productType', 'GENERAL');
      setFormValue(createForm, 'sortOrder', 0);
      createStatus.textContent = `已建立草稿「${outcome.value.productName}」。`;
      await loadProducts();
      await openDetail(outcome.value.id, createForm.querySelector('button[type="submit"]'));
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: createForm, summary: createErrors, allowedFields: PRODUCT_FIELDS,
          fieldLabels: PRODUCT_FIELD_LABELS, status: createStatus, fallback: '建立商品失敗。',
        });
      }
    }
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentProduct) return;
    detailStatus.textContent = '正在儲存商品主檔…';
    clearFormErrors(editForm, editErrors);
    try {
      const payload = { ...productPayload(editForm), expectedVersion: Number(value(editForm, 'expectedVersion')) };
      const outcome = await productGate.run(() => updateAdminCatalogProduct(currentProduct.id, payload));
      if (!outcome.accepted) return;
      currentProduct = outcome.value;
      fillProductForm(editForm, currentProduct);
      renderPreview(currentProduct);
      updateDetailActions();
      await contentEditor.setProduct(currentProduct);
      detailStatus.textContent = '商品主檔已儲存。';
      await loadProducts();
    } catch (error) {
      if (!(await expireSession(error))) {
        showWriteError({
          error, form: editForm, summary: editErrors, allowedFields: PRODUCT_FIELDS,
          fieldLabels: PRODUCT_FIELD_LABELS, status: detailStatus, fallback: '儲存商品主檔失敗。',
        });
      }
    }
  });

  function requestProductAction(action, opener) {
    if (!currentProduct) return;
    if (action === 'delete' && !['DRAFT', 'ARCHIVED'].includes(currentProduct.status)) {
      detailStatus.textContent = '只有草稿或已封存商品可以永久刪除；請先封存目前商品。';
      return;
    }
    pendingAction = action;
    actionDialogMessage.textContent = action === 'publish'
      ? `確定發布「${currentProduct.productName}」嗎？發布前會重新檢查來源與分類。`
      : action === 'archive'
        ? `確定封存「${currentProduct.productName}」嗎？已封存商品不會出現在公開清單。`
        : `確定永久刪除「${currentProduct.productName}」嗎？所有內容、圖片、規格與分類關聯都會一併刪除。`;
    actionDialogHelp.textContent = action === 'delete'
      ? '只有草稿或已封存商品可以永久刪除；此操作無法復原，但會保留稽核紀錄。'
      : '系統會在送出前重新檢查分類與營運來源，且狀態變更會寫入稽核紀錄。';
    actionConfirmButton.textContent = action === 'publish'
      ? '確認發布'
      : action === 'archive'
        ? '確認封存'
        : '確認永久刪除';
    actionConfirmButton.className = action === 'publish' ? 'primary-button' : 'danger-button';
    actionDialogController.open(opener);
  }

  publishButton.addEventListener('click', (event) => requestProductAction('publish', event.currentTarget));
  archiveButton.addEventListener('click', (event) => requestProductAction('archive', event.currentTarget));
  deleteButton.addEventListener('click', (event) => requestProductAction('delete', event.currentTarget));
  actionConfirmButton.addEventListener('click', () => {
    const action = pendingAction;
    pendingAction = null;
    actionDialogController.close();
    if (action) void executeProductAction(action);
  });

  return {
    async show({ productId = null } = {}) {
      page.hidden = false;
      await refreshAll();
      if (productId && /^\d+$/.test(productId)) await openDetail(Number(productId));
    },
    hide() {
      page.hidden = true;
      closeDetail();
    },
  };
}
