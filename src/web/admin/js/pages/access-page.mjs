import {
  AdminApiError, createAdminStaff, deleteAdminStaff, getAdminAccess, getAdminAudit, getAdminAuditDetail,
  replaceAdminStaffRoles, updateAdminStaff,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createDialogController } from '../components.mjs';
import {
  clearFormErrors, createSubmissionGate, showFormErrors,
} from '../form-controller.mjs?v=20260722-field-errors';

function value(form, name) { return form.elements.namedItem(name).value.trim(); }

const CREATE_FIELDS = ['staffNo', 'email', 'displayName', 'department', 'authProvider', 'providerSubject', 'roleIds'];
const CREATE_FIELD_LABELS = {
  staffNo: '人員編號', email: 'Email', displayName: '顯示名稱', department: '部門',
  authProvider: '身分提供者', providerSubject: '身分識別值', roleIds: '初始角色',
};
const STAFF_NO_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER_SUBJECT_PATTERN = /^[^\s\u0000-\u001f\u007f]{2,191}$/;
const AUTH_PROVIDERS = new Set(['GOOGLE', 'LDAP', 'OTHER']);

function inputText(input, field) { return typeof input?.[field] === 'string' ? input[field].trim() : ''; }

export function validateStaffCreation(input) {
  const errors = [];
  const staffNo = inputText(input, 'staffNo');
  const email = inputText(input, 'email');
  const displayName = inputText(input, 'displayName');
  const department = inputText(input, 'department');
  const authProvider = inputText(input, 'authProvider');
  const providerSubject = inputText(input, 'providerSubject');
  if (!STAFF_NO_PATTERN.test(staffNo)) errors.push({
    field: 'staffNo', message: '請使用 2 至 32 碼大寫英數字、連字號或底線，例如 DEV-OPS。',
  });
  if (!EMAIL_PATTERN.test(email) || email.length > 191) errors.push({
    field: 'email', message: '請輸入完整 Email，例如 name@example.com。',
  });
  if (!displayName || displayName.length > 100) errors.push({
    field: 'displayName', message: '請輸入顯示名稱，最多 100 字。',
  });
  if (department.length > 100) errors.push({ field: 'department', message: '部門最多 100 字，請縮短內容。' });
  if (!AUTH_PROVIDERS.has(authProvider)) errors.push({
    field: 'authProvider', message: '請選擇 GOOGLE、LDAP 或 OTHER。',
  });
  if (!PROVIDER_SUBJECT_PATTERN.test(providerSubject)) errors.push({
    field: 'providerSubject',
    message: providerSubject
      ? '不可包含空白；本機測試可使用 dev:operations。'
      : '請輸入身分識別值；本機測試可使用 dev:operations。',
  });
  if (!Array.isArray(input?.roleIds) || input.roleIds.length === 0) errors.push({
    field: 'roleIds', message: '請至少選擇一個已啟用的初始角色。',
  });
  return errors;
}

export function createAccessPage({
  document, page, status, refreshButton, administration, staffList, roleMatrix,
  createPanel, createForm, createErrors, createRoles, profileForm, roleForm,
  deleteZone, deleteButton, deleteHelp, deleteDialog, deleteMessage,
  deleteCancelButton, deleteConfirmButton,
  auditSection, auditForm, auditList, auditDetail,
  onSessionExpired = () => {},
}) {
  const gate = createSubmissionGate();
  let matrix = null; let selected = null; let canManageRoles = false; let signedInUserId = null;
  const deletionDialog = createDialogController({ dialog: deleteDialog, initialFocus: deleteCancelButton });

  function focusStatus() { globalThis.requestAnimationFrame?.(() => status.focus()); }

  function updateDeleteControls(staff = null) {
    const isSelf = staff?.id === signedInUserId;
    deleteZone.hidden = !staff || !canManageRoles;
    deleteButton.hidden = !staff || !canManageRoles;
    deleteButton.disabled = Boolean(isSelf);
    deleteHelp.textContent = isSelf
      ? '目前登入中的本人帳號不可刪除。'
      : '只有尚未登入且沒有受保留營運紀錄的新帳號可刪除；其他帳號請改為停用。';
  }

  function showCreationErrors(errors) {
    const shown = showFormErrors({
      form: createForm, summary: createErrors, errors,
      allowedFields: CREATE_FIELDS, fieldLabels: CREATE_FIELD_LABELS,
    });
    if (shown) status.textContent = '資料尚未建立，請依紅色提示修正欄位。';
    return shown;
  }

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired(); return true;
    }
    return false;
  }

  function renderRoleMatrix() {
    roleMatrix.replaceChildren();
    for (const role of matrix.roles) {
      const card = document.createElement('article');
      const heading = document.createElement('strong'); heading.textContent = role.roleName;
      const code = document.createElement('code'); code.textContent = role.roleCode;
      const permissions = document.createElement('p');
      permissions.textContent = role.permissionCodes.length ? role.permissionCodes.join(' · ') : '無權限';
      card.append(heading, code, permissions); roleMatrix.append(card);
    }
  }

  function renderCreateRoles() {
    createRoles.replaceChildren();
    const legend = document.createElement('legend'); legend.textContent = '初始角色（至少一個）';
    createRoles.append(legend);
    for (const role of matrix.roles.filter(({ isActive }) => isActive)) {
      const label = document.createElement('label'); label.className = 'checkbox-field';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'roleIds'; input.value = role.id;
      label.append(input, document.createTextNode(`${role.roleName}（${role.roleCode}）`));
      createRoles.append(label);
    }
  }

  function selectStaff(staff) {
    selected = staff;
    profileForm.elements.namedItem('displayName').value = staff.displayName;
    profileForm.elements.namedItem('department').value = staff.department ?? '';
    profileForm.elements.namedItem('isActive').checked = staff.isActive;
    profileForm.elements.namedItem('expectedUpdatedAt').value = staff.updatedAt;
    roleForm.elements.namedItem('expectedUpdatedAt').value = staff.updatedAt;
    roleForm.querySelector('fieldset').replaceChildren();
    const selectedIds = new Set(staff.roles.map(({ id }) => id));
    for (const role of matrix.roles.filter(({ isActive }) => isActive)) {
      const label = document.createElement('label'); label.className = 'checkbox-field';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'roleIds';
      input.value = role.id; input.checked = selectedIds.has(role.id); input.disabled = !canManageRoles;
      label.append(input, document.createTextNode(`${role.roleName}（${role.roleCode}）`));
      roleForm.querySelector('fieldset').append(label);
    }
    roleForm.querySelector('button').hidden = !canManageRoles;
    updateDeleteControls(staff);
    status.textContent = `正在檢視 ${staff.displayName}。`;
  }

  function renderStaff() {
    staffList.replaceChildren();
    for (const staff of matrix.staff) {
      const card = document.createElement('article');
      const copy = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = staff.displayName;
      const meta = document.createElement('small');
      meta.textContent = `${staff.staffNo} · ${staff.department ?? '未設定部門'} · ${staff.isActive ? '啟用' : '停用'} · ${staff.roles.map(({ roleName }) => roleName).join('、') || '無角色'}`;
      copy.append(name, meta);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '管理';
      button.addEventListener('click', () => selectStaff(staff));
      card.append(copy, button); staffList.append(card);
    }
    renderCreateRoles(); renderRoleMatrix();
  }

  async function loadMatrix() {
    matrix = await getAdminAccess(); renderStaff();
    if (selected) {
      const refreshed = matrix.staff.find(({ id }) => id === selected.id);
      if (refreshed) selectStaff(refreshed);
    }
  }

  function auditCard(record) {
    const card = document.createElement('article');
    const copy = document.createElement('div');
    const heading = document.createElement('strong'); heading.textContent = record.action;
    const meta = document.createElement('small');
    meta.textContent = `${record.entityType}${record.entityId ? ` #${record.entityId}` : ''} · ${record.actor?.displayName ?? '系統'} · ${new Date(record.createdAt).toLocaleString('zh-TW')}`;
    copy.append(heading, meta);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '查看';
    button.addEventListener('click', async () => {
      try {
        const detail = await getAdminAuditDetail(record.id); auditDetail.replaceChildren();
        const title = document.createElement('h3'); title.textContent = detail.action;
        const summary = document.createElement('p'); summary.textContent = `${detail.entityType} · Request ${detail.requestId ?? '無'}`;
        const changes = document.createElement('pre');
        changes.textContent = JSON.stringify({ before: detail.before, after: detail.after }, null, 2);
        auditDetail.append(title, summary, changes); auditDetail.focus();
      } catch (error) { if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '稽核明細載入失敗。'; }
    });
    card.append(copy, button); return card;
  }

  async function loadAudits() {
    const params = new URLSearchParams();
    for (const name of ['action', 'entityType', 'actorStaffUserId']) {
      const item = value(auditForm, name); if (item) params.set(name, item);
    }
    params.set('page', '1'); params.set('pageSize', '25');
    const result = await getAdminAudit(`?${params}`);
    auditList.replaceChildren();
    for (const record of result.data) auditList.append(auditCard(record));
    if (!result.data.length) { const empty = document.createElement('p'); empty.className = 'table-empty'; empty.textContent = '沒有符合條件的稽核紀錄。'; auditList.append(empty); }
    status.textContent = `稽核查詢共 ${result.meta.total} 筆，顯示前 ${result.data.length} 筆。`;
  }

  async function load({ canManageAccess, canReadAudit }) {
    refreshButton.disabled = true; status.textContent = '正在載入存取控制資料…';
    try {
      if (canManageAccess) await loadMatrix();
      if (canReadAudit) await loadAudits();
      if (canManageAccess && !canReadAudit) status.textContent = `已載入 ${matrix.staff.length} 位後台人員。`;
    } catch (error) { if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '存取控制資料載入失敗。'; }
    finally { refreshButton.disabled = false; }
  }

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!canManageRoles) return;
    const assignedRoleIds = [...createRoles.querySelectorAll('[name="roleIds"]:checked')]
      .map(({ value: id }) => Number(id));
    const payload = {
      staffNo: value(createForm, 'staffNo'),
      email: value(createForm, 'email'),
      displayName: value(createForm, 'displayName'),
      department: value(createForm, 'department') || null,
      authProvider: value(createForm, 'authProvider'),
      providerSubject: value(createForm, 'providerSubject'),
      isActive: createForm.elements.namedItem('isActive').checked,
      roleIds: assignedRoleIds,
    };
    clearFormErrors(createForm, createErrors);
    if (showCreationErrors(validateStaffCreation(payload))) return;
    try {
      const outcome = await gate.run(() => createAdminStaff(payload));
      if (!outcome.accepted) return;
      selected = outcome.value; clearFormErrors(createForm, createErrors); createForm.reset(); createPanel.open = false;
      await loadMatrix(); status.textContent = `已建立 ${selected.displayName}，並完成初始角色指派。`;
    } catch (error) {
      if (await expireSession(error)) return;
      if (error instanceof AdminApiError && showCreationErrors(error.details)) return;
      status.textContent = error instanceof AdminApiError ? error.message : '建立人員失敗。';
    }
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!selected) return;
    try {
      const outcome = await gate.run(() => updateAdminStaff(selected.id, {
        displayName: value(profileForm, 'displayName'), department: value(profileForm, 'department') || null,
        isActive: profileForm.elements.namedItem('isActive').checked,
        expectedUpdatedAt: value(profileForm, 'expectedUpdatedAt'),
      }));
      if (!outcome.accepted) return; status.textContent = '人員資料已更新，相關工作階段已撤銷。'; await loadMatrix();
    } catch (error) { if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '人員資料更新失敗。'; }
  });
  roleForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!selected || !canManageRoles) return;
    const roleIds = [...roleForm.querySelectorAll('[name="roleIds"]:checked')].map(({ value: id }) => Number(id));
    try {
      const outcome = await gate.run(() => replaceAdminStaffRoles(selected.id, {
        roleIds, expectedUpdatedAt: value(roleForm, 'expectedUpdatedAt'),
      }));
      if (!outcome.accepted) return; status.textContent = '角色已更新，目標人員工作階段已撤銷。'; await loadMatrix();
    } catch (error) { if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '角色更新失敗。'; }
  });
  deleteButton.addEventListener('click', () => {
    if (!selected || deleteButton.disabled) return;
    deleteMessage.textContent = `將永久刪除 ${selected.displayName}（${selected.staffNo}）及其角色指派。此操作無法復原。`;
    deletionDialog.open(deleteButton);
  });
  deleteConfirmButton.addEventListener('click', async () => {
    if (!selected || deleteButton.disabled) return;
    deleteConfirmButton.disabled = true;
    const deletedName = selected.displayName;
    try {
      const outcome = await gate.run(() => deleteAdminStaff(selected.id, selected.updatedAt));
      if (!outcome.accepted) return;
      deletionDialog.close(); selected = null; profileForm.reset(); roleForm.reset();
      roleForm.querySelector('fieldset').replaceChildren(); updateDeleteControls();
      await loadMatrix(); status.textContent = `已刪除 ${deletedName}。`; focusStatus();
    } catch (error) {
      deletionDialog.close();
      if (await expireSession(error)) return;
      if (error instanceof AdminApiError && error.code === 'STAFF_CONFLICT') await loadMatrix();
      status.textContent = error instanceof AdminApiError ? error.message : '刪除人員失敗。';
      focusStatus();
    } finally { deleteConfirmButton.disabled = false; }
  });
  auditForm.addEventListener('submit', async (event) => { event.preventDefault(); try { await loadAudits(); } catch (error) { if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '稽核查詢失敗。'; } });

  return {
    async show({ canManageAccess = false, canManageRoles: manageRoles = false, canReadAudit = false, currentUserId = null } = {}) {
      canManageRoles = manageRoles; signedInUserId = currentUserId;
      page.hidden = false; administration.hidden = !canManageAccess; updateDeleteControls(selected);
      createPanel.hidden = !canManageRoles; auditSection.hidden = !canReadAudit;
      refreshButton.onclick = () => load({ canManageAccess, canReadAudit });
      await load({ canManageAccess, canReadAudit });
    },
    hide() { page.hidden = true; },
  };
}
