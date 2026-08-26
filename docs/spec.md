# Spec：電信官方商品展示網站與後端資料庫

## 狀態

`IMPLEMENTED — REVISED` — 使用者於 2026-07-20 將前端方向修正為「像官方網頁展示商品的網站」。本機 Node.js＋SQLite、既有電信資料模型、公開商品頁與申裝流程皆已完成並驗證。

## 前置假設

1. 要建立的是面向消費者的「電信官方商品展示網站」，首頁重點為寬頻方案、價格、促銷、設備贈品與申裝引導。
2. 線上「資訊系統資料庫（`website_db`）」仍作為站台、系統、資料庫與內容中繼資料的架構參考，不把 Schema 編輯器或後台導覽外觀暴露給消費者。
3. 電信業務資料沿用已完成的 `telecom_boss`：8 個模組、39 張資料表、421 個欄位及 64 組關聯。
4. 建議先交付可在本機直接執行的 Node.js 24＋SQLite 版本，不安裝第三方套件；正式部署時再提供 MySQL Migration。
5. 第一版提供官方首頁、方案卡、價格期間、促銷贈品、方案比較、FAQ 與申裝洽詢表單。
6. 公開商品頁不需要登入；內部管理與 SSO 不屬於本次公開網站第一版。開發伺服器仍只綁定 `127.0.0.1`。

如上述任一項不符合需求，必須先更新本規格再實作。

## Objective

建立一套可執行、響應式、無障礙的電信官方商品展示網站，讓訪客比較 100M／300M／500M 寬頻方案、理解價格與優惠、選擇適合方案並送出申裝洽詢；所有商品與價格皆由實際後端 API 及具約束的關聯式資料庫提供。

### 主要使用者

- 社區住戶：比較速率、月租與首裝優惠。
- 家庭使用者：依影音、工作、遊戲等情境選擇方案。
- 潛在客戶：確認服務資訊並送出申裝洽詢。
- 客服與業務：後續可從 `service_inquiries` 接續處理公開網站送件。

### 第一版使用情境

1. 訪客進入首頁即可看到品牌主張、主要方案與清楚的申裝 CTA。
2. 方案卡顯示速率、技術、合約期間、月租價格區間與促銷贈品。
3. 訪客可切換或比較 100M／300M／500M 方案並閱讀適用情境。
4. 載入失敗、無方案與申裝成功／失敗都有明確且無障礙的狀態。
5. 訪客選擇方案後可送出姓名、電話與地址等最小必要洽詢資訊。
6. 所有 API 輸入都經 Server 驗證，SQL 全部參數化，錯誤回應格式一致。

## 參考架構

### 線上參考資料庫

2026-07-20 已由線上系統重新確認 `website_db` 包含 6 個群組、12 張資料表、106 個欄位及 7 筆初始資料。

本專案沿用下列概念：

| `website_db` 參考表 | 本專案用途 |
|---|---|
| `portal_minor` | 入口網站與品牌資訊 |
| `dict_systems` | 系統入口與網址 |
| `dict_databases` | 可管理的資料庫清單 |
| `dict_table_groups` | 第一層功能模組 |
| `dict_table_subgroups` | 可選的子模組 |
| `dict_tables` | 資料表目錄與顯示名稱 |
| `dict_columns` | 欄位型別、標籤、必填、索引與排序 |
| `dict_relations` | 資料表關聯與基數 |
| `dict_fk_selects` | 外鍵下拉選單來源與連動規則 |
| `work_tab_design` | Schema、關聯及數據管理頁籤定義 |
| `website_path` | 站台路徑與啟用狀態 |
| `products` | 原系統的一般資料表範例，不作為電信主模型核心 |

### 邏輯資料層

```text
website_db（系統中繼資料）
├── 入口、系統、資料庫
├── 群組、子群組
├── 資料表、欄位、關聯
├── 外鍵下拉設定
└── 工作區頁籤

telecom_boss（電信業務資料）
├── 存取控制
├── 客戶與業務
├── 方案與行銷
├── 訂單與合約
├── 裝機與維運
├── 帳務與收款
├── 庫存與設備
└── 網站內容
```

本機版本建議使用兩個 SQLite 檔案，分別對應 `website_db` 與 `telecom_boss`；正式 MySQL 環境則使用兩個 Database／Schema。這可以保留參考系統的分層，也避免中繼資料與營運交易資料互相污染。

## UI/UX 規格

### 視覺方向

- 風格：可信賴、明亮、有速度感的電信官方商品站；首屏必須直接傳達產品與申裝價值。
- 色彩：深海軍藍建立品牌可信度、亮青綠表現連線與速度、珊瑚橘作為重要優惠提示；不使用紫色漸層或制式後台卡片風格。
- 字體：系統中文字體堆疊，避免外部字型造成載入與隱私成本。
- 元件：固定間距尺度、輕量邊框、有限陰影；不使用紫色漸層、過度圓角或平均鋪滿的 AI 卡片風格。

### 桌面版配置

```text
┌────────────────────────────────────────────────────────────┐
│ 品牌        網路方案  企業服務  最新優惠       客服／申裝 │
├────────────────────────────────────────────────────────────┤
│ 品牌主張＋主 CTA                         光纖連線視覺     │
├────────────────────────────────────────────────────────────┤
│ 服務承諾／涵蓋區提示                                      │
├────────────────────────────────────────────────────────────┤
│ 100M／300M／500M 商品方案卡與價格                          │
├────────────────────────────────────────────────────────────┤
│ 首裝優惠／路由器贈品／適用情境                             │
├────────────────────────────────────────────────────────────┤
│ FAQ／申裝洽詢                                              │
└────────────────────────────────────────────────────────────┘
```

### 響應式行為

- 320px：品牌導覽改為可開關選單；方案卡單欄，CTA 保持可見。
- 768px：方案卡可雙欄，優惠資訊重排。
- 1024px：完整橫向導覽與三方案比較。
- 1440px：限制內容最大寬度並放大品牌主視覺。

### 必要狀態

- Skeleton 載入狀態。
- 無資料狀態，提供下一步操作。
- 可重試的 API 錯誤狀態。
- 申裝表單欄位錯誤與頁面層級錯誤摘要。
- 送出成功的 `aria-live` 訊息與可保存的洽詢編號。

### 無障礙

- WCAG 2.1 AA；一般文字對比至少 4.5:1。
- 完整鍵盤操作與可見焦點。
- 正確的 `h1 → h2 → h3` 階層。
- 所有輸入都有可見 Label；圖示按鈕有 accessible name。
- Dialog 開啟時移動焦點、限制焦點並在關閉後還原焦點。
- 動態結果以 `aria-live` 宣告。

## Tech Stack（已確認）

| 層級 | 技術 | 理由 |
|---|---|---|
| 前端 | 原生 HTML、CSS、ES Modules | 零安裝、可控的語意與無障礙、適合目前本機環境 |
| 後端 | Node.js 24 內建 `http` | 現有環境可用，無第三方 Runtime 依賴 |
| 開發資料庫 | Node.js 24 `node:sqlite`／SQLite 3.51 | 可立即建立實體 DB 與整合測試，不需安裝套件 |
| 正式資料庫 | 第二階段評估 MySQL 8 | 與線上資料型別及現有管理系統較一致；本版不宣稱已完成正式部署 |
| 測試 | `node:test`、真實 SQLite、Chrome DevTools | 零依賴，涵蓋單元、API、DB 與瀏覽器 |
| 文件 | Markdown、OpenAPI 3.1 JSON | 版本可追蹤，API 合約可驗證 |

`node:sqlite` 在目前 Node.js 24 會顯示 ExperimentalWarning。若要求正式長期部署，應改用經審核的 SQLite Driver 或直接採 MySQL；新增第三方套件前需取得使用者允許。

## API Contract

API 統一使用 `/api/v1` 前綴、camelCase 回應欄位與下列錯誤格式：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "輸入資料不正確",
    "details": [
      { "field": "planName", "message": "方案名稱為必填" }
    ]
  }
}
```

### 第一版端點

| Method | Path | 功能 |
|---|---|---|
| `GET` | `/api/v1/health` | 服務與資料庫健康檢查 |
| `GET` | `/api/v1/catalog` | 取得公開方案、價格、促銷與贈品 |
| `GET` | `/api/v1/catalog/plans/:id` | 取得單一公開方案詳情 |
| `POST` | `/api/v1/inquiries` | 送出申裝洽詢 |

### API 邊界

- 公開 API 只回傳商品展示必要欄位，不提供通用資料表存取能力。
- 申裝端點只接受明確 allowlist 欄位，伺服器產生欄位不可由 Client 覆寫。
- 值一律使用 prepared statement 參數，不串接 SQL 字串。
- `404` 表示方案不存在、`409` 表示重複送件、`422` 表示欄位驗證失敗。
- 寫入端點需具 Body 上限、頻率限制與冪等處理；讀取商品端點不需要登入。

### 後台 API 契約

後台使用 `/api/v1/admin` 前綴。每條後台 route 在註冊時必須同時宣告 HTTP method、固定或參數化 path、`authentication: required` 與最小 permission code；認證與權限由伺服器執行，前端隱藏選單不構成授權。未知 path 回 `404`，已知 path 的錯誤 method 回 `405` 並附 `Allow`。

單筆成功回應：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_xxx"
  }
}
```

清單成功回應：

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 0,
    "requestId": "req_xxx"
  }
}
```

後台錯誤沿用共用 `error.code`、`error.message` 與 `error.details`，欄位錯誤以 `{ "field": "...", "message": "..." }` 表示，並在 `meta.requestId` 提供追蹤識別。清單 query 必須 allowlist sort/filter、限制搜尋字串長度與 page size；任何 API 都不可提供任意資料表或欄位查詢。

### 後台 MVP 範圍

第一階段依序交付：本機開發登入與工作階段、CSRF、資料庫 RBAC、append-only 稽核、受保護的後台版型、儀表板、申裝洽詢、客戶與地址、方案與價格、訂單及工單。核心驗收流程為「前台洽詢 → 客服指派／更新 → Transaction 轉換客戶、地址與草稿訂單 → 訂單核准 → 建立裝機工單」。

本機開發登入預設關閉且只能綁定 `127.0.0.1`；正式 SSO 不得退回開發登入。正式 SSO、外部通知、HTTPS、外部部署、rich HTML sanitizer 或新增第三方套件均屬決策門，需使用者另行核准後才實作。

## Database Contract

### 中繼資料庫

- 保留 `website_db` 的核心命名與階層，以便直接對照線上系統。
- 每張表有主鍵，所有 FK 建立索引並明確指定刪除策略。
- `dict_databases.en_name`、群組內 `en_name`、資料庫內資料表 `en_name`、資料表內欄位 `en_name` 必須唯一。
- `dict_relations` 必須指向存在的資料表與欄位。
- `dict_fk_selects` 的來源表與 value／label 欄位必須可解析。

### 電信業務資料庫

- 以現有 `telecom_boss.schema.json` 為權威輸入，不手工省略資料表。
- 39 張表全部具主鍵；64 個 FK 全部具索引。
- 金額使用 `DECIMAL` 語意，在 SQLite 以整數分或格式化文字搭配 CHECK 實作，避免浮點誤差。
- 日期時間以 UTC ISO 8601 儲存，API 回傳含 `Z` 的字串。
- `assignment_key`、`grant_key`、`promotion_plan_key`、`price_period_key`、`billing_period_key`、`balance_key` 保持唯一；公開申裝以唯一 `inquiry_no` 實作持久化冪等。
- 付款與庫存異動必須在 Transaction 中同時寫入流水與更新餘額。
- 稽核日誌採 append-only；不得包含密碼、Token、完整身分識別值或支付敏感資料。

## Threat Model

| 資產／邊界 | 主要威脅 | 控制 |
|---|---|---|
| 公開商品 API | 過度資料暴露、SQL Injection | 固定查詢、明確 DTO、prepared statement |
| 申裝洽詢 | 垃圾送件、重送、個資濫用 | Body 上限、欄位驗證、冪等鍵、頻率限制、最小資料收集 |
| 客戶資料 | 個資外洩 | 最小回傳欄位、加密／遮罩、稽核 |
| 金額與庫存 | 重送、競爭條件、竄改 | 冪等鍵、Transaction、CHECK、唯一鍵 |
| CMS 內容 | Stored XSS | 禁用 `innerHTML`、輸出編碼、HTML allowlist 清理 |
| API | DoS、超大 Payload | Body 上限、分頁上限、逾時與速率限制 |
| 錯誤處理 | 內部資訊洩漏 | 統一錯誤格式、不回傳 Stack Trace |

## Commands（建議技術選型下）

```powershell
# 開發啟動
npm run dev

# 建立／重建開發資料庫
npm run db:migrate
npm run db:seed

# 全部測試
npm test

# 靜態檢查
npm run check

# 正式模式啟動
npm start
```

不得讓 `db:migrate` 靜默刪除既有 DB；重建或清除資料必須使用不同的明確命令並先備份。

## Project Structure

```text
telecom-boss-app/
├── README.md
├── AGENTS.md
├── package.json
├── docs/
│   ├── spec.md
│   ├── api.openapi.json
│   └── system-description.md
├── tasks/
│   ├── plan.md
│   └── todo.md
├── database/
│   ├── seeds/
│   ├── snapshots/
│   └── data/                 # gitignored runtime DB
├── scripts/
│   ├── migrate.mjs
│   ├── seed.mjs
│   └── check.mjs
├── src/
│   ├── server/
│   │   ├── http/
│   │   ├── db/
│   │   └── services/
│   └── web/
│       ├── index.html
│       └── assets/
├── tests/
│   ├── helpers/
│   ├── unit/
│   └── integration/
└── .gitignore
```

## Code Style

- JavaScript 使用 ES Modules、2 空格縮排、單引號、分號。
- 檔案與 URL 使用 kebab-case；函式與變數使用 camelCase；常數使用 UPPER_SNAKE_CASE。
- DOM 元素使用語意化 HTML；不對使用者資料使用 `innerHTML`。
- 資料存取放在 DB／service 邊界，route 不直接拼 SQL。
- 對外 API 使用固定 DTO，Client 不可指定資料表、欄位或工作流程欄位。

## Testing Strategy

### 單元測試

- 專案快照計數、格式與零依賴規則。
- Schema compiler 型別、金額比例與約束映射。

### 整合測試

- Migration 可在空白資料庫完整執行。
- 種子資料可重複執行且不重複新增。
- 39 張業務表與中繼資料表都存在。
- API 使用真實測試 SQLite，驗證商品查詢、申裝新增、衝突及關聯限制。
- SQL Injection payload 不會改變查詢結構。
- 冪等重送、頻率限制、跨站拒絕與交易 Rollback。

### E2E／瀏覽器驗證

- 桌面與手機尺寸載入官方商品首頁。
- 以鍵盤開啟導覽、方案詳情、選擇方案並送出申裝洽詢。
- 載入、空白、錯誤及成功狀態可見且可由輔助技術理解。
- Console 零錯誤／警告；API Network 回應符合契約。
- 320、768、1024、1440px 截圖檢查。

### TDD 規則

每個行為先寫會失敗的測試，再寫最小實作使其通過，最後在測試保持通過下重構。每個垂直切片都必須保留可執行狀態。

## Boundaries

### Always

- 先寫測試再寫行為程式。
- 所有 SQL 參數化，表名與欄位名使用 allowlist。
- 公開型錄查詢必須有明確且受控的資料範圍；未來若新增成長型列表則提供分頁。
- 所有頁面具載入、空白及錯誤狀態。
- UI 在真實瀏覽器驗證鍵盤、響應式、Console 及 Network。
- 資料庫變更提供可回復 Migration，且不覆寫線上 `website_db` 或 `telecom_boss`。

### Ask First

- 安裝任何 npm 套件或其他工具。
- 連接或修改遠端正式資料庫。
- 新增或變更登入／SSO 流程。
- 儲存新的個資或支付資料類型。
- 刪除資料表、欄位或大量資料。
- 部署到 `csmu.yankees.net.tw` 或其他外部環境。

### Never

- 把密碼、Token、金鑰或正式個資寫入程式碼、Seed、Log 或 Git。
- 使用 Client 驗證取代 Server 驗證。
- 直接執行使用者提供的 SQL、表名、欄位名或 HTML。
- 用 `FLOAT` 保存金額。
- 為了讓測試通過而關閉約束、授權或安全標頭。
- 未備份就執行破壞性 Migration。

## Success Criteria

1. 專案可依 README 在目前 Windows 環境啟動，不需未經允許的安裝動作。
2. 首頁是可操作的電信官方商品展示網站，不是後台儀表板、靜態圖片或只有 Mock 資料的展示頁。
3. UI 透過公開 Catalog API 顯示 `telecom_boss` 中啟用的方案、價格、促銷與設備贈品。
4. 後端建立實體資料庫，Migration 後自動驗證 39 張業務表、421 個欄位與 64 組關聯的預期模型。
5. 訪客可比較 100M／300M／500M 方案，選擇方案並送出申裝洽詢，重新載入後商品仍由資料庫取得。
6. 首頁具品牌主視覺、方案卡、價格期間、贈品優惠、服務情境、FAQ 與申裝 CTA。
7. API 合約、錯誤格式、驗證、固定公開 DTO 與 prepared statement 有自動測試證明。
8. 39 張表都有 PK、所有 FK 有索引，必要唯一鍵與 Transaction 規則通過驗證。
9. 320、768、1024、1440px 均可使用，鍵盤操作與可見焦點通過人工／DevTools 驗證。
10. 瀏覽器 Console 無錯誤或警告，關鍵 API 請求無非預期的 4xx／5xx。
11. README、架構說明、API 合約、Migration、Seed、測試及備份方式齊全。

## Decisions

1. 第一階段部署目標：本機 Node.js＋SQLite，可直接執行且不安裝第三方套件。
2. 前端方向：面向消費者的電信官方商品展示網站，提供方案展示、比較、促銷與申裝洽詢。
3. `website_db` 作為中繼資料與動態 UI 參考；`telecom_boss` 作為電信營運資料層。
4. PHP＋MySQL 與正式 SSO 留在第二階段；需要現有原始碼、測試環境及另行授權。
