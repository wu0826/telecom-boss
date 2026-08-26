import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { startSeededApplication } from '../helpers/seeded-application.mjs';

async function login(app, id) {
  const response = await fetch(`${app.origin}/api/v1/admin/auth/development-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ staffUserId: id }),
  });
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.data.csrfToken };
}

async function request(app, session, path, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) Object.assign(headers, {
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    'x-csrf-token': session.csrfToken,
  });
  const response = await fetch(`${app.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function seedInventory(path) {
  const database = new DatabaseSync(path);
  const at = '2026-07-21T08:00:00.000Z';
  database.prepare(`INSERT INTO warehouses
    (id, warehouse_code, warehouse_name, address, is_active, created_at, updated_at)
    VALUES (1600, 'WH-NORTH', '北區倉', '臺北市', 1, ?, ?),
      (1601, 'WH-SOUTH', '南區倉', '高雄市', 1, ?, ?)`)
    .run(at, at, at, at);
  database.prepare(`INSERT INTO stock_items
    (id, sku, item_name, item_type, equipment_model_id, unit, standard_cost,
      selling_price, reorder_level, is_active, created_at, updated_at)
    VALUES (1600, 'SKU-ROUTER-A6', 'Archer A6 路由器', 'EQUIPMENT', 1, 'PCS',
      100000, 150000, 2000, 1, ?, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO warehouse_stock
    (id, balance_key, warehouse_id, stock_item_id, quantity_on_hand,
      quantity_reserved, updated_at)
    VALUES (1600, '1600:1600', 1600, 1600, 5000, 1000, ?),
      (1601, '1601:1600', 1601, 1600, 0, 0, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO customers
    (id, customer_no, customer_type, display_name, status, created_at, updated_at)
    VALUES (1600, 'C-INV-1600', 'PERSON', '設備測試客戶', 'ACTIVE', ?, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO service_locations
    (id, location_no, customer_id, city, district, address_line, status, created_at, updated_at)
    VALUES (1600, 'L-INV-1600', 1600, '臺北市', '信義區', '設備路 1 號', 'SERVICEABLE', ?, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO subscriptions
    (id, subscription_no, customer_id, service_location_id, service_plan_id, status,
      monthly_fee, billing_day, auto_renew, created_at, updated_at)
    VALUES (1600, 'SUB-INV-1600', 1600, 1600, 1, 'ACTIVE', 28800, 1, 0, ?, ?)`)
    .run(at, at);
  database.close();
}

function movement(type, overrides = {}) {
  return {
    movementType: type, warehouseId: 1600, targetWarehouseId: null,
    stockItemId: 1600, quantity: '1.000', referenceNo: `REF-${type}`,
    occurredAt: '2026-07-21T12:00:00.000Z', notes: `${type} 測試`,
    ...overrides,
  };
}

test('inventory manager creates master data and reads derived available and low-stock warnings', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  const admin = await login(app, 1);
  const warehouse = await request(app, admin, '/api/v1/admin/inventory/warehouses', {
    method: 'POST', body: { code: 'WH-TEST', name: '測試倉', address: '新北市' },
  });
  assert.equal(warehouse.response.status, 201);
  const item = await request(app, admin, '/api/v1/admin/inventory/items', {
    method: 'POST', body: {
      sku: 'SKU-CABLE-01', name: '光纖跳線', itemType: 'MATERIAL', equipmentModelId: null,
      unit: 'PCS', standardCost: '50.00', sellingPrice: '80.00', reorderLevel: '3.000',
    },
  });
  assert.equal(item.response.status, 201);
  const view = await request(app, admin, '/api/v1/admin/inventory');
  const balance = view.body.data.balances.find(({ warehouse: { id }, item: { id: itemId } }) => (
    id === warehouse.body.data.id && itemId === item.body.data.id
  ));
  assert.equal(balance.onHand, '0.000');
  assert.equal(balance.reserved, '0.000');
  assert.equal(balance.available, '0.000');
  assert.equal(balance.warning, 'LOW_STOCK');
});

test('receipt, issue, transfer, and both adjustment directions reconcile balances and ledger', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedInventory(app.telecomDatabasePath);
  const admin = await login(app, 1);
  for (const payload of [
    movement('RECEIPT', { quantity: '2.000' }),
    movement('ISSUE'),
    movement('TRANSFER', { targetWarehouseId: 1601 }),
    movement('ADJUSTMENT', { adjustmentDirection: 'INCREASE', quantity: '3.000', referenceNo: 'REF-ADJ-IN' }),
    movement('ADJUSTMENT', { adjustmentDirection: 'DECREASE', referenceNo: 'REF-ADJ-OUT' }),
  ]) {
    const response = await request(app, admin, '/api/v1/admin/inventory/movements', { method: 'POST', body: payload });
    assert.equal(response.response.status, 201);
  }
  const view = await request(app, admin, '/api/v1/admin/inventory');
  const north = view.body.data.balances.find(({ warehouse, item }) => warehouse.id === 1600 && item.id === 1600);
  const south = view.body.data.balances.find(({ warehouse, item }) => warehouse.id === 1601 && item.id === 1600);
  assert.equal(north.onHand, '7.000');
  assert.equal(north.available, '6.000');
  assert.equal(south.onHand, '1.000');
  assert.equal(view.body.data.movements.length, 5);
});

test('install and return update customer equipment in the same stock transaction', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedInventory(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const installed = await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('INSTALL', {
      subscriptionId: 1600, serialNo: 'A6-SERIAL-1600', macAddress: 'AA:BB:CC:DD:EE:01',
      ownership: 'COMPANY', referenceNo: 'WO-INSTALL-1600',
    }),
  });
  assert.equal(installed.response.status, 201);
  assert.equal(installed.body.data.equipment.condition, 'IN_USE');
  assert.equal(installed.body.data.balance.onHand, '4.000');
  const returned = await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('RETURN', {
      subscriptionId: 1600, serialNo: 'A6-SERIAL-1600', referenceNo: 'WO-RETURN-1600',
    }),
  });
  assert.equal(returned.response.status, 201);
  assert.equal(returned.body.data.equipment.condition, 'RETURNED');
  assert.equal(returned.body.data.balance.onHand, '5.000');
});

test('negative stock, invalid transfer, replay, concurrency, permission, and audit failure leave no partial balances', async (t) => {
  const app = await startSeededApplication(t, { enableDevelopmentLogin: true });
  seedInventory(app.telecomDatabasePath);
  const admin = await login(app, 1);
  const billing = await login(app, 4);
  assert.equal((await request(app, billing, '/api/v1/admin/inventory')).response.status, 403);
  assert.equal((await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('TRANSFER', { targetWarehouseId: 1600 }),
  })).response.status, 422);
  assert.equal((await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('ISSUE', { quantity: '5.000' }),
  })).response.status, 409);
  const attempts = await Promise.all([
    request(app, admin, '/api/v1/admin/inventory/movements', { method: 'POST', body: movement('ISSUE', { quantity: '4.000', referenceNo: 'CONCURRENT-A' }) }),
    request(app, admin, '/api/v1/admin/inventory/movements', { method: 'POST', body: movement('ISSUE', { quantity: '4.000', referenceNo: 'CONCURRENT-B' }) }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [201, 409]);
  assert.equal((await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('ISSUE', { quantity: '1.000', referenceNo: 'CONCURRENT-A' }),
  })).response.status, 409);

  const database = new DatabaseSync(app.telecomDatabasePath);
  database.exec(`CREATE TRIGGER fail_inventory_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'STOCK_MOVEMENT_RECORDED'
    BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  const before = database.prepare('SELECT quantity_on_hand FROM warehouse_stock WHERE id = 1601').get().quantity_on_hand;
  database.close();
  assert.equal((await request(app, admin, '/api/v1/admin/inventory/movements', {
    method: 'POST', body: movement('RECEIPT', { warehouseId: 1601, referenceNo: 'ROLLBACK-RECEIPT' }),
  })).response.status, 500);
  const verify = new DatabaseSync(app.telecomDatabasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT quantity_on_hand FROM warehouse_stock WHERE id = 1601').get().quantity_on_hand, before);
  assert.equal(Number(verify.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE reference_no = 'ROLLBACK-RECEIPT'").get().count), 0);
  verify.close();
});
