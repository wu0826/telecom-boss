# Task List: Telecom Boss Admin

## Task 1: Freeze the admin contract and introduce a router seam

**Description:** Add the accepted backend-admin requirements to project documentation, define response/list/error conventions, and refactor request dispatch behind a small router without changing existing public behavior.

**Acceptance criteria:**

- [x] `/api/v1` public routes retain their current status codes, DTOs, headers, and tests.
- [x] Admin route registration supports method, path parameters, authentication, and permission metadata without dynamic code execution.
- [x] The admin MVP scope and deferred approval gates are recorded in `docs/spec.md`.

**Verification:**

- [x] Run `node --test tests/integration/http-health.test.mjs tests/integration/catalog-site.test.mjs tests/integration/public-conversion-api.test.mjs`.
- [x] Run new router unit tests for exact, parameterized, unknown, and wrong-method routes.

**Dependencies:** None

**Files likely touched:** `docs/spec.md`, `src/server/http/router.mjs`, `src/server/http/public-routes.mjs`, `src/server/http/server.mjs`, `tests/unit/router.test.mjs`

**Estimated scope:** Medium

## Task 2: Add loopback-only development login and sessions

**Description:** Implement an explicitly enabled local development login that selects active seeded staff accounts and issues opaque, idle-expiring, revocable server-side sessions.

**Acceptance criteria:**

- [x] Development login refuses to start or authenticate when the server is not bound to `127.0.0.1` or the feature flag is absent.
- [x] Session cookies are opaque, `HttpOnly`, `SameSite=Strict`, path-scoped, rotated on login, and cleared on logout.
- [x] Disabled users, expired sessions, unknown sessions, and post-logout reuse receive `401` without leaking identity details.

**Verification:**

- [x] Run development authentication integration tests, including startup refusal and idle expiry.
- [x] Inspect `Set-Cookie` attributes and confirm the token never appears in logs or response bodies.

**Dependencies:** Task 1

**Files likely touched:** `src/server/admin/auth/session-store.mjs`, `src/server/admin/auth/auth-service.mjs`, `src/server/admin/auth/auth-routes.mjs`, `src/server/db/seed.mjs`, `tests/integration/admin-auth.test.mjs`

**Estimated scope:** Medium

## Task 3: Enforce CSRF and server-side RBAC

**Description:** Resolve effective permissions from database role assignments, expose only a safe current-user DTO, and protect every mutating admin request with same-origin and CSRF checks.

**Acceptance criteria:**

- [x] Every `/api/v1/admin/` route requires a session and an explicit permission; direct unauthorized calls return `403`.
- [x] Mutating requests require a session-bound CSRF token and reject cross-site fetch metadata or invalid tokens.
- [x] Role or active-state changes invalidate or refresh affected session permissions before the next authorized operation.

**Verification:**

- [x] Run cross-role authorization matrix tests for anonymous, allowed, and denied requests.
- [x] Run CSRF tests for missing, mismatched, replayed-after-logout, and valid tokens.

**Dependencies:** Task 2

**Files likely touched:** `src/server/admin/auth/permission-service.mjs`, `src/server/admin/auth/admin-guard.mjs`, `src/server/admin/auth/csrf.mjs`, `src/server/db/seed.mjs`, `tests/security/admin-authorization.test.mjs`

**Estimated scope:** Medium

## Task 4: Make audit logging append-only and reusable

**Description:** Provide a privacy-safe audit service and database protection so security and business events can be appended but never changed through the application.

**Acceptance criteria:**

- [x] Login/logout, failures, denials, sensitive reads, state changes, role changes, and exports can write request-correlated audit records.
- [x] Audit payload allowlists exclude tokens, secrets, raw identity fields, full contact details, and payment credentials.
- [x] Database/application attempts to update or delete `audit_logs` fail and leave existing rows unchanged.

**Verification:**

- [x] Run audit integration tests for append, redaction, update rejection, and delete rejection.
- [x] Force a business transaction failure and prove its audit/business consistency follows the documented policy.

**Dependencies:** Task 3

**Files likely touched:** `src/server/admin/audit/audit-repository.mjs`, `src/server/admin/audit/audit-service.mjs`, `src/server/db/constraint-overlays.mjs`, `src/server/db/seed.mjs`, `tests/security/audit-log.test.mjs`

**Estimated scope:** Medium

## Task 5: Deliver the protected admin shell and navigation

**Description:** Create the `/admin/` login and application shell with top bar, permission-filtered side navigation, breadcrumbs, skip link, environment badge, user menu, and logout.

**Acceptance criteria:**

- [x] Anonymous users see only development login; authenticated users see only modules represented by their effective permissions.
- [x] Direct URL navigation remains protected by the API even when a menu item is absent.
- [x] Shell landmarks, focus order, active route, mobile drawer, status text, and logout work with keyboard and screen reader semantics.

**Verification:**

- [x] Run admin shell integration tests and a keyboard-only login/navigation/logout walkthrough.
- [x] Inspect accessibility tree, network, console, and 320/768/1024/1440px layouts.

**Dependencies:** Tasks 3–4

**Files likely touched:** `src/web/admin/index.html`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/css/admin.css`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 6: Deliver reusable admin list, form, status, and dialog patterns

**Description:** Build framework-free UI primitives for query-preserving lists, forms, status labels, tabs, drawers, confirmation dialogs, announcements, and unsaved-change protection.

**Acceptance criteria:**

- [x] List state serializes keyword, filters, sort, page, and page size into validated URL parameters and restores it on return.
- [x] Forms provide field errors, error summary focus, pending/duplicate-submit protection, success announcement, and unsaved-change warning.
- [x] Dialogs trap/restore focus correctly, and statuses always include readable text rather than color alone.

**Verification:**

- [x] Run UI unit tests for query serialization, focus behavior, submission state, and status rendering.
- [x] Manually exercise primitives with keyboard and reduced motion enabled.

**Dependencies:** Task 5

**Files likely touched:** `src/web/admin/js/list-state.mjs`, `src/web/admin/js/form-controller.mjs`, `src/web/admin/js/components.mjs`, `src/web/admin/css/components.css`, `tests/unit/admin-ui.test.mjs`

**Estimated scope:** Medium

## Task 7: Deliver a permission-aware operations dashboard

**Description:** Add dashboard summary and role-specific work queues using bounded aggregate queries and fixed DTOs.

**Acceptance criteria:**

- [x] Each role receives only permitted cards and queues, including new inquiries, open work orders, overdue invoices, and low stock where authorized.
- [x] Counts use defined Taipei business-day boundaries converted to UTC and never expose hidden underlying records.
- [x] Empty, loading, stale-session, and API error states are announced and recoverable.

**Verification:**

- [x] Run dashboard service/API tests against seeded edge cases and multiple roles.
- [x] Verify dashboard cards and quick actions in browser with allowed and denied accounts.

**Dependencies:** Task 6

**Files likely touched:** `src/server/admin/dashboard/dashboard-repository.mjs`, `src/server/admin/dashboard/dashboard-service.mjs`, `src/server/admin/dashboard/dashboard-routes.mjs`, `src/web/admin/js/pages/dashboard-page.mjs`, `tests/integration/admin-dashboard.test.mjs`

**Estimated scope:** Medium

## Task 8: Deliver inquiry search, filters, pagination, and detail

**Description:** Expose masked inquiry list/detail DTOs and render a query-preserving customer-service workspace for front-office submissions.

**Acceptance criteria:**

- [x] Authorized users can filter by safe keyword, plan, channel, status, assignee, and date range with allowlisted sort and bounded pagination.
- [x] List contact data is masked; detail returns only role-allowed fields and never exposes internal idempotency data.
- [x] A newly submitted public inquiry appears in admin without copying or mocking data.

**Verification:**

- [x] Run inquiry API tests for filters, sorting, limits, masking, invalid queries, and permission denial.
- [x] Submit from the public UI, then locate and open the inquiry in admin.

**Dependencies:** Task 6

**Files likely touched:** `src/server/admin/inquiries/inquiry-repository.mjs`, `src/server/admin/inquiries/inquiry-service.mjs`, `src/server/admin/inquiries/inquiry-routes.mjs`, `src/web/admin/js/pages/inquiry-page.mjs`, `tests/integration/admin-inquiries.test.mjs`

**Estimated scope:** Medium

## Task 9: Deliver inquiry assignment and status workflow

**Description:** Add explicit assignment and valid `NEW → CONTACTED → QUALIFIED → CONVERTED/CLOSED` transitions with optimistic conflict handling and audit history.

**Acceptance criteria:**

- [x] Only active permitted staff may be assigned, and stale concurrent updates return `409` without overwriting newer work.
- [x] Invalid status jumps, edits after terminal state, duplicate submissions, and unknown fields are rejected.
- [x] Successful assignment/status changes return fixed DTOs and append privacy-safe audit records.

**Verification:**

- [x] Run state-machine, stale-update, duplicate-submit, rollback, and authorization tests.
- [x] Verify assignment and status UI preserves list filters after returning from detail.

**Dependencies:** Tasks 4 and 8

**Files likely touched:** `src/server/admin/inquiries/inquiry-workflow.mjs`, `src/server/admin/inquiries/inquiry-service.mjs`, `src/server/admin/inquiries/inquiry-routes.mjs`, `src/web/admin/js/pages/inquiry-page.mjs`, `tests/integration/inquiry-workflow.test.mjs`

**Estimated scope:** Medium

## Task 10: Deliver customer, contact, and service-location management

**Description:** Add customer search/detail and focused create/update flows for customer profile, contacts, service addresses, serviceability status, and allowed technologies.

**Acceptance criteria:**

- [x] Customer list/detail uses masked DTOs and never returns `identity_hash` or `identity_encrypted`.
- [x] Contacts, primary-contact uniqueness, addresses, area links, and address status are server-validated and transactionally consistent.
- [x] Sensitive-field access requires `customer.sensitive.read` and creates a dedicated audit event.

**Verification:**

- [x] Run customer API tests for masking, validation, primary-contact conflicts, sensitive permission, and rollback.
- [x] Complete create/edit/detail flows using keyboard at desktop 1024/1440px; mobile-specific rework remains paused by user direction.

**Dependencies:** Tasks 4 and 6

**Files likely touched:** `src/server/admin/customers/customer-repository.mjs`, `src/server/admin/customers/customer-service.mjs`, `src/server/admin/customers/customer-routes.mjs`, `src/web/admin/js/pages/customer-page.mjs`, `tests/integration/admin-customers.test.mjs`

**Estimated scope:** Medium

## Task 11: Convert an inquiry to customer, location, and draft order atomically

**Description:** Implement the core vertical transaction that links or creates a customer/contact, optionally creates a service location, creates a draft order, marks the inquiry converted, and audits the result.

**Acceptance criteria:**

- [x] One successful request creates/links all selected records and returns stable identifiers without exposing sensitive fields.
- [x] Repeating or concurrently racing the conversion creates no duplicate customer/order and returns a deterministic conflict/result.
- [x] Any validation, constraint, or injected failure rolls back every business change and leaves the inquiry eligible for retry.

**Verification:**

- [x] Run success, existing-customer, idempotency, concurrency, permission, and failure-at-each-step transaction tests.
- [x] Complete the public-inquiry-to-draft-order flow end to end in the desktop browser; mobile-specific rework remains paused by user direction.

**Dependencies:** Tasks 9–10

**Files likely touched:** `src/server/admin/inquiries/inquiry-conversion-service.mjs`, `src/server/admin/inquiries/inquiry-repository.mjs`, `src/server/admin/orders/order-repository.mjs`, `src/server/admin/inquiries/inquiry-routes.mjs`, `tests/integration/inquiry-conversion.test.mjs`

**Estimated scope:** Medium

## Task 12: Deliver service-plan management and public preview

**Description:** Add fixed plan list/detail/create/update/publish operations and a preview that uses the same catalog projection as the public site.

**Acceptance criteria:**

- [x] Authorized catalog staff can manage allowlisted plan fields and valid effective periods.
- [x] Referenced plans cannot be deleted; publish/unpublish controls public catalog visibility without changing historical orders.
- [x] Preview and live catalog agree on plan formatting while draft plans stay private.

**Verification:**

- [x] Run plan CRUD, reference protection, publish, permission, and public catalog regression tests.
- [x] Preview, publish, and unpublish a plan and verify public output.

**Dependencies:** Tasks 4 and 6

**Files likely touched:** `src/server/admin/catalog/plan-repository.mjs`, `src/server/admin/catalog/plan-service.mjs`, `src/server/admin/catalog/catalog-routes.mjs`, `src/web/admin/js/pages/plan-page.mjs`, `tests/integration/admin-plans.test.mjs`

**Estimated scope:** Medium

## Task 13: Deliver transactional plan-price management

**Description:** Manage price periods with fixed-scale integer amounts and enforce non-overlapping effective/month ranges inside the same write transaction.

**Acceptance criteria:**

- [x] Negative amounts, reversed ranges, invalid cycles/types, unsafe precision, and overlapping active periods are rejected.
- [x] Concurrent inserts for the same plan/type/priority cannot commit conflicting periods.
- [x] Accepted price changes update current public pricing but never mutate order item price snapshots.

**Verification:**

- [x] Run boundary, overlap, precision, concurrency, rollback, and public catalog regression tests.
- [x] Create adjacent valid periods and confirm formatted amounts in admin and public preview.

**Dependencies:** Task 12

**Files likely touched:** `src/server/admin/catalog/price-repository.mjs`, `src/server/admin/catalog/price-service.mjs`, `src/server/admin/catalog/catalog-routes.mjs`, `src/web/admin/js/pages/price-page.mjs`, `tests/integration/admin-prices.test.mjs`

**Estimated scope:** Medium

## Task 14: Deliver sales-order draft creation and price snapshots

**Description:** Add order search/detail and draft creation for customer, service location, service plan, equipment, promotion, and engineering-project line items.

**Acceptance criteria:**

- [x] Draft creation validates ownership/active references, resolves effective price/promotion server-side, and stores fixed amount/description snapshots.
- [x] Subtotal, tax, and total are calculated from validated line items rather than trusted client totals.
- [x] Repeated submission is idempotent and invalid stock/price selections leave no partial order.

**Verification:**

- [x] Run amount, snapshot, reference, idempotency, permission, and rollback tests.
- [x] Create a draft from a converted inquiry and verify every linked record in admin.

**Dependencies:** Tasks 11 and 13

**Files likely touched:** `src/server/admin/orders/order-repository.mjs`, `src/server/admin/orders/order-service.mjs`, `src/server/admin/orders/order-routes.mjs`, `src/web/admin/js/pages/order-page.mjs`, `tests/integration/admin-orders.test.mjs`

**Estimated scope:** Medium

## Task 15: Deliver order submit, approve, and cancel transitions

**Description:** Enforce the order state machine and create an installation work order atomically when an eligible service order is approved.

**Acceptance criteria:**

- [x] Only valid `DRAFT → SUBMITTED → APPROVED` and allowed cancellation transitions are accepted with separate permissions.
- [x] Approval creates at most one linked installation work order and audit/state history even under retry or concurrency.
- [x] Failure after transition validation rolls back order status, work order, and related writes together.

**Verification:**

- [x] Run transition matrix, segregation-of-duty, idempotency, concurrent approval, and rollback tests.
- [x] Submit and approve an order in browser and follow the created work-order link.

**Dependencies:** Task 14

**Files likely touched:** `src/server/admin/orders/order-workflow.mjs`, `src/server/admin/orders/order-service.mjs`, `src/server/admin/orders/order-routes.mjs`, `src/web/admin/js/pages/order-page.mjs`, `tests/integration/order-workflow.test.mjs`

**Estimated scope:** Medium

## Task 16: Deliver work-order queue, assignment, scheduling, and completion

**Description:** Add searchable work-order operations with technician assignment, appointment scheduling, explicit status transitions, resolution notes, and immutable status history.

**Acceptance criteria:**

- [x] Authorized users can filter, create, assign, schedule, start, complete, or cancel according to the documented state machine.
- [x] Each status change records actor/time/from/to; terminal or stale transitions are rejected without overwriting history.
- [x] Completion requires type-appropriate fields and never logs unmasked customer notes.

**Verification:**

- [x] Run transition, assignee, schedule, concurrency, permission, history, and rollback tests.
- [x] Verify table and date-grouped work queues at the current desktop target viewports (1024px and 1440px).

**Dependencies:** Task 15

**Files likely touched:** `src/server/admin/operations/work-order-repository.mjs`, `src/server/admin/operations/work-order-service.mjs`, `src/server/admin/operations/work-order-routes.mjs`, `src/web/admin/js/pages/work-order-page.mjs`, `tests/integration/admin-work-orders.test.mjs`

**Estimated scope:** Medium

## Task 17: Deliver subscription and service-account management

**Description:** Create or update service subscriptions from completed orders, track every subscription state, and manage safe line-account metadata without storing secrets.

**Acceptance criteria:**

- [x] Order completion creates/links at most one subscription with preserved recurring fee, period, source order, customer, and location.
- [x] Subscription transitions append history; line accounts never store or return plaintext passwords/tokens.
- [x] Stale, duplicate, invalid, or unauthorized lifecycle updates leave subscription and history state unchanged.

**Verification:**

- [x] Run lifecycle, secret-field, duplicate completion, concurrency, permission, and rollback tests.
- [x] Verify subscription tabs link order, work order, line account, and history at 1024px and 1440px.

**Dependencies:** Task 16

**Files likely touched:** `src/server/admin/subscriptions/subscription-repository.mjs`, `src/server/admin/subscriptions/subscription-service.mjs`, `src/server/admin/subscriptions/subscription-routes.mjs`, `src/web/admin/js/pages/subscription-page.mjs`, `tests/integration/admin-subscriptions.test.mjs`

**Estimated scope:** Medium

## Task 18: Deliver outage incident and affected-subscription management

**Description:** Add incident creation, severity/status workflow, impacted subscription membership, affected counts, root cause, restoration time, and announcement draft data.

**Acceptance criteria:**

- [x] Only valid `INVESTIGATING → IDENTIFIED → MONITORING → RESOLVED` transitions and active impacted subscriptions are accepted.
- [x] Impact counts are derived from relationships, and concurrent add/remove operations remain unique and consistent.
- [x] Public announcement draft output contains no private customer, address, or account data.

**Verification:**

- [x] Run transition, membership, count, privacy, concurrency, permission, and rollback tests.
- [x] Verify incident detail and impacted-service views in browser at 1024px and 1440px.

**Dependencies:** Task 17 subscription foundation

**Files likely touched:** `src/server/admin/operations/outage-repository.mjs`, `src/server/admin/operations/outage-service.mjs`, `src/server/admin/operations/outage-routes.mjs`, `src/web/admin/js/pages/outage-page.mjs`, `tests/integration/admin-outages.test.mjs`

**Estimated scope:** Medium

## Task 19: Deliver invoice creation, batch generation, issue, and void workflows

**Description:** Add single and period-batch invoice generation from subscriptions, line-item totals, unique billing periods, issue/overdue/void behavior, and per-item batch results.

**Acceptance criteria:**

- [x] One subscription and billing period cannot be invoiced twice, including concurrent batch runs.
- [x] Subtotal plus tax equals total, and `balance_due` remains between zero and total using fixed-scale integer arithmetic.
- [x] Batch generation reports each success/failure without corrupting successful invoices or hiding partial results.

**Verification:**

- [x] Run duplicate-period, amount, status, batch partial-failure, permission, and rollback tests.
- [x] Generate, inspect, issue, and void eligible invoices in browser at 1024px and 1440px.

**Dependencies:** Task 17 subscription foundation

**Files likely touched:** `src/server/admin/billing/invoice-repository.mjs`, `src/server/admin/billing/invoice-service.mjs`, `src/server/admin/billing/invoice-routes.mjs`, `src/web/admin/js/pages/invoice-page.mjs`, `tests/integration/admin-invoices.test.mjs`

**Estimated scope:** Medium

## Task 20: Deliver payment posting and billing-adjustment approval

**Description:** Post payments atomically against invoice balance and add a maker-checker workflow for credits, charges, write-offs, and other manual adjustments.

**Acceptance criteria:**

- [x] Payment confirmation atomically inserts payment, updates balance/status, prevents overpayment/replay, and stores no card or banking secrets.
- [x] Adjustment applicant and approver differ by default, with separate permissions and immutable reasons/approval timestamps.
- [x] Concurrent payment/adjustment attempts serialize correctly and any failure restores invoice and ledger state.

**Verification:**

- [x] Run partial/full/overpayment, duplicate reference, concurrency, maker-checker, permission, privacy, and rollback tests.
- [x] Verify invoice payment history and adjustment approval views at 1024px and 1440px.

**Dependencies:** Task 19

**Files likely touched:** `src/server/admin/billing/payment-repository.mjs`, `src/server/admin/billing/payment-service.mjs`, `src/server/admin/billing/payment-routes.mjs`, `src/web/admin/js/pages/payment-page.mjs`, `tests/integration/admin-payments.test.mjs`

**Estimated scope:** Medium

## Task 21: Deliver stock-item, warehouse, balance, and stock-movement workflows

**Description:** Add stock/warehouse management, customer-equipment install/removal, and a single transactional movement service for receipt, issue, transfer, install, return, and adjustment.

**Acceptance criteria:**

- [x] Available quantity is derived consistently from on-hand and reserved values; low and negative stock use text warnings.
- [x] Each movement atomically appends a ledger row and updates all affected warehouse balances with idempotency protection; equipment install/removal updates customer equipment in the same transaction.
- [x] Unauthorized negative stock, invalid source/destination, and concurrent oversubscription fail without partial balances.

**Verification:**

- [x] Run every movement type plus equipment install/removal, low-stock, negative, idempotency, concurrency, permission, and rollback tests.
- [x] Reconcile displayed balances against summed movements after browser actions at 1024px and 1440px.

**Dependencies:** Tasks 6 and 17

**Files likely touched:** `src/server/admin/inventory/inventory-repository.mjs`, `src/server/admin/inventory/inventory-service.mjs`, `src/server/admin/inventory/inventory-routes.mjs`, `src/web/admin/js/pages/inventory-page.mjs`, `tests/integration/admin-inventory.test.mjs`

**Estimated scope:** Medium

## Task 22: Deliver CMS draft, preview, publish, and unpublish workflows

**Description:** Manage banners, pages, and announcements with scheduling, ordering, previews, and public publication using plain text or an explicitly approved safe markup subset.

**Acceptance criteria:**

- [x] Draft content stays private; only valid active publication windows appear on public endpoints/pages.
- [x] Stored and reflected XSS payloads render as inert text unless accepted by an approved allowlist.
- [x] Publish/unpublish actions require distinct permission, optimistic conflict protection, and audit records.

**Verification:**

- [x] Run draft/publication/schedule/order, XSS, permission, concurrency, and public regression tests.
- [x] Preview 1024px/1440px desktop content and confirm public visibility boundaries; mobile verification is paused by user scope.

**Dependencies:** Tasks 4 and 6; rich HTML requires the decision gate in `tasks/plan.md`

**Files likely touched:** `src/server/admin/content/content-repository.mjs`, `src/server/admin/content/content-service.mjs`, `src/server/admin/content/content-routes.mjs`, `src/web/admin/js/pages/content-page.mjs`, `tests/security/admin-content.test.mjs`

**Estimated scope:** Medium

## Task 23: Deliver staff/role administration and read-only audit exploration

**Description:** Manage active staff profiles and role assignments, display the permission matrix, revoke affected sessions, and provide an immutable audit search/detail interface.

**Acceptance criteria:**

- [x] Role assignment changes require `role.manage`, cannot remove the last active super administrator, and invalidate affected sessions.
- [x] Staff deletion requires `role.manage`, optimistic concurrency, confirmation, and audit; self, last-admin, and referenced accounts fail closed with a safe disable-account alternative.
- [x] Audit APIs expose allowlisted, masked, read-only fields with bounded filters and no update/delete routes.
- [x] Every staff/role change records actor, target, before/after allowlists, request ID, and time.

**Verification:**

- [x] Run last-admin, session invalidation, escalation denial, audit masking, pagination, and immutability tests.
- [x] Run staff deletion permission, self-delete, referenced-record, stale-version, rollback, and desktop confirmation-dialog tests.
- [x] Verify permission matrix and audit explorer using admin and auditor roles at 1024px/1440px desktop widths.

**Dependencies:** Tasks 3–4 and 6

**Files likely touched:** `src/server/admin/access/access-repository.mjs`, `src/server/admin/access/access-service.mjs`, `src/server/admin/access/access-routes.mjs`, `src/web/admin/js/pages/access-page.mjs`, `tests/security/admin-access.test.mjs`

**Estimated scope:** Medium

## Task 24: Add a versioned incremental migration runner and rollback proof

**Description:** Introduce an ordered migration runner for existing `telecom_boss.sqlite` files so Catalog V2 can be added without invoking the current rebuild-only migration path.

**Acceptance criteria:**

- [x] The runner applies each pending version once inside a transaction and rejects duplicate, missing, or out-of-order versions.
- [x] Existing databases require a verified backup destination before schema changes; failure leaves the original database byte-for-byte recoverable.
- [x] A rollback rehearsal on a copied seeded database restores schema version, row counts, foreign keys and integrity.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/incremental-migration.test.mjs`.
- [x] Run `npm run check` and inspect a backup/restore rehearsal report.

**Dependencies:** Task 23

**Files likely touched:** `src/server/db/migration-runner.mjs`, `src/server/db/sqlite.mjs`, `scripts/migrate.mjs`, `tests/integration/incremental-migration.test.mjs`, `README.md`

**Estimated scope:** Medium

## Task 25: Create the normalized Catalog V2 schema

**Description:** Add the ten Catalog V2 tables defined in `tasks/plan.md` with explicit keys, relationships, publish-state checks and query indexes while preserving all 39 operational tables.

**Acceptance criteria:**

- [x] Category, product, content, section, media, spec, brand and promotion-link tables match the target schema and use prepared, reversible migration SQL.
- [x] Unique codes/slugs/source links, maximum publication dates, one primary category/image, and every FK/index invariant are database- or transaction-enforced.
- [x] Migration adds no remote connection, removes no legacy column/table and passes `PRAGMA integrity_check` plus `foreign_key_check`.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/catalog-v2-schema.test.mjs`.
- [x] Compare the migrated SQLite schema to the table/index/constraint matrix in `tasks/plan.md`.

**Dependencies:** Task 24

**Files likely touched:** `src/server/db/catalog-v2-migration.mjs`, `src/server/db/constraint-overlays.mjs`, `tests/integration/catalog-v2-schema.test.mjs`, `docs/architecture.md`

**Estimated scope:** Medium

## Task 26: Backfill existing plans and sellable stock into Catalog V2

**Description:** Create deterministic Catalog V2 products and categories for existing `service_plans` and sellable `stock_items` without changing their IDs, amounts, references or histories.

**Acceptance criteria:**

- [x] Every existing plan and eligible stock item maps to one product through a stable unique source FK and deterministic code/slug.
- [x] Re-running backfill produces zero duplicates and preserves plan prices, promotion links, stock balances, order snapshots and inquiry/subscription references.
- [x] Legacy public/admin catalog reads remain unchanged until the later cutover task.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/catalog-v2-backfill.test.mjs`.
- [x] Reconcile before/after row counts, amounts, source IDs and reference hashes on a copied seeded database.

**Dependencies:** Task 25

**Files likely touched:** `src/server/db/catalog-v2-backfill.mjs`, `src/server/db/seed.mjs`, `scripts/seed.mjs`, `tests/integration/catalog-v2-backfill.test.mjs`, `database/seeds/README.md`

**Estimated scope:** Medium

## Task 27: Deliver product and category administration APIs

**Description:** Add fixed Catalog V2 admin endpoints for category trees, product lists/details, source linking and publication transitions.

**Acceptance criteria:**

- [x] `catalog.manage` gates every route; category create/move rejects cycles, depth over four and disabled-parent publication.
- [x] Product create/update/archive/publish uses field allowlists, optimistic versions, valid source-type links and append-only audit records.
- [x] Search, filters, sorting and pagination are bounded and return fixed DTOs without raw SQL/schema fields.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/admin-products.test.mjs`.
- [x] Run permission, CSRF, IDOR, stale-write, cycle, duplicate-code/slug and rollback cases.

**Dependencies:** Tasks 4, 6 and 26

**Files likely touched:** `src/server/admin/products/product-repository.mjs`, `src/server/admin/products/product-service.mjs`, `src/server/admin/products/product-routes.mjs`, `src/server/http/server.mjs`, `tests/integration/admin-products.test.mjs`

**Estimated scope:** Medium

## Task 28: Deliver the desktop product and category workspace

**Description:** Add a 1024px/1440px admin workspace for category navigation, product list/detail, source links, status, preview, publish and archive actions.

**Acceptance criteria:**

- [x] Catalog managers can add/move categories and create/edit products with field-specific validation guidance and visible save/conflict states.
- [x] Destructive/archive/publication actions use confirmation, keyboard focus management and permission-aware controls.
- [x] Existing plan and inventory pages remain available while Catalog V2 is being verified.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/admin-shell.test.mjs`.
- [x] Browser-check keyboard, focus, console and network behavior at 1024px and 1440px.

**Dependencies:** Task 27

**Files likely touched:** `src/web/admin/js/pages/product-page.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/index.html`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 29: Deliver content, section, media, specification, and brand APIs

**Description:** Add explicit nested APIs for localized product content/SEO, ordered sections, images, specs and reusable brands.

**Acceptance criteria:**

- [x] Content and sections reject arbitrary HTML; media accepts only bounded same-origin/HTTPS URLs with required alt text.
- [x] Section/media/spec ordering, single primary image and product/brand uniqueness update transactionally with optimistic conflict checks.
- [x] All writes require `catalog.manage`, produce safe audits and cannot mutate plan pricing, inventory or order snapshots.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/security/admin-product-content.test.mjs`.
- [x] Run XSS, unsafe-URL, ordering, duplicate, permission, stale-write and rollback cases.

**Dependencies:** Tasks 4 and 27

**Files likely touched:** `src/server/admin/products/content-repository.mjs`, `src/server/admin/products/content-service.mjs`, `src/server/admin/products/content-routes.mjs`, `src/server/http/server.mjs`, `tests/security/admin-product-content.test.mjs`

**Estimated scope:** Medium

## Task 30: Deliver the desktop product-content editor

**Description:** Add the product detail tabs for SEO/content, ordered overview sections, images, specifications and brands using reusable admin form/dialog primitives.

**Acceptance criteria:**

- [x] Editors can manage every Catalog V2 content child and immediately see the same safe preview projection used by the public API.
- [x] Validation identifies the exact field and repair action; unsaved, loading, empty, conflict and server-error states are visible.
- [x] Keyboard order, dialog focus return and 1024px/1440px layouts remain usable without mobile-specific expansion.

**Verification:**

- [x] Run the product-content browser contract cases in `tests/integration/admin-shell.test.mjs`.
- [x] Browser-check content creation/update, validation repair, preview, delete confirmation/focus return, keyboard tabs, 1024px/1440px layouts and console behavior; automated API tests verify media reorder and delete persistence.

**Dependencies:** Tasks 28 and 29

**Files likely touched:** `src/web/admin/js/pages/product-content-page.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/index.html`, `src/web/admin/css/components.css`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 31: Deliver the public Catalog V2 API with reconciled prices and promotions

**Description:** Add bounded public product list/detail endpoints that expose only live Catalog V2 products and resolve operational plan prices, promotions and stock-backed selling prices.

**Acceptance criteria:**

- [x] Public queries exclude draft, archived, future, expired, disabled-category and invalid-source products.
- [x] Fixed DTOs include safe category, content, media, specs and resolved pricing/promotion fields without internal IDs, costs or audit data.
- [x] Plan price/promotion and stock values reconcile exactly with their source tables; public queries remain prepared and bounded.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/product-catalog-v2.test.mjs tests/security/public-product-catalog.test.mjs`.
- [x] Compare seeded plan price, promotion and stock selling-price projections to direct reviewed source queries; verify the list cap does not hide a valid detail route.

**Dependencies:** Tasks 26 and 29

**Files likely touched:** `src/server/services/product-catalog-service.mjs`, `src/server/http/public-routes.mjs`, `tests/integration/product-catalog-v2.test.mjs`, `tests/security/public-product-catalog.test.mjs`, `docs/api.openapi.json`

**Estimated scope:** Medium

## Task 32: Cut the public product pages over to Catalog V2 with rollback coverage

**Description:** Render public product navigation, cards and detail content from the Catalog V2 API while retaining a tested configuration switch to the legacy plan projection during the verification window.

**Acceptance criteria:**

- [x] Product cards/detail show category, safe media, content, specs, current price/promotion and the correct inquiry CTA from live API data.
- [x] Loading, empty, stale-link and API-error states are accessible and no user content is inserted through `innerHTML`.
- [x] Legacy and V2 paths are contract-tested until cutover reconciliation passes; switching back requires no data rollback.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/catalog-site.test.mjs`.
- [x] Browser-check public list/detail/inquiry flows at 1024px/1440px with clean console and expected network requests.

**Dependencies:** Tasks 30 and 31

**Files likely touched:** `src/web/assets/app.mjs`, `src/web/index.html`, `src/web/assets/styles/app.css`, `tests/integration/catalog-site.test.mjs`, `src/server/main.mjs`

**Estimated scope:** Medium

## Task 33: Generate and, after approval, synchronize the CSMU catalog schema

**Description:** Generate a deterministic `yk-schema-db` artifact that maps Catalog V2 to CSMU, then update the approved remote product database only after a fresh backup and semantic diff.

**Acceptance criteria:**

- [x] The artifact defines every required table, column, relation and index note and records the crosswalk from `project_db`/`yankees_service_cms` to Catalog V2.
- [ ] Remote work never deletes or rewrites `project_db`, `telecom_boss` or `website_db`; a new export is saved and compared immediately before any approved metadata write.
- [ ] After approval, `yankees_service_cms` is reloaded and every expected table/column/relation is verified individually; without approval this task stays pending.

**Verification:**

- [x] Run `node --disable-warning=ExperimentalWarning --test tests/integration/csmu-catalog-schema.test.mjs`.
- [ ] Record artifact fingerprint, pre-write backup fingerprint and post-write live tree/column/relation evidence.

**Dependencies:** Tasks 25 and 32; remote synchronization requires explicit user approval

**Files likely touched:** `scripts/export-csmu-catalog-schema.mjs`, `database/snapshots/yankees_service_cms.schema.json`, `tests/integration/csmu-catalog-schema.test.mjs`, `docs/architecture.md`, `docs/verification.md`

**Estimated scope:** Medium

## Task 34: Add desktop work-order calendar and kanban views

**Description:** Present the existing work-order queue as desktop calendar and kanban views without changing workflow rules or duplicating work-order state.

**Acceptance criteria:**

- [x] Queue, calendar and kanban show the same authorized work orders and transitions.
- [x] Date, status and assignee filters are bounded and preserve the current URL/view state.
- [x] Keyboard navigation and focus remain usable at 1024px/1440px.

**Verification:**

- [x] Run work-order and admin-shell integration tests.
- [x] Browser-check queue/calendar/kanban parity and transitions.

**Dependencies:** Task 16

**Files likely touched:** `src/web/admin/js/pages/work-order-page.mjs`, `src/web/admin/index.html`, `src/web/admin/css/components.css`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 35: Add permission-aware global search and quick navigation

**Description:** Add a bounded desktop command/search surface that queries only modules the signed-in user may read and navigates to explicit module detail routes.

**Acceptance criteria:**

- [x] Search calls only permitted fixed module APIs and never leaks result counts or labels from hidden modules.
- [x] Queries are debounced, length-limited and provide loading, empty and error states.
- [x] Keyboard selection moves focus to the selected module/detail safely.

**Verification:**

- [x] Run cross-role search visibility and admin-shell tests.
- [x] Browser-check keyboard-only global search and navigation.

**Dependencies:** Tasks 5–23 and 32

**Files likely touched:** `src/web/admin/js/admin-app.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/index.html`, `src/web/admin/css/components.css`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 36: Add a bounded masked-customer CSV export API

**Description:** Add an explicit customer export endpoint that reuses reviewed filters, masks PII, escapes spreadsheet formulas and records safe audit metadata.

**Acceptance criteria:**

- [x] `customer.read` and caller field permissions apply to every exported row/column with fixed maximum size.
- [x] Phone, email and address are masked and formula-leading cells are escaped; no identity hash/encrypted data enters output.
- [x] Audit records actor, filters, column set and row count without PII.

**Verification:**

- [x] Run export authorization, masking, injection, limit and audit tests.
- [x] Parse representative CSVs and compare filtered row counts.

**Dependencies:** Tasks 4, 10 and 23

**Files likely touched:** `src/server/admin/customers/customer-repository.mjs`, `src/server/admin/customers/customer-service.mjs`, `src/server/admin/customers/customer-routes.mjs`, `src/server/http/responses.mjs`, `tests/security/admin-exports.test.mjs`

**Estimated scope:** Medium

## Task 37: Add the desktop customer-export workflow

**Description:** Add a customer-list export action that carries active filters to the bounded API and reports download success or actionable errors.

**Acceptance criteria:**

- [x] Export uses current reviewed filters and exposes no unmasked/bulk bypass.
- [x] Disabled, loading, success and failure states are visible and keyboard reachable.
- [x] Permission loss or expired sessions stop the download and return to the safe login flow.

**Verification:**

- [x] Run customer-page/admin-shell contract tests.
- [x] Download and inspect a representative masked CSV in the browser.

**Dependencies:** Task 36

**Files likely touched:** `src/web/admin/js/api-client.mjs`, `src/web/admin/js/pages/customer-page.mjs`, `src/web/admin/index.html`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Small

## Task 38: Add reconciled operational reporting APIs

**Description:** Add fixed reports for inquiries, open work, overdue invoices, low stock and expiring promotions with explicit time/filter definitions.

**Acceptance criteria:**

- [x] Each report applies module permissions and bounded Asia/Taipei date ranges.
- [x] Responses include `asOf`, filters, units/denominators and source totals for reconciliation.
- [x] Report totals match reviewed source queries at the same grain and cutoff.

**Verification:**

- [x] Run report permission, boundary-date and source-reconciliation tests.
- [x] Compare seeded report results to direct SQL queries.

**Dependencies:** Tasks 7–23 and 32

**Files likely touched:** `src/server/admin/reports/report-repository.mjs`, `src/server/admin/reports/report-service.mjs`, `src/server/admin/reports/report-routes.mjs`, `src/server/http/server.mjs`, `tests/integration/admin-reports.test.mjs`

**Estimated scope:** Medium

## Task 39: Add the desktop operational-report workspace

**Description:** Add desktop report cards and tables with date filters, definitions and as-of labels based only on the fixed report API.

**Acceptance criteria:**

- [x] Users see only permitted report sections and clear metric definitions/as-of times.
- [x] Date validation, loading, empty and error states identify the corrective action.
- [x] Displayed totals reconcile with API source totals at 1024px/1440px.

**Verification:**

- [x] Run report-page/admin-shell tests.
- [x] Browser-check filters, permissions, tables, console and network behavior.

**Dependencies:** Task 38

**Files likely touched:** `src/web/admin/js/pages/report-page.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/index.html`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 40: Add permission-filtered in-app notification APIs

**Description:** Derive bounded in-app notifications from expiring promotions, open work, overdue invoices and low stock without external delivery.

**Acceptance criteria:**

- [x] Notifications are generated only from modules the caller may read and use fixed non-PII DTOs.
- [x] Results are bounded, deterministic and link only to authorized internal destinations.
- [x] No email/SMS/push provider or retry queue is introduced.

**Verification:**

- [x] Run cross-role visibility, limit, ordering and PII-leak tests.
- [x] Compare notification counts to their reviewed source queries.

**Dependencies:** Tasks 12, 16, 19, 21, 23 and 32

**Files likely touched:** `src/server/admin/notifications/notification-repository.mjs`, `src/server/admin/notifications/notification-service.mjs`, `src/server/admin/notifications/notification-routes.mjs`, `src/server/http/server.mjs`, `tests/security/admin-notifications.test.mjs`

**Estimated scope:** Medium

## Task 41: Add the desktop notification center

**Description:** Add a top-bar badge and desktop notification panel grouped by type with authorized links to existing workspaces.

**Acceptance criteria:**

- [x] Badge, panel and groups reflect only the permission-filtered API response.
- [x] Keyboard open/close, focus return, loading, empty and error states are accessible.
- [x] Links preserve module state and fail safely if permission changes.

**Verification:**

- [x] Run notification/admin-shell contract tests.
- [x] Browser-check cross-role badge counts, focus and destination links.

**Dependencies:** Task 40

**Files likely touched:** `src/web/admin/js/pages/notification-page.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/index.html`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 42: Add a read-only system health and recovery-information workspace

**Description:** Surface existing database health plus documented backup/restore and operator information without exposing secrets, file paths or destructive browser controls.

**Acceptance criteria:**

- [x] The workspace reports service/metadata/telecom health using existing safe endpoints.
- [x] Recovery instructions point to reviewed operator commands and never execute backup/restore from the browser.
- [x] Paths, credentials, tokens and internal stack details remain hidden.

**Verification:**

- [x] Run health/admin-shell and safe-error projection tests.
- [x] Browser-check healthy and simulated degraded states at desktop widths.

**Dependencies:** Tasks 2, 5 and 24

**Files likely touched:** `src/web/admin/js/pages/system-page.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/index.html`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** Medium

## Task 43: Integrate approved production SSO and invalidate changed sessions

**Description:** After explicit provider/environment approval, replace production development-login access with verified SSO/LDAP mapping and secure session lifecycle.

**Acceptance criteria:**

- [ ] Production startup cannot enable development login and accepts only callbacks bound to configured redirect/state/nonce values.
- [ ] Account disablement or role changes revoke sessions; high-risk actions can require recent authentication.
- [ ] Tokens/secrets use approved external storage and never enter SQLite, browser storage, logs or Git.

**Verification:**

- [ ] Run provider contract, callback forgery, replay, fixation, revocation, expiry and logout tests.
- [ ] Complete a documented production-mode sign-in/sign-out and revocation walkthrough.

**Dependencies:** Task 23 and explicit user approval

**Files likely touched:** `src/server/admin/auth/sso-provider.mjs`, `src/server/admin/auth/auth-service.mjs`, `src/server/admin/auth/auth-routes.mjs`, `docs/authentication.md`, `tests/security/admin-sso.test.mjs`

**Estimated scope:** Medium

## Task 44: Complete security, accessibility, performance, recovery, and deployment handoff

**Description:** Run the final automated/browser/recovery matrix and synchronize API, schema, permission, operations and approved deployment documentation.

**Acceptance criteria:**

- [ ] Authorization, CSRF, IDOR, injection, XSS, privacy, migration, transaction, concurrency and audit controls pass.
- [ ] Desktop admin/public workflows pass keyboard, accessibility tree, console, network and bounded-query checks; deferred mobile scope is documented.
- [ ] OpenAPI, CSMU crosswalk, permission matrix, recovery drill, limitations and requirement traceability contain direct evidence.

**Verification:**

- [ ] Run `npm run check` and `npm test` after the final source change.
- [ ] Execute and record desktop browser, backup/restore, rollback and approved deployment smoke tests.

**Dependencies:** Tasks 1–43; deployment checks require explicit approval

**Files likely touched:** `docs/api.openapi.json`, `docs/architecture.md`, `docs/verification.md`, `docs/requirements-traceability.md`, `README.md`

**Estimated scope:** Medium

## Task 45: Add the shared desktop showcase shell and fiber-broadband service page

**Description:** Establish one reusable public header, breadcrumb, footer, quote-link contract, and Signal Atlas design layer, then use it for the first standalone fiber service page.

**Acceptance criteria:**

- [x] `/services/fiber-broadband.html` has a clear service outcome, one primary CTA, a return path, and reviewed broadband copy without invented prices or availability.
- [x] Shared navigation and quote links preserve `intent` and optional `product` context without duplicating page CSS or form markup.
- [x] Static markup uses semantic landmarks, visible keyboard focus, and no unsafe inline handlers.

**Verification:**

- [x] Add a red static-shell test, then run its focused test.
- [x] Browser-check the fiber page and its quote handoff at 1024px and 1440px.

**Dependencies:** Task 32

**Files likely touched:** `src/web/assets/showcase-shell.mjs`, `src/web/assets/styles/showcase.css`, `src/web/services/fiber-broadband.html`, `tests/integration/showcase-pages.test.mjs`

**Estimated scope:** Medium

## Task 46: Add the remaining four standalone service pages using the shared shell

**Description:** Use the shared shell for enterprise connectivity, subscription rental, low-voltage engineering, and AV integration pages with one job and one clear quote action per page.

**Acceptance criteria:**

- [x] Each service has an independent `.html` URL, breadcrumb, relevant service outcomes, process, related-page route, and quote CTA.
- [x] Copy distinguishes service design/maintenance from purchasable equipment and clearly labels site-survey or quotation steps.
- [x] No page introduces database access, unreviewed brands, price claims, or a separate navigation implementation.

**Verification:**

- [x] Extend the focused static-shell test for every service route.
- [x] Browser-check representative engineering and rental journeys at 1024px and 1440px.

**Dependencies:** Task 45

**Files likely touched:** `src/web/services/enterprise-connectivity.html`, `src/web/services/subscription-rental.html`, `src/web/services/low-voltage-engineering.html`, `src/web/services/av-integration.html`, `tests/integration/showcase-pages.test.mjs`

**Estimated scope:** Medium

## Task 47: Add the data-driven product catalog page with shareable category URL state

**Description:** Create the independent public catalog page using the existing Catalog V2 list endpoint and client-side, allowlisted category filtering reflected in the URL.

**Acceptance criteria:**

- [x] `/products/catalog.html` renders only the fixed public DTO with loading, empty, error, and retry states.
- [x] Selecting a category updates only the reviewed `category` URL value and produces shareable catalog results.
- [x] Product cards disclose purpose, category, two concise facts when available, and a detail/quote path without exposing hidden fields.

**Verification:**

- [x] Add red list-state/render tests and run focused public catalog tests.
- [x] Browser-check filter, URL restoration, empty/error messaging, and keyboard actions at desktop widths.

**Dependencies:** Tasks 31 and 45

**Files likely touched:** `src/web/products/catalog.html`, `src/web/assets/product-catalog.mjs`, `src/web/assets/styles/showcase.css`, `tests/integration/showcase-pages.test.mjs`, `tests/unit/showcase-ui.test.mjs`

**Estimated scope:** Medium

## Task 48: Add the standalone product-detail template and fixed public plan detail pages

**Description:** Render a reusable product detail experience from the existing safe product-detail DTO and place the currently published plan entry pages at fixed `.html` locations.

**Acceptance criteria:**

- [x] Detail pages render only safe media, summary, specifications, promotions, brands, related catalog/service routes, and a context-preserving quote CTA.
- [x] Valid, missing, unavailable, loading, and network-error states direct a visitor to a safe next action.
- [x] Fixed plan page URLs use the same shared template and never require PHP or duplicate data into HTML.

**Verification:**

- [x] Add red detail-route/projection tests and run focused tests.
- [x] Browser-check detail-to-quote and stale-link recovery at 1024px and 1440px.

**Dependencies:** Task 47

**Files likely touched:** `src/web/products/detail.html`, `src/web/products/services-broadband/plan-vdsl2-100m.html`, `src/web/products/services-broadband/plan-ftth-300m.html`, `src/web/products/services-broadband/plan-ftth-500m.html`, `src/web/assets/product-detail.mjs`

**Estimated scope:** Medium

## Task 49: Connect homepage service entries and quote handoff, then verify the complete desktop journey

**Description:** Surface the completed service/product pages from the homepage without breaking the existing plan dialog, form validation, or selected-plan behavior.

**Acceptance criteria:**

- [x] Homepage visitors can enter services or catalog pages and each return/quote route preserves intent and product context into `/#apply`.
- [x] Existing homepage plan selection/dialog behavior remains unchanged and public page queries are bounded and safe.
- [x] Requirement traceability records direct desktop evidence; mobile-specific design stays explicitly deferred.

**Verification:**

- [x] Run `npm run check`, `npm test`, and public-site regression tests.
- [x] Browser-check homepage → service/product → quote → homepage on 1024px and 1440px with Console/network review.

**Dependencies:** Tasks 45–48

**Files likely touched:** `src/web/index.html`, `src/web/assets/app.mjs`, `docs/requirements-traceability.md`, `tests/integration/catalog-site.test.mjs`, `tests/integration/showcase-pages.test.mjs`

**Estimated scope:** Medium

## Task 50: Add category-detail editing and guarded permanent product deletion

**Description:** Complete the Catalog V2 admin workspace with an editable selected-category form and an explicitly confirmed, permission-gated product deletion flow.

**Acceptance criteria:**

- [x] The selected category form edits code, slug, name, description, sort order and active state using the existing optimistic-version API.
- [x] Only `DRAFT` or `ARCHIVED` products can be permanently deleted; published and scheduled products are rejected by both the UI and service.
- [x] Deletion requires `catalog.manage`, CSRF and `expectedVersion`, cascades Catalog V2 child rows atomically, and records a `PRODUCT_DELETED` audit event.
- [x] Audit failure or stale version rolls the transaction back without deleting the product.

**Verification:**

- [x] Focused repository, route, rollback and admin-shell tests pass.
- [ ] Run `npm run check`, `npm test`, and production browser/API verification after deployment.

**Dependencies:** Tasks 27–28

**Files likely touched:** `src/server/admin/products/*.mjs`, `src/web/admin/index.html`, `src/web/admin/js/admin-app.mjs`, `src/web/admin/js/api-client.mjs`, `src/web/admin/js/pages/product-page.mjs`, `tests/integration/admin-products.test.mjs`, `tests/integration/admin-shell.test.mjs`

**Estimated scope:** High
