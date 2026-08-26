import {
  AdminApiError, createAdminStockItem, createAdminStockMovement,
  createAdminWarehouse, getAdminInventory,
} from '../api-client.mjs?v=20260824-outage-inline-editor';
import { createSubmissionGate } from '../form-controller.mjs';

const MOVEMENT_LABELS = {
  RECEIPT: '收貨', ISSUE: '領用', TRANSFER: '轉倉', ADJUSTMENT: '盤點調整', INSTALL: '客戶安裝', RETURN: '設備拆回',
};
const WARNING_LABELS = { LOW_STOCK: '庫存偏低', NEGATIVE_STOCK: '庫存異常（負數）' };

function numeric(form, name) {
  const value = form.elements.namedItem(name).value;
  return value ? Number(value) : null;
}

function textValue(form, name) {
  return form.elements.namedItem(name).value.trim() || null;
}

export function createInventoryPage({
  document, page, refreshButton, status, balanceBody, itemList, warehouseList,
  movementList, movementForm, movementStatus, itemForm, itemStatus,
  warehouseForm, warehouseStatus, onSessionExpired = () => {},
}) {
  const gate = createSubmissionGate();

  async function expireSession(error) {
    if (error instanceof AdminApiError && error.code === 'AUTHENTICATION_REQUIRED') {
      await onSessionExpired(); return true;
    }
    return false;
  }

  function masterCard(title, detail) {
    const card = document.createElement('article');
    const heading = document.createElement('strong');
    const meta = document.createElement('span');
    heading.textContent = title; meta.textContent = detail;
    card.append(heading, meta); return card;
  }

  function render(data) {
    balanceBody.replaceChildren();
    for (const balance of data.balances) {
      const row = document.createElement('tr');
      const warning = balance.warning ? WARNING_LABELS[balance.warning] : '庫存正常';
      for (const value of [
        `${balance.warehouse.code}｜${balance.warehouse.name}`,
        `${balance.item.sku}｜${balance.item.name}`,
        balance.onHand, balance.reserved, balance.available, warning,
      ]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      if (balance.warning) row.dataset.warning = balance.warning;
      balanceBody.append(row);
    }
    if (!data.balances.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = 6; cell.className = 'table-empty'; cell.textContent = '目前沒有庫存餘額。';
      row.append(cell); balanceBody.append(row);
    }
    itemList.replaceChildren();
    for (const item of data.items) itemList.append(masterCard(`${item.sku}｜${item.name}`, `${item.itemType}｜補貨點 ${item.reorderLevel} ${item.unit}`));
    warehouseList.replaceChildren();
    for (const warehouse of data.warehouses) warehouseList.append(masterCard(`${warehouse.code}｜${warehouse.name}`, warehouse.address ?? '未設定地址'));
    movementList.replaceChildren();
    for (const movement of data.movements) {
      const route = movement.targetWarehouse ? `${movement.warehouse.name} → ${movement.targetWarehouse.name}` : movement.warehouse.name;
      movementList.append(masterCard(
        `${movement.movementNo}｜${MOVEMENT_LABELS[movement.movementType]} ${movement.quantity}`,
        `${route}｜${movement.item.sku}｜${movement.referenceNo}｜${new Date(movement.occurredAt).toLocaleString('zh-TW')}`,
      ));
    }
    if (!data.movements.length) movementList.append(masterCard('尚無庫存異動', '完成收貨、領用或設備作業後會顯示於此。'));
    status.textContent = `共 ${data.items.length} 個品項、${data.warehouses.length} 個倉庫、${data.balances.length} 筆餘額。`;
  }

  async function load() {
    refreshButton.disabled = true; status.textContent = '正在載入庫存…';
    try { render(await getAdminInventory()); }
    catch (error) {
      if (!(await expireSession(error))) status.textContent = error instanceof AdminApiError ? error.message : '庫存載入失敗。';
    } finally { refreshButton.disabled = false; }
  }

  function syncMovementFields() {
    const type = movementForm.elements.namedItem('movementType').value;
    movementForm.querySelector('[data-transfer-fields]').hidden = type !== 'TRANSFER';
    movementForm.querySelector('[data-adjustment-fields]').hidden = type !== 'ADJUSTMENT';
    movementForm.querySelector('[data-equipment-fields]').hidden = !['INSTALL', 'RETURN'].includes(type);
    movementForm.querySelector('[data-install-fields]').hidden = type !== 'INSTALL';
  }

  movementForm.elements.namedItem('movementType').addEventListener('change', syncMovementFields);
  movementForm.addEventListener('submit', async (event) => {
    event.preventDefault(); movementStatus.textContent = '正在執行庫存異動…';
    const type = movementForm.elements.namedItem('movementType').value;
    const body = {
      movementType: type,
      warehouseId: numeric(movementForm, 'warehouseId'), stockItemId: numeric(movementForm, 'stockItemId'),
      quantity: movementForm.elements.namedItem('quantity').value.trim(),
      referenceNo: movementForm.elements.namedItem('referenceNo').value.trim(),
      occurredAt: new Date(movementForm.elements.namedItem('occurredAt').value).toISOString(),
      notes: textValue(movementForm, 'notes'), targetWarehouseId: type === 'TRANSFER' ? numeric(movementForm, 'targetWarehouseId') : null,
    };
    if (type === 'ADJUSTMENT') body.adjustmentDirection = movementForm.elements.namedItem('adjustmentDirection').value;
    if (['INSTALL', 'RETURN'].includes(type)) {
      body.subscriptionId = numeric(movementForm, 'subscriptionId');
      body.serialNo = textValue(movementForm, 'serialNo');
    }
    if (type === 'INSTALL') {
      body.macAddress = textValue(movementForm, 'macAddress');
      body.ownership = movementForm.elements.namedItem('ownership').value;
    }
    try {
      const outcome = await gate.run(() => createAdminStockMovement(body));
      if (!outcome.accepted) return;
      movementStatus.textContent = `已完成 ${outcome.value.movement.movementNo}，可用量 ${outcome.value.balance.available}。`;
      await load();
    } catch (error) {
      if (!(await expireSession(error))) movementStatus.textContent = error instanceof AdminApiError ? error.message : '庫存異動失敗。';
    }
  });
  itemForm.addEventListener('submit', async (event) => {
    event.preventDefault(); itemStatus.textContent = '正在建立庫存品項…';
    try {
      const outcome = await gate.run(() => createAdminStockItem({
        sku: itemForm.elements.namedItem('sku').value.trim(), name: itemForm.elements.namedItem('name').value.trim(),
        itemType: itemForm.elements.namedItem('itemType').value,
        equipmentModelId: numeric(itemForm, 'equipmentModelId'), unit: itemForm.elements.namedItem('unit').value.trim(),
        standardCost: itemForm.elements.namedItem('standardCost').value.trim(),
        sellingPrice: itemForm.elements.namedItem('sellingPrice').value.trim(),
        reorderLevel: itemForm.elements.namedItem('reorderLevel').value.trim(),
      }));
      if (!outcome.accepted) return;
      itemForm.reset(); itemStatus.textContent = `已建立 ${outcome.value.sku}。`; await load();
    } catch (error) {
      if (!(await expireSession(error))) itemStatus.textContent = error instanceof AdminApiError ? error.message : '庫存品項建立失敗。';
    }
  });
  warehouseForm.addEventListener('submit', async (event) => {
    event.preventDefault(); warehouseStatus.textContent = '正在建立倉庫…';
    try {
      const outcome = await gate.run(() => createAdminWarehouse({
        code: warehouseForm.elements.namedItem('code').value.trim(),
        name: warehouseForm.elements.namedItem('name').value.trim(),
        address: textValue(warehouseForm, 'address'),
      }));
      if (!outcome.accepted) return;
      warehouseForm.reset(); warehouseStatus.textContent = `已建立 ${outcome.value.code}。`; await load();
    } catch (error) {
      if (!(await expireSession(error))) warehouseStatus.textContent = error instanceof AdminApiError ? error.message : '倉庫建立失敗。';
    }
  });
  refreshButton.addEventListener('click', load);
  syncMovementFields();

  return {
    async show() { page.hidden = false; await load(); },
    hide() { page.hidden = true; },
  };
}
