# MySQL Production Runtime — Step 5

## 目的

本步驟把 Admin、Catalog V2、CMS、訂單、帳務及公開 API 接回正式 MySQL Runtime 啟動流程，並讓服務在接受 HTTP 流量前先確認資料庫可用且 migration 完整。

## Production 啟動規則

- `NODE_ENV=production` 時只允許 `DB_DRIVER=mysql`。
- Production 禁止 `ENABLE_DEVELOPMENT_LOGIN=true`。
- Runtime 禁止使用 migration 高權限帳號 `intern_migrate`；正式應用帳號使用 `intern`。
- Server 維持只監聽 `127.0.0.1`，由 Apache reverse proxy 對外服務。

## Readiness gate

在 `server.listen()` 前，Runtime 會確認：

- `website_db` 可以連線，且 `_schema_migrations` 包含 `create_metadata_schema`。
- `telecom_boss` 可以連線，且 `_schema_migrations` 同時包含：
  - `create_telecom_schema`
  - `create_catalog_v2_schema`

若任何檢查失敗：

1. 不開始監聽 HTTP port。
2. 關閉已建立的兩個 MySQL pool。
3. 將啟動錯誤交給 systemd 記錄並依服務策略處理。

這避免舊狀況：health 只看到 v1 正常，但 `/api/v1/catalog/products` 因缺 Catalog V2 table 才回 500。

## Health endpoint

`GET /api/v1/health` 與 startup readiness 使用相同 migration 條件。只有兩個 database 都通過時才回 HTTP 200；任一失敗回 HTTP 503，且不暴露 DB password、檔案路徑或 stack trace。

## Runtime lifecycle

```text
load env
  -> validate production guardrails
  -> create website_db pool
  -> create telecom_boss pool
  -> readiness gate
  -> start HTTP server on 127.0.0.1:4173
  -> serve public/admin/API traffic
  -> SIGTERM/SIGINT
  -> stop HTTP server
  -> close both MySQL pools
```

## 建議部署前順序

1. 建立並驗證 MySQL 備份。
2. 使用 `intern_migrate` 執行 `npm run db:migrate:mysql:dry`。
3. 使用 `intern_migrate` 執行 `npm run db:migrate:mysql`。
4. 確認 migration v2 已登記。
5. 切回 Runtime env，`DB_USER=intern`。
6. 啟動 systemd service。
7. 驗證 `/api/v1/health`。
8. 驗證 Catalog、Admin login、訂單／帳務只讀 smoke test，再做受控寫入測試。

## 尚未完成的驗證

目前測試環境沒有連上正式 VM 的 MySQL 8，因此尚未完成真實 MySQL network/pool CRUD smoke test。這應在 staging 或正式 VM 的受控部署窗口執行。
