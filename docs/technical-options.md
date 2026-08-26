# 技術選型比較

## 狀態

`ACCEPTED — REVISED` — 使用者於 2026-07-20 保留部署選項 A（本機 Node.js＋SQLite），並將前端修正為面向消費者的電信官方商品展示網站。本文件保留其他部署方案的第二階段移植依據。

## 已驗證的現況

| 項目 | 現況 | 對實作的影響 |
|---|---|---|
| Node.js | 24.14.0，可執行 | 可建立零第三方 Runtime 依賴的本機 API |
| SQLite | Node `node:sqlite` 可連線，SQLite 3.51.2 | 可立即建立實體測試資料庫，但 Node API仍有 ExperimentalWarning |
| npm | 11.9.0，可執行 | 若選第三方框架，安裝前仍需使用者允許 |
| PHP | 未安裝 | 無法在目前工作區直接執行或測試 PHP 後端 |
| MySQL CLI | 未安裝 | 無法直接以 CLI 驗證遠端或本機 MySQL |
| Docker CLI | 29.6.1，可執行 | 可準備 MySQL 容器，但前端後端仍需 MySQL Driver |
| 現有網站原始碼 | 工作區中未找到 | 目前不能安全修改 `manage_boss_schema.php` 或直接整合既有 PHP |
| 遠端 Schema 管理頁 | 已登入並可讀取 | 可作為參考及匯入／匯出驗證，不等同有部署權限 |
| `website_db` 快照 | 6 群組、12 表、106 欄位、7 筆種子 | 可作為中繼資料與動態 UI 的權威參考 |
| `telecom_boss` 快照 | 8 群組、39 表、421 欄位、64 關聯 | 可作為電信營運資料庫的權威參考 |

## 選項 A：本機 Node.js＋SQLite（建議先做）

### 交付方式

- 建立獨立的 `telecom-boss-app`。
- 前端以原生 HTML、CSS、ES Modules 實作。
- 後端以 Node.js 內建 HTTP Server 實作 REST API。
- `website_db.sqlite` 保存中繼資料，`telecom_boss.sqlite` 保存業務資料。
- 保留固定 API DTO、Schema 快照與交易測試，作為後續 MySQL 8 移植依據。

### 優點

- 不需安裝 PHP、MySQL 或 npm 套件即可開始。
- 可以在目前環境實際跑 DB、公開商品 API、申裝交易、測試及瀏覽器驗證。
- 不需遠端資料庫帳密，不會影響既有正式網站。
- 適合先確認功能、畫面、資料流程與 API 合約。

### 限制

- `node:sqlite` 在目前 Node 版本會顯示實驗性警告，不宜未評估就直接作為長期正式 Runtime。
- SQLite 是單寫入者架構，正式公開網站仍建議使用 MySQL／PostgreSQL。
- 正式 SSO、網路開通、金流及通知整合只能保留介面與模擬資料。

### 風險控制

- 僅監聽 `127.0.0.1`。
- Runtime DB 放在 Git ignored 目錄。
- Migration 不提供靜默刪除功能。
- 金額以整數分保存；所有 SQL 使用 prepared statement。

## 選項 B：直接整合 PHP＋MySQL 網站

### 需要的前置資料

- `csmu.yankees.net.tw` 對應的 PHP 專案原始碼工作區。
- PHP 與 Composer 執行環境，或可重現的 Docker 設定。
- MySQL 版本、測試資料庫及 Migration 慣例。
- 現有登入／Session／權限中介層的程式碼。
- 非正式環境的測試帳號與部署流程。

不得在對話、Git 或設定範例中提供正式密碼、Token 或私鑰。

### 優點

- 可直接沿用既有 Session、系統入口及資料庫管理流程。
- 若正式環境已是 MySQL，可避免 SQLite 到 MySQL 的執行差異。
- 最終交付可直接進入既有網站整合測試。

### 限制

- 目前缺少原始碼、PHP Runtime、MySQL CLI 與測試資料庫，無法證明整合可建置或可回復。
- 在資料與部署邊界未確認前直接修改遠端，可能破壞既有入口與資料庫管理功能。
- 需要先盤點現有 Controller、Service、Session、權限與 DB Layer。

## 前端方向修正

| 項目 | 已採用：官方商品展示網站 | 未採用：營運後台／Schema 編輯器 |
|---|---|---|
| 主要使用者 | 社區住戶、家庭使用者、潛在客戶 | 客服、技術、DB 管理人員 |
| 首頁 | 品牌主張、方案、價格、促銷、比較與申裝 | KPI、待辦或 Schema 樹狀清單 |
| `website_db` 的用途 | 保留站台與中繼資料架構參考，不暴露管理介面 | 驅動內部通用資料管理 |
| `telecom_boss` 的用途 | 供應公開方案，並接收 `service_inquiries` | 完整內部營運 CRUD |
| 對修正後目標的符合度 | 直接形成像官方網頁展示商品的網站 | 不符合消費者商品展示需求 |

## 已採用決策

採用「部署 A＋官方商品前端」：建立可在目前環境實際執行的電信商品官網，以 `website_db` 保存參考中繼資料，以 `telecom_boss` 提供商品、價格、促銷、設備與申裝洽詢。

第一版完成並通過 API、資料庫與瀏覽器驗證後，再依既有網站原始碼與 MySQL 測試環境進行第二階段移植。這個順序可以先證明功能與資料契約，同時保留對現有 PHP 系統的整合路徑。

若進入第二階段 PHP／MySQL 整合，仍需提供既有 PHP 專案本機路徑、測試資料庫與部署流程；在此之前不連接或修改正式資料庫。
