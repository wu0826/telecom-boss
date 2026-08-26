# 營運報表 API 契約

## 端點

`GET /api/v1/admin/reports/operational?from=YYYY-MM-DD&to=YYYY-MM-DD`

此端點需要有效後台工作階段。它不接受報表名稱、資料表、排序或欄位等動態參數；所有報表、資料來源、排序與每區最多 50 筆明細均固定。

`from` 與 `to` 必須一起提供，採台北時間的曆日且包含首尾兩日。範圍最多 31 天；未提供時，兩者皆預設為資料截至時間所在的台北日期。回應的 `filters.fromAt` 為包含起點，`filters.toAt` 為排除終點，皆為 UTC ISO 8601 時間。

## 回應共同欄位

每個回應包含：

- `asOf`：資料讀取的 UTC 截止時間。
- `filters`：台北時區、原始日期、UTC 起訖及最大可查天數。
- `reports`：只有目前工作階段有權限的固定報表。

每個報表都包含 `total`、`unit`、`denominator`、`sourceTotals.records`、`definition`、`itemLimit` 與固定欄位的 `items`。`sourceTotals.records` 是同一資料粒度、但未套用該報表風險條件的來源筆數，可用來對帳。

## 報表定義與權限

| 報表 key | 最小權限 | 計數定義 | 分母／來源筆數 |
|---|---|---|---|
| `inquiries` | `customer.read` | 建立時間落在台北日期區間的洽詢 | 區間內全部洽詢 |
| `open-work` | `operations.manage` | 區間內建立、目前為 `OPEN`、`ASSIGNED`、`SCHEDULED` 或 `IN_PROGRESS` 的工單 | 區間內全部工單 |
| `overdue-invoices` | `billing.manage` | 到期日在區間內、早於 `asOf` 的台北日期、餘額大於零且為已開立狀態的帳單 | 區間內全部到期帳單 |
| `low-stock` | `inventory.manage` | 啟用倉庫中，可用量小於或等於再訂購量的庫存餘額 | 全部啟用倉庫庫存餘額；為 `asOf` 快照，不受日期區間影響 |
| `expiring-promotions` | `catalog.manage` | 結束時間在區間內、資料截至時仍有效的啟用促銷 | 區間內全部具結束時間的啟用促銷 |

報表明細不包含客戶姓名、電話、Email、地址、備註或其他敏感識別資料。日期、權限或查詢欄位無效時，回傳標準 `422 INVALID_QUERY` 錯誤；未登入時回傳 `401 AUTHENTICATION_REQUIRED`。
