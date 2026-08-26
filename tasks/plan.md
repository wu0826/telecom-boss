# Implementation Plan: Telecom Boss Admin

## Overview

在既有且已完成的公開電信商品網站與後台營運流程上，加入以「前端商品上架」為核心的 Catalog V2 管理資料庫。Catalog V2 參考 CSMU `project_db` 的四層分類、主檔與分段內容，以及 `yankees_service_cms` 的商品、SEO、品牌、規格、圖片、線上申請與稽核方向；實作時採正規化、可回復的增量 migration，不破壞既有 39 張電信營運表、訂單價格快照、庫存流水或權限稽核。全程沿用 Node.js 24、`node:http`、`node:sqlite`、原生瀏覽器模組與零第三方套件。

## Scope and Baseline

- 現有公開網站、兩個 SQLite 資料庫、39 張 `telecom_boss` 資料表、公開 catalog API、申裝 API 與 Tasks 1–23 是已完成基線，不重做。
- 2026-07-23 唯讀盤點確認 CSMU `project_db` 有 7 張表；其固定四層分類與主檔／內容／估價概念可參考，但 nullable、PK、FK 與索引設定不一致，不直接複製。
- 同次盤點確認 `yankees_service_cms` 有 18 張表；四層分類及 `product_master` 已有欄位，其餘內容、品牌、規格、圖片、申請與稽核表仍不完整，不能直接作為可執行來源。
- 現有資料必須保留：目前至少有 3 個方案、4 個價格期間、1 個促銷、1 個庫存品項，以及被洽詢、訂單與合約引用的資料。
- Tasks 24–33 構成 Catalog V2 商品上架資料庫與前後台切換；Tasks 34–44 為先前未完成的進階管理與交付工作。
- 正式 SSO、外部通知、HTTPS 與部署需要新的外部整合或環境權限，只有在使用者另行核准後才進入實作。
- CSMU 遠端 metadata 寫入只在本機 migration、資料回填、API、UI 與回復測試完成後進行；寫入前重新匯出備份並取得使用者核准。
- 原始 JSON snapshots 保持不變；Catalog V2 以版本化、可重跑的增量 migration/seed overlay 管理。
- 後台仍以 1024px/1440px 桌面網頁優先；320px/768px 商品管理驗證依使用者要求暫緩。

## Architecture Decisions

- 先把目前集中於 `server.mjs` 的路由分派抽成小型 router，再掛載 public 與 admin routes，確保後台擴充不持續放大單一檔案。
- 後台採 `Route → Authentication → Permission → Service → Repository → SQLite`；route 驗證輸入，service 管理狀態與 Transaction，repository 只持有 prepared SQL。
- MVP 使用僅允許 `127.0.0.1` 的開發登入。伺服器產生不可預測、閒置逾時、可撤銷的工作階段；Cookie 使用 `HttpOnly`、`SameSite=Strict`，正式模式不可啟用開發登入。
- 所有狀態變更 API 使用 CSRF token、明確 permission code、固定 DTO、body/page/search limits 與一致的 `data/meta/error` envelope。
- RBAC 從 `staff_users`、`roles`、`permissions`、`user_roles`、`role_permissions` 計算；前端選單只反映權限，不作為授權依據。
- 個資清單預設遮罩；`identity_hash` 與 `identity_encrypted` 永不進入 DTO。敏感資料查看、角色變更、狀態變更、匯出及高風險交易都寫入 append-only audit log。
- 金額沿用固定倍率整數；洽詢轉換、訂單核准、收款、出帳、設備與庫存異動皆以 `BEGIN IMMEDIATE` Transaction 與唯一鍵／狀態前置條件保護。
- 管理 UI 放在 `src/web/admin/`，與公開網站共用同源伺服器但不共用 DOM 程式；採桌面優先、漸進支援平板與手機。
- Catalog V2 是加在 `telecom_boss` 上的發布層，不取代 `service_plans`、`plan_prices`、`promotions`、`stock_items`、訂單、合約或庫存表。`catalog_products` 以 nullable unique FK 連到方案或庫存品項，讓商品頁共用內容、分類與上架狀態，但價格與庫存仍由各自營運表負責。
- CSMU 的四張分類表在本機正規化為單一 self-referencing `catalog_categories`；服務層限制最大四層、拒絕循環與跨樹錯誤移動，並以 parent/slug/sort 索引支援導覽。
- Catalog V2 目標表為 `catalog_categories`、`catalog_products`、`catalog_product_categories`、`catalog_product_content`、`catalog_product_sections`、`catalog_product_media`、`catalog_product_specs`、`catalog_brands`、`catalog_product_brands`、`catalog_promotion_products`。
- `catalog_products.status` 使用 `DRAFT`、`SCHEDULED`、`PUBLISHED`、`ARCHIVED`；公開查詢同時檢查 `publish_from`、`publish_until`，未發布、過期或未啟用分類一律不回傳。
- `catalog_product_content` 保存語系、摘要、完整純文字內容與 SEO 欄位；`catalog_product_sections` 保存可排序的結構化段落。未核准 sanitizer 前不接受任意 HTML。
- 圖片只保存受驗證的同源／HTTPS URL、替代文字、用途與排序，不把圖片二進位或任意本機路徑放進 SQLite；主圖唯一性由 Transaction 與索引保護。
- 商品規格採一列一屬性的結構化欄位，不以任意 JSON 取代；品牌與商品為多對多；分類與商品也為多對多並保留單一主要分類。
- 現有方案與可銷售庫存品項以穩定 business key 回填 Catalog V2；回填可重跑且不重複，既有 ID、價格、歷史訂單快照與庫存流水不得改寫。
- 公開 Catalog V2 使用固定 DTO；方案商品從 `plan_prices`/`promotion_plans` 取得價格與優惠，實體商品從 `stock_items` 取得售價與可售狀態，前端不得自行拼接不同資料來源。

## Catalog V2 Target Schema

| Table | Relationship and responsibility | Required indexes / invariants |
|---|---|---|
| `catalog_categories` | Self-referencing category tree; maps CSMU nav1–nav4 | Unique code and slug; index `(parent_id, sort_order)`; max depth 4 and no cycles |
| `catalog_products` | Publishing master linked optionally to one service plan or stock item | Unique code/slug/source links; index `(status, publish_from, publish_until, sort_order)` |
| `catalog_product_categories` | Product/category many-to-many with one primary category | Unique `(product_id, category_id)`; category listing index; one primary row per product |
| `catalog_product_content` | Localized detail and SEO, one row per product/locale | Unique `(product_id, locale)` |
| `catalog_product_sections` | Ordered overview/content sections | Index `(product_id, locale, sort_order)` |
| `catalog_product_media` | Images, alt text, usage and ordering | Index `(product_id, sort_order)`; one primary image per product |
| `catalog_product_specs` | Structured product specifications | Unique `(product_id, spec_key, locale)`; ordered group index |
| `catalog_brands` | Reusable brand master | Unique code and slug |
| `catalog_product_brands` | Product/brand many-to-many | Unique `(product_id, brand_id)` |
| `catalog_promotion_products` | Generalized product promotion link while preserving legacy plan links | Unique `(promotion_id, product_id)` |

## Dependency Graph

```text
Admin contract + router seam
        |
        +--> development session + CSRF
        |          |
        |          +--> RBAC + immutable audit
        |                     |
        |                     +--> admin shell + shared UI patterns
        |                                |
        |                                +--> dashboard
        |                                +--> inquiry list/detail/workflow
        |                                           |
        |                                           +--> customer/address
        |                                           +--> inquiry conversion transaction
        |                                                      |
        |                                                      +--> order lifecycle
        |                                                              |
        |                                                              +--> work orders
        |
        +--> legacy catalog management --> price interval transaction --> public catalog regression

MVP checkpoint
        |
        +--> subscriptions/accounts --> outages
        +--> invoices --> payments --> adjustments
        +--> stock items/warehouses --> stock movement transaction
        +--> CMS publishing
        +--> access administration + audit viewer
        +--> versioned migration runner
                   |
                   +--> Catalog V2 schema --> idempotent backfill
                               |
                               +--> product/category API --> desktop management UI
                               +--> content/media/spec API --> desktop editor UI
                               +--> public Catalog V2 API --> public product pages
                                                       |
                                                       +--> CSMU-compatible export and approved metadata sync
        |
        +--> exports/reports/notifications
        +--> approved SSO/deployment work
```

## Phase 1: Secure Admin Foundation

- [x] Task 1: Freeze the admin contract and introduce a router seam.
- [x] Task 2: Add loopback-only development login and sessions.
- [x] Task 3: Enforce CSRF and server-side RBAC.
- [x] Task 4: Make audit logging append-only and reusable.
- [x] Task 5: Deliver the protected admin shell and navigation.
- [x] Task 6: Deliver reusable admin list, form, status, and dialog patterns.

### Checkpoint: Secure Foundation

- [x] Public APIs and public UI still pass their existing tests.
- [x] Anonymous admin page/API requests are rejected and forbidden APIs return `403`.
- [x] Login, logout, CSRF failure, permission denial, and audit append behavior have tests.
- [x] `npm run check` and `npm test` pass before feature modules begin.

## Phase 2: Backoffice MVP Vertical Slices

- Desktop web implementation is the current priority. Additional mobile-specific implementation and 320px rework are paused until the desktop workflows are complete; existing responsive behavior must not regress.
- [x] Task 7: Deliver a permission-aware operations dashboard.
- [x] Task 8: Deliver inquiry search, filters, pagination, and detail.
- [x] Task 9: Deliver inquiry assignment and status workflow.
- [x] Task 10: Deliver customer, contact, and service-location management.
- [x] Task 11: Convert an inquiry to customer, location, and draft order atomically.
- [x] Task 12: Deliver service-plan management and public preview.
- [x] Task 13: Deliver transactional plan-price management.
- [x] Task 14: Deliver sales-order draft creation and price snapshots.
- [x] Task 15: Deliver order submit, approve, and cancel transitions.
- [x] Task 16: Deliver work-order queue, assignment, scheduling, and completion.

### Checkpoint: MVP

- [x] A public inquiry appears in admin, can be assigned, and converts exactly once.
- [x] The resulting customer, location, order, and approved installation work order are linked and auditable.
- [x] Plan/price changes affect public catalog output while historical order prices remain unchanged.
- [x] Permission, rollback, duplicate-submit, XSS, SQL injection, browser, and desktop responsive checks pass.

## Phase 3: Operational Workflows

- [x] Task 17: Deliver subscription and service-account management.
- [x] Task 18: Deliver outage incident and affected-subscription management.
- [x] Task 19: Deliver invoice creation, batch generation, issue, and void workflows.
- [x] Task 20: Deliver payment posting and billing-adjustment approval.
- [x] Task 21: Deliver stock-item, warehouse, balance, and stock-movement workflows.

### Checkpoint: Operations

- [x] Order completion can activate a subscription and coordinate installation equipment safely.
- [x] Duplicate billing, overpayment, negative available stock, and partial transaction failures are rejected or rolled back.
- [x] All state histories, amount snapshots, and high-risk audit records agree with database state.
- [x] Full automated and browser suites pass after the last operations change.

## Phase 4: Product Publishing Database Modernization

- [x] Task 22: Deliver CMS draft, preview, publish, and unpublish workflows.
- [x] Task 23: Deliver staff/role administration and read-only audit exploration.
- [x] Task 24: Add a versioned incremental migration runner and rollback proof.
- [x] Task 25: Create the normalized Catalog V2 schema.
- [x] Task 26: Backfill existing plans and sellable stock into Catalog V2.
- [x] Task 27: Deliver product and category administration APIs.
- [x] Task 28: Deliver the desktop product and category workspace.
- [x] Task 29: Deliver content, section, media, specification, and brand APIs.
- [x] Task 30: Deliver the desktop product-content editor.
- [x] Task 31: Deliver the public Catalog V2 API with reconciled prices and promotions.
- [x] Task 32: Cut the public product pages over to Catalog V2 with rollback coverage.
- [ ] Task 33: Generate and, after approval, synchronize the CSMU catalog schema.

### Checkpoint: Catalog Data Foundation — After Tasks 24–26

- [x] A copied production-like SQLite database upgrades and rolls back without losing any existing row, reference, amount, or audit record.
- [x] Catalog tables, constraints, indexes and foreign keys match the target schema; backfill is idempotent.
- [x] Legacy public/admin catalog tests still pass before any read-path cutover.

### Checkpoint: Catalog Administration — After Tasks 27–30

- [x] A catalog manager can create a category, draft product, content sections, specs, brand and media, then preview it at 1024px/1440px.
- [x] Invalid category cycles, duplicate codes/slugs, unsafe URLs/HTML, stale writes and unauthorized actions fail closed.
- [x] Product edits are audited and never mutate operational prices, stock balances or historical order snapshots.

### Checkpoint: Catalog Cutover — After Tasks 31–33

- [x] Public list/detail responses contain only currently published products and reconcile with plan prices, promotions and stock sources.
- [x] Public and admin previews use the same projection; the legacy read path remains available for rollback until final verification.
- [x] The CSMU artifact maps every local category/product/content/media/spec/brand relationship and remote metadata is untouched until explicit approval.

## Phase 5: Advanced Administration and Handoff

- [x] Task 34: Add desktop work-order calendar and kanban views.
- [x] Task 35: Add permission-aware global search and quick navigation.
- [x] Task 36: Add a bounded masked-customer CSV export API.
- [x] Task 37: Add the desktop customer-export workflow.
- [x] Task 38: Add reconciled operational reporting APIs.
- [x] Task 39: Add the desktop operational-report workspace.
- [x] Task 40: Add permission-filtered in-app notification APIs.
- [x] Task 41: Add the desktop notification center.
- [x] Task 42: Add a read-only system health and recovery-information workspace.
- [x] Task 50: Add category-detail editing and guarded permanent product deletion.
- [ ] Task 43: Integrate approved production SSO and invalidate changed sessions.
- [ ] Task 44: Complete security, accessibility, performance, recovery, and deployment handoff.

## Phase 6: Desktop Service and Product Showcase Pages

This phase implements the standalone public pages defined in `docs/service-product-showcase-brief.md`. It may proceed before the separately approved SSO and deployment work because it uses only the existing public read APIs and inquiry handoff.

- [x] Task 45: Add the shared desktop showcase shell and fiber-broadband service page.
- [x] Task 46: Add the remaining four standalone service pages using the shared shell.
- [x] Task 47: Add the data-driven product catalog page with shareable category URL state.
- [x] Task 48: Add the standalone product-detail template and fixed public plan detail pages.
- [x] Task 49: Connect homepage service entries and quote handoff, then verify the complete desktop journey.

### Checkpoint: Desktop Showcase Pages

- [x] Every public page has one primary CTA, breadcrumbs, a direct return path, real reviewed copy, and loading/empty/error states where data is loaded.
- [x] Catalog product/category data stays within the existing public DTO; internal fields, costs, audit data, and personal data are never rendered.
- [x] Desktop 1024px/1440px keyboard, Console, network, deep-link, CTA-context, and no-overflow checks pass; mobile-specific layout work remains deferred.

### Checkpoint: Complete

- [ ] Admin routes, API contracts, permission matrix, schema crosswalk and operational runbooks match runtime behavior.
- [ ] Keyboard, accessibility tree, console, network and 1024px/1440px desktop layouts are verified; 320px/768px admin verification remains explicitly deferred.
- [ ] Backup/restore and rollback drills are documented and tested without deleting source snapshots.
- [ ] `npm run check`, `npm test`, and all requirement-traceability evidence pass after the last change.

## Parallelization Opportunities

- Tasks 7 and 8 may proceed in parallel after Task 6 if API response contracts are frozen first.
- Tasks 12–13 may proceed alongside Tasks 10–11 because catalog tables do not share customer writes; public catalog regression tests coordinate the merge point.
- After the MVP checkpoint, Tasks 18, 19, 21, and 22 can be developed as independent vertical slices.
- Tasks 27 and 29 may proceed in parallel only after Task 26 freezes the Catalog V2 schema and DTO boundaries.
- Tasks 28 and 30 may proceed in parallel after their API contracts are verified; Task 31 remains sequential because it defines the public projection consumed by Task 32.
- Tasks 34–42 are independent after Catalog V2 cutover, except each API task must finish before its paired desktop UI task.
- Tasks involving shared router, session state, permission seeds, migrations, Catalog V2 backfill/cutover, order transitions, payments, stock balances or remote CSMU writes remain sequential.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Development login accidentally enabled outside localhost | High | Fail startup unless host is `127.0.0.1`; require explicit development flag; add negative startup tests |
| Frontend-only authorization creates IDOR/privilege escalation | High | Permission middleware on every admin route plus cross-role integration tests |
| SQLite write contention causes partial or duplicate workflows | High | Short `BEGIN IMMEDIATE` transactions, unique business keys, idempotency keys, and rollback tests |
| Sensitive customer/billing data leaks through DTOs or logs | High | Field allowlists, masking helpers, safe audit payloads, and snapshot tests for forbidden fields |
| Admin router work regresses the public website | Medium | Preserve public contract tests and run them at every checkpoint |
| Generic UI abstractions become a hidden generic table editor | Medium | Reuse presentation primitives only; each module keeps fixed DTOs and explicit repositories |
| CMS rich content introduces stored XSS without a sanitizer package | High | MVP stores/renders plain text or a small allowlisted markup subset; richer HTML requires an approved strategy |
| Role/permission detail is broader than existing seed data | Medium | Add explicit seed overlay and matrix tests before exposing module navigation |
| Copying `project_db` reproduces nullable keys, multiple-PK ambiguity and weak indexing | High | Use it as a semantic crosswalk only; implement the normalized Catalog V2 table set and constraint tests |
| Catalog V2 duplicates operational price or stock truth | High | Store source FKs only; resolve plan prices/promotions and stock selling price from their existing domain tables |
| Backfill or cutover corrupts referenced plan/order data | High | Additive migration, copy-first rehearsal, row/hash reconciliation, idempotent business keys and a dual-read rollback switch |
| Category recursion creates cycles or unbounded queries | Medium | Enforce depth 1–4, reject cycles in one transaction and index `(parent_id, sort_order)` |
| Media or SEO fields enable stored XSS or unsafe navigation | High | Validate URL schemes/lengths, require alt text, render via DOM/text APIs and reject arbitrary HTML |
| CSMU draft schema changes while local work is underway | High | Re-export immediately before approved synchronization and compare table/column/relation fingerprints |
| Formal SSO and deployment assumptions are unknown | High | Keep Task 43 blocked on provider/environment approval and document the local-only boundary clearly |

## Open Questions and Decision Gates

- Before Task 24 implementation: review and approve the Catalog V2 target tables, additive migration strategy and normalized single category tree.
- Before Task 33 remote synchronization: approve the exact target database (`yankees_service_cms` by default), confirm whether incomplete draft tables may be replaced or only completed, and authorize a fresh export backup plus metadata writes.
- Before Task 43: choose and approve the production identity provider (Google Workspace SSO or company LDAP), callback URLs, group mapping and secret storage.
- External delivery after Task 41 requires separate approval of channels, providers, recipients, retry policy and handling of customer data; Task 41 is in-app only.
- Before production deployment in Task 44: approve hosting target, TLS termination, backup retention, monitoring destination and recovery objectives.
- Before allowing rich CMS HTML in Task 22: approve a strict built-in subset or a reviewed sanitizer dependency; plain text remains the safe default.

## Plan Verification

- [x] Tasks follow dependency order and preserve a runnable system at each checkpoint.
- [x] Every task in `tasks/todo.md` has acceptance criteria, verification, dependencies, and likely files.
- [x] Tasks are scoped to one focused session and avoid mixing independent subsystems.
- [x] External integrations and deployment remain explicit approval gates.
- [ ] Human reviewed and approved the Catalog V2 plan before Task 24 implementation.
