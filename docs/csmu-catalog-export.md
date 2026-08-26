# CSMU Catalog V2 匯出與同步界線

## 已產生的本機產物

- 檔案：`database/exports/yankees_service_cms.catalog-v2.schema.json`
- 格式：`yk-schema-db`、`database` scope、無 sample data／form data
- 內容：10 張 Catalog V2 表、102 個欄位、12 個內部關聯
- SHA-256：`A8A242B281A2F142D35333F3B6A3732DC2346F5EEC7CBBB6A6F35DE5BB6690FE`
- 產生指令：

  ```powershell
  npm run schema:export:csmu
  ```

這個指令以唯讀方式開啟來源 SQLite；整合測試會在兩次產生後比對位元組內容、確認來源檔 SHA-256 未變，並對照所有匯出欄位與來源 `PRAGMA table_info`。

## CSMU 對照

| Catalog V2 | `project_db` 參考 | `yankees_service_cms` 草稿參考 | 正規化結果 |
|---|---|---|---|
| `catalog_categories` | `project_cate_nav1` → `project_large_nav2` → `project_medium_nav3` → `project_small_nav4` | 四層分類草稿 | 合為一張具 `parent_id` 的分類樹，拒絕循環與超過四層 |
| `catalog_products` | `project_master` | `product_master` | 一張有 code、slug、發布窗與唯一業務來源的商品主檔 |
| `catalog_product_categories` | 無 | 無 | 新增多對多關聯與單一主要分類 |
| `catalog_product_content` | `project_content` | `product_description` | 依語系保存內容與 SEO |
| `catalog_product_sections` | 無 | `product_overview` | 有排序與類型的純文字區塊 |
| `catalog_product_media` | 無 | `product_pic` | 圖片用途、替代文字、排序與主圖唯一性 |
| `catalog_product_specs` | 無 | `product_spec` | 結構化規格與語系唯一鍵 |
| `catalog_brands` | 無 | `product_brand` | 可重用品牌主檔 |
| `catalog_product_brands` | 無 | `product_brand_map` | 商品／品牌多對多與主要品牌 |
| `catalog_promotion_products` | 無 | 無 | 新增；促銷真實來源仍是 `telecom_boss.promotions` |

`project_db` 的參考輸出位於 `C:\Users\abc09\Downloads\project_db.schema.json`，本次讀取的 SHA-256 是 `1BA76F37249F8E22801F978A37FB9A4C2998F0A03D84055196C3A6124D4DA9BB`。目前工作樹沒有可驗證的 `yankees_service_cms` 最新匯出，因此上表只記錄已確認的草稿名稱，不能當成遠端目前 schema 的證明。

## 遠端同步前的必要核准

1. 使用者明確指定目標資料庫、是否僅補齊或允許取代既有草稿表，以及可寫入範圍。
2. 重新匯出遠端 `yankees_service_cms`，記錄新鮮 SHA-256 與 table／column／relation 差異。
3. 先建立遠端 metadata 備份並記錄指紋；不得寫入或刪除 `project_db`、`telecom_boss`、`website_db`。
4. 匯入後重新載入每一張表、每一欄與每一關聯，記錄後寫入指紋與驗證結果。

沒有上述明確核准時，這份產物只能供本機審核，禁止執行遠端寫入。
