# 系統說明：洋基電信官方商品展示網站

## 1. 系統目的

本系統把既有電信後端資料模型與 Catalog V2 發布層轉成面向消費者的官方商品網站。訪客不需要登入即可查看已發布服務／商品、價格、促銷與內容，完成比較後可送出方案申裝洽詢；客服與業務則能在既有 `service_inquiries` 資料表接續處理。

## 2. 系統組成

```text
瀏覽器官方商品頁
  ├─ GET /api/v1/catalog/products ─────┐
  ├─ GET /api/v1/catalog/products/:slug│
  ├─ GET /api/v1/catalog（申裝代碼對照） │
  └─ POST /api/v1/inquiries ───────────┤
                                        ▼
                             Node.js 本機 API
                               ├─ 固定公開 DTO
                               ├─ 輸入驗證與安全控制
                               └─ Prepared SQL + Transaction
                                        │
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
          website_db.sqlite                    telecom_boss.sqlite
          站台與 Schema 中繼資料               商品、價格、促銷、設備、洽詢
```

前端與 API 由同一個 Node.js 程序提供，因此沒有跨網域憑證或 CORS 設定。伺服器僅監聽 `127.0.0.1`。

## 3. 資料庫架構依據

### `website_db`

此資料庫參考 `https://csmu.yankees.net.tw/dbedit/manage_boss_schema.php` 的資訊系統資料庫結構，保留入口、系統、資料庫、群組、資料表、欄位、關聯、Select 來源與頁籤等 12 張表、106 個欄位。它是架構與中繼資料來源，不直接暴露給公開網站訪客。

### `telecom_boss`

電信業務資料庫由簽入的 Schema 快照編譯成 SQLite，共 8 個模組、39 張資料表、421 個欄位與 64 個外鍵關聯。所有 39 張表皆使用 STRICT 模式；主鍵、唯一鍵、外鍵索引、列舉與布林 CHECK 都由 Migration 建立。

公開商品與申裝最重要的關聯如下：

```text
service_plans 1 ─── N plan_prices
service_plans N ─── N promotions（透過 promotion_plans）
promotions    N ─── 1 equipment_models（贈品，可為空）
service_plans 1 ─── N service_inquiries（requested_plan_id）
```

| 資料表 | 官網用途 |
|---|---|
| `service_plans` | 100M／300M／500M 方案名稱、技術、速率、合約期間與啟用區間 |
| `plan_prices` | 標準、首期與續約價格期間；DECIMAL 在 SQLite 以固定小數整數保存 |
| `promotions` | 有效促銷、贈品數量與活動期間 |
| `promotion_plans` | 方案與促銷多對多對應 |
| `equipment_models` | Archer A6 等設備型號與品牌 |
| `service_inquiries` | 官網申裝洽詢、聯絡資料、選擇方案、來源與處理狀態 |

## 4. 公開網站功能

1. 首頁：品牌主張、服務承諾、主要 CTA 與使用情境。
2. 商品型錄：只顯示目前已發布且在有效日期內的 Catalog V2 服務／商品、價格與促銷。
3. 商品比較：比較分類、價格與目前優惠；服務方案仍以既有業務鍵安全帶入申裝表單。
4. 商品詳情：透過獨立 API 載入內容、圖片、區塊、規格、品牌與優惠，使用原生 `<dialog>` 管理焦點與鍵盤關閉。
5. 申裝洽詢：服務方案由公開 `planCode` 對應既有表單選項；輸入最小必要聯絡與地址資料，成功後只顯示洽詢編號。
6. 狀態處理：具 loading、empty、stale-link、retry、欄位錯誤摘要、pending、success 與 API failure 狀態。驗證期間可在網址使用 `?catalog=legacy` 切回舊方案投影，不變更任何資料。

## 5. 申裝交易與冪等設計

伺服器收到申裝資料後會：

1. 限制 JSON body 大小並檢查 Content-Type。
2. 拒絕跨站瀏覽器請求、未知欄位、蜜罐內容與過量請求。
3. 驗證姓名、聯絡方式、地址、同意勾選與有效方案。
4. 以 `Idempotency-Key` 的 SHA-256 摘要產生不含個資的 `WEB-` 洽詢編號。
5. 在 `BEGIN IMMEDIATE` Transaction 中確認重送、檢查方案並 prepared insert。
6. 把 channel／status 固定為 `WEB`／`NEW`，Client 無法覆寫工作流程欄位。
7. 同一鍵與同一資料重送時回傳原結果；同一鍵搭配不同資料時回傳 `409`。

`notes` 僅保存以隨機冪等鍵計算的 canonical payload HMAC，不保存冪等鍵本身，避免低熵聯絡資料被離線猜測，並讓冪等狀態可隨 SQLite 持久化。錯誤回應不包含 SQL、檔案路徑或 Stack Trace。

## 6. 無障礙與響應式

- 語意化 header／nav／main／section／footer、跳至主內容連結與正確標題層級。
- 320、768、1024、1440px 排版；比較表在窄螢幕可水平捲動而不造成整頁溢位。
- 行動選單與詳情視窗都有焦點移入、`Esc` 關閉與焦點返回。
- 表單有可見 label、原生限制、頁面錯誤摘要、live region 與不回顯個資的成功狀態。
- `prefers-reduced-motion` 會關閉非必要動畫與平滑捲動。

## 7. 已知邊界

- 目前是本機展示版本，未包含正式 HTTPS、DNS、反向代理、郵件／簡訊通知或客服後台畫面。
- 方案內容來自本機 seed；正式上線前須接正式商品維護流程與法務核准文案。
- `node:sqlite` 在 Node.js 24 仍由專案隔離於 DB adapter；若改用 MySQL，應保留 API DTO 與交易測試後替換資料層。
