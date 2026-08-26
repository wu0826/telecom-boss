# 後台站內通知 API 契約

## 端點與邊界

`GET /api/v1/admin/notifications`

端點需要有效後台工作階段，但不接受任何查詢參數；來源、排序、期限與筆數均由伺服器固定。它是唯讀 SQLite 查詢，沒有通知資料表、外送提供者、Email、SMS、推播、佇列或重試工作。

回應的 `asOf` 是 UTC 資料截止時間，`itemLimit` 固定為 `50`，`total` 與 `typeTotals` 僅統計目前角色可讀的通知來源。`hasMore` 表示受權總數超過本次固定清單；因此後續通知中心可安全顯示「50+」，不需要傳入客製筆數或篩選條件。

## 權限、來源與內部目的地

| type | 最小權限 | 固定來源條件 | href |
|---|---|---|---|
| `OVERDUE_INVOICE` | `billing.manage` | 到期日早於台北 `asOf` 日期、餘額大於零且帳單仍為開放狀態 | `#billing` |
| `OPEN_WORK` | `operations.manage` | 狀態為 `OPEN`、`ASSIGNED`、`SCHEDULED` 或 `IN_PROGRESS` | `#operations` |
| `LOW_STOCK` | `inventory.manage` | 啟用倉庫中可用量小於或等於再訂購水位 | `#inventory` |
| `EXPIRING_PROMOTION` | `catalog.manage` | 已啟用、已開始且結束時間落在 `[asOf, asOf + 7 天)` | `#products` |

未具備該模組權限時，該類型不會出現在 `typeTotals`、`total` 或 `notifications`，也不會揭露隱藏模組的筆數。所有連結都來自上述固定 allowlist，不採用資料庫或請求輸入作為 URL。

## 固定 DTO 與排序

每筆 `notifications` 固定包含：`id`、`type`、`severity`、`title`、`reference`、`detail`、`occurredAt` 與 `href`。`title` 是固定中文文案；`reference` 僅限工單號、帳單號、SKU 或促銷代碼；`detail` 僅包含狀態、優先級、日期或倉庫代碼。它不含客戶姓名、聯絡方式、地址、備註、商品名稱、倉庫名稱、促銷名稱、金額、內部資料列 ID 或稽核資訊。

伺服器會先按固定嚴重度 `CRITICAL`、`WARNING`、`INFO`，再按固定類型順序、事件時間與合成識別碼排序。各來源最多讀取 50 筆，合併後再套用全域 50 筆上限；相同資料與 `asOf` 必定得到相同結果。

未登入回傳 `401 AUTHENTICATION_REQUIRED`；任何查詢參數回傳 `422 INVALID_QUERY`。

## 桌面通知中心

後台頂列的通知按鈕僅在目前角色具有至少一項通知來源權限時啟用。登入後及每次開啟時，它會讀取同一個固定 API，徽章依受權 `total` 顯示數量（超過上限為 `50+`），面板按類型分組；載入、空資料與失敗都透過狀態區域告知。

面板開啟後焦點會進入關閉按鈕；按 `Escape` 或關閉後回到通知按鈕。每個「前往處理」連結先重新確認現有工作階段權限，僅能導向表中的固定工作區；權限改變或無法確認時不導向，且不保留先前的通知內容。
