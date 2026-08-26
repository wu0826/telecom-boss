# 洋基電信官方商品展示網站

這是一套資料庫驅動的電信商品官網與營運後台。開發／測試環境可使用 SQLite 相容 adapter；正式環境預設使用 MySQL 8，透過 `mysql2/promise` Connection Pool 存取 `website_db` 與 `telecom_boss`。公開首頁預設讀取 Catalog V2 的已發布服務與商品、價格、促銷、內容、規格與品牌，訪客可比較內容、查看詳情並送出申裝洽詢。

## 技術與資料來源

- Node.js 24：原生 `node:http`、ES modules。
- MySQL 8：正式 Runtime 使用 `mysql2/promise` Connection Pool；應用程式帳號只需 DML 權限。
- SQLite：保留給本機開發、migration/seed 與 regression tests 的相容 adapter。
- 前端：語意化 HTML、CSS、原生瀏覽器 JavaScript。
- `website_db`：12 表中繼資料庫。
- `telecom_boss`：既有 39 表營運核心，再加 Catalog V2 的 10 張擴充表。
- Runtime 第三方 dependency：`mysql2`。

## 第一次啟動

需要 Node.js 24 以上版本。第一次先安裝 dependency：

```powershell
npm install
npm run check
```

本機 SQLite 開發模式可執行：

```powershell
npm run db:migrate
npm run db:seed
$env:DB_DRIVER='sqlite'
npm start
```

開啟 <http://127.0.0.1:4173/>。開發期間需要自動重啟時可改用：

```powershell
npm run dev
```

目前這台電腦上的展示服務已在 `127.0.0.1:4173` 執行。

## 常用指令

| 指令 | 用途 |
|---|---|
| `npm run check` | 驗證 Schema 快照計數與允許的 Runtime dependency |
| `npm run db:migrate` | 在空白 `database/data/` 建立兩個 SQLite DB |
| `npm run db:seed` | 可重複執行地匯入中繼資料與 24 筆參考資料 |
| `npm run schema:export:csmu` | 產生唯讀、待審核的 CSMU Catalog V2 metadata 產物 |
| `npm test` | 執行單元、Migration、Seed、API 與安全整合測試 |
| `npm start` | 依 `DB_DRIVER` 啟動 Runtime；production 未指定時預設 MySQL |
| `npm run dev` | 使用 Node watch mode 啟動開發模式 |

## 正式 MySQL Runtime

正式環境設定範例位於 `deploy/env/telecom-site.env.example`。至少需要：

```text
NODE_ENV=production
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=intern
DB_PASSWORD=<runtime password>
WEBSITE_DB_NAME=website_db
TELECOM_DB_NAME=telecom_boss
DB_CONNECTION_LIMIT=10
DB_TRANSACTION_LOCK_TIMEOUT=15
PORT=4173
ENABLE_DEVELOPMENT_LOGIN=false
```

正式 Runtime 的 Repository、Service 與 Route 都使用非同步資料存取。寫入交易會取得專用 MySQL connection，並以 server-side named lock 保護目前仍需序列化的跨表寫入流程；成功 commit 或失敗 rollback 後都會釋放 lock 與 connection。Server 關閉時會結束兩個 MySQL pools。Production 明確拒絕 `DB_DRIVER=sqlite`、`ENABLE_DEVELOPMENT_LOGIN=true` 與 `DB_USER=intern_migrate`。

MySQL Runtime 在開始監聽 127.0.0.1:4173 前會執行 readiness gate：`website_db` 必須包含 `create_metadata_schema`；`telecom_boss` 必須同時包含 `create_telecom_schema` 與 `create_catalog_v2_schema`。任一 pool 無法連線或 migration 不完整時，服務會 fail-fast 並關閉兩個 pool，不會以半可用狀態接受流量。`/api/v1/health` 使用同一套條件。

Catalog V2 的 MySQL v2 migration 操作方式請看 `docs/mysql-catalog-v2-migration.md`。Runtime adapter 與第 3 步轉換細節請看 `docs/mysql-runtime-step3.md`。

## 公開功能

- 官方首頁與品牌主視覺。
- 資料庫驅動的服務／商品卡、價格、優惠、內容、規格、品牌與安全圖片。
- 響應式服務與商品比較表，以及鍵盤可操作的商品詳情對話框。
- 具欄位驗證、錯誤摘要、送件狀態與成功編號的申裝表單。
- 實際寫入 `service_inquiries` 的交易式申裝 API。

### 公開商品頁切換與回復

公開首頁預設使用 Catalog V2。驗證期間如需切回舊版方案投影，不需要回復資料庫或重新部署，直接開啟 <http://127.0.0.1:4173/?catalog=legacy>；移除 `?catalog=legacy` 後即回到 Catalog V2。這個切換僅改變瀏覽器讀取路徑，兩者都保持唯讀。

### 服務與商品展示網址

- 首頁服務入口：<http://127.0.0.1:4173/#services>
- 商品目錄：<http://127.0.0.1:4173/products/catalog.html>
- 通用商品詳情：`/products/detail.html?product={公開商品 slug}`
- 固定寬頻方案頁：`/products/services-broadband/plan-vdsl2-100m.html`、`plan-ftth-300m.html`、`plan-ftth-500m.html`
- 服務頁：`/services/fiber-broadband.html`、`enterprise-connectivity.html`、`subscription-rental.html`、`low-voltage-engineering.html`、`av-integration.html`

上述頁面共用頁首、頁尾、設計 token 與詢價契約；固定 `.html` 路徑不複製商品資料，而是只讀既有公開 Catalog V2 API。跨頁詢價會保留經驗證的 `intent`／`product` URL 上下文並帶回首頁 `#apply`；手機專用視覺優化仍依使用者指示暫停。

API 合約請看 [docs/api.openapi.json](docs/api.openapi.json)，系統與資料流說明請看 [docs/system-description.md](docs/system-description.md)。

CSMU Catalog V2 的本機匯出與遠端核准門檻請看 [docs/csmu-catalog-export.md](docs/csmu-catalog-export.md)；此命令不會連線或寫入 CSMU。

## 後台 Catalog V2 管理

- 從商品分類樹選取分類後，可修改代碼、網址 slug、名稱、排序、啟用狀態與詳細說明；上層分類仍使用獨立的「移動分類」操作。
- 商品永久刪除只允許 `DRAFT`（草稿）或 `ARCHIVED`（已封存）狀態，已發布或排程中的商品必須先封存。
- 分類更新與商品刪除都需要 `catalog.manage` 權限、CSRF 驗證及目前資料版本；版本衝突時必須重新載入，不會覆蓋他人的修改。
- 永久刪除會在同一筆交易中移除商品及其 Catalog V2 關聯內容並留下稽核紀錄；正式環境操作前仍應先完成資料庫備份。

## 資料庫備份與回復

Migration 不會直接覆寫現有 DB。重新建立前必須指定兩個新的備份檔案：

```powershell
npm run db:migrate -- `
  --metadata-backup database/backups/website_db.before-remigrate.sqlite `
  --telecom-backup database/backups/telecom_boss.before-remigrate.sqlite
```

### 增量 Telecom Migration

`db:migrate` 對 `telecom_boss.sqlite` 採安全分流：

- 資料庫不存在時，才會依原始 snapshot 建立基礎 schema。
- 資料庫已存在時，只會檢查 `_schema_migrations` 並套用尚未執行的連續版本，不再刪除或重建既有 telecom 資料庫。
- 沒有待執行版本時為 no-op，不需要建立新備份。
- 有待執行版本時必須提供尚不存在的 `--telecom-backup` 路徑；系統會在交易開始後建立並驗證 SHA-256 完全一致的備份，才允許變更 schema。
- 版本重複、缺號、順序錯誤、歷史名稱不一致、完整性或外鍵檢查失敗時，一律停止並回復該次交易。

執行 migration 前應先停止本機伺服器。`website_db.sqlite` 目前仍沿用原本的重建流程，因此既有環境仍須同時提供 `--metadata-backup`。需要復原時，先確認應用程式已停止，再依下方的 PowerShell 備份還原步驟操作。

備份檔已被 `.gitignore` 排除。回復時先停止本機伺服器，確認目標都在本專案的 `database/data/` 後，再使用同一個 PowerShell 工作階段：

```powershell
$projectRoot = (Resolve-Path .).Path
$dataDirectory = (Resolve-Path (Join-Path $projectRoot 'database/data')).Path
$backupDirectory = (Resolve-Path (Join-Path $projectRoot 'database/backups')).Path

Copy-Item -LiteralPath (Join-Path $backupDirectory 'website_db.before-remigrate.sqlite') `
  -Destination (Join-Path $dataDirectory 'website_db.sqlite') -Force
Copy-Item -LiteralPath (Join-Path $backupDirectory 'telecom_boss.before-remigrate.sqlite') `
  -Destination (Join-Path $dataDirectory 'telecom_boss.sqlite') -Force
```

回復後先執行 `npm test`，再啟動伺服器並檢查 <http://127.0.0.1:4173/api/v1/health>。

## 安全邊界

- Node Runtime 預設只綁定 `127.0.0.1`；正式對外流量應由 Apache／HTTPS reverse proxy 轉送。
- 公開 API 使用固定 DTO，不提供任意資料表查詢。
- 申裝欄位採 allowlist、prepared statements、Transaction、body 上限、跨站檢查、蜜罐欄位、頻率限制與持久化冪等。
- 回應與前端成功畫面不回顯電話、信箱或地址。
- 正式上線仍需反向代理 HTTPS、正式網域、隱私政策、監控與備援。

## 測試資料

本機資料庫可能包含瀏覽器驗收建立的 `WEB-` 洽詢資料。它屬於展示資料，不應複製到正式環境。

## Production smoke / host verification

部署到 MySQL Production 後，依序執行：

```bash
npm run smoke:mysql
npm run smoke:http
npm run verify:host
```

`smoke:mysql` 會驗證 MySQL readiness、代表性資料表讀取，以及一筆會強制 rollback 的 Catalog 寫入探針；成功後不得留下測試資料。`smoke:http` 會驗證 health、Catalog V2 與未登入 Admin bootstrap。`verify:host` 為唯讀主機檢查，涵蓋 systemd、Apache、loopback 4173 socket 與最近服務日誌。

Production Admin password authentication 已於 Step 7 完成：使用 Node.js 24 內建 Argon2id、獨立 `staff_password_credentials`、帳號/IP 登入限制、既有 Session/RBAC 與 Production `Secure` Cookie。部署前須套用 MySQL migration v3 並使用 `scripts/admin-password.mjs` 為既有啟用中的 staff account 設定初始密碼。詳見 `docs/production-admin-auth-step7.md`。
