# Step 4 — MySQL Transaction Consistency Audit

## Scope

This audit covers runtime write consistency after the Step 3 MySQL adapter conversion. The primary goal is to prevent partial commits when a business operation performs one or more writes and only later discovers a conflict or validation failure.

## Key finding

The Step 3 runtime already used one MySQL named write lock per database plus a SQL transaction. That greatly reduced concurrent write races, but several repository callbacks returned a business failure result after earlier statements had already modified data. A normal transaction commits when its callback returns successfully, regardless of whether the returned object says `kind: 'conflict'`.

Examples included:

- payment inserted, then invoice optimistic update could return conflict;
- adjustment approval could change invoice/ledger before the request version check failed;
- outage membership could change before the incident version update failed;
- account/role and Catalog compound writes could return a late conflict after an earlier write.

The global named lock usually masked these paths during normal application concurrency, but correctness must not depend on that implementation detail.

## Change

`runAtomicResult()` was added in `src/server/db/runtime-database.mjs`.

It executes the repository callback inside the existing database transaction. If the callback returns a business-result object whose `kind` is not an approved success result, it raises an internal rollback signal. The database adapter therefore rolls the whole transaction back. The signal is then converted back to the original business result after rollback, so Service and Route behavior does not change.

Committed result kinds are currently:

- `created`
- `updated`
- `deleted`
- `replayed`
- `converted`
- `found`
- `resolved`

Other `kind` values are treated as failed business outcomes and force rollback.

## Coverage

All Admin repository write transactions now use `runAtomicResult()` rather than the plain transaction helper.

Audit counts:

- 18 Admin write repository files inspected
- 58 rollback-aware transaction call sites
- 0 remaining plain `runInTransaction(database, ...)` calls under `src/server/admin`

The protection applies to the main compound-write areas, including:

- orders and order workflow
- invoices, payments, and billing adjustments
- inventory movements and customer equipment
- inquiry workflow and inquiry conversion
- subscriptions and service accounts
- outages and work orders
- customers and access control
- plan/pricing administration
- Catalog V2 product/category/content/brand/media/spec writes
- CMS content writes

## Concurrency model after Step 4

The MySQL adapter still retains the database-wide named write lock introduced in Step 3. Therefore this step prioritizes correctness and backward-compatible behavior rather than write throughput.

Current write path:

1. acquire MySQL named lock for the target database;
2. begin SQL transaction;
3. execute repository writes;
4. commit only for a successful business result;
5. rollback for exceptions or failure result kinds;
6. release named lock and connection.

A later performance-focused step may safely replace the broad named lock with aggregate/row-level locking after real MySQL concurrency testing. That optimization is intentionally not mixed into this consistency repair.

## Tests added

`tests/unit/runtime-atomic-result.test.mjs`

- successful result commits;
- late conflict rolls back but is returned to the caller;
- validation/business failure kinds roll back partial state;
- thrown failures still roll back and propagate.

`tests/unit/transaction-boundary-audit.test.mjs`

- fails if an Admin write repository goes back to the plain transaction helper;
- verifies the known high-risk modules use rollback-aware transactions.

## Verification

Final project validation:

- `npm run check`: PASS
- complete regression suite: 236 passed, 0 failed
- Step 3 baseline: 230 passed
- Step 4 new tests: 6 passed

## Remaining validation before production

The repository layer is now transaction-safe by result semantics, but production deployment should still perform a real MySQL 8 smoke/concurrency test against a staging copy. In particular, test simultaneous payment, stock movement, invoice transition, order submission, and Catalog edits using multiple application connections before considering removal or narrowing of the database-wide named write lock.
