# MySQL Runtime Conversion — Step 3

## Scope

Step 3 converts the application data-access path from synchronous SQLite repositories to an asynchronous database abstraction that supports MySQL 8 in production.

The Catalog V2 schema migration itself remains Step 1/2 work. This step changes runtime reads and writes.

## Resulting architecture

```text
HTTP Route
   ↓ await
Service
   ↓ await
Repository
   ↓
Runtime Database Adapter
   ├─ production: mysql2/promise pool
   └─ test/dev: async SQLite compatibility adapter
```

Production uses two independent pools:

```text
Node.js
├─ metadataDatabase  → website_db
└─ telecomDatabase   → telecom_boss
```

Repositories no longer open a SQLite file themselves. They receive a runtime database object and use the same asynchronous interface for both engines.

## Files added for the runtime boundary

- `src/server/db/runtime-database.mjs`
  - asynchronous SQLite compatibility adapter
  - generic `openRuntimeDatabase()` facade
  - generic transaction entry point
- `src/server/db/mysql.mjs`
  - `mysql2/promise` pools
  - prepared-query facade
  - transaction connection pinning
  - named write lock
  - MySQL constraint error normalization
  - health/pool lifecycle operations
- `deploy/env/telecom-site.env.example`
  - production runtime environment example
- `tests/unit/mysql-runtime.test.mjs`
  - MySQL adapter behavior tests using a fake pool/connection
- `tests/unit/mysql-runtime-portability.test.mjs`
  - prevents direct SQLite imports and SQLite-only SQL from returning to runtime modules

## Repository conversion

All 21 Admin repository modules now expose asynchronous database operations. Service and route call chains were converted to `async/await` so a Promise is never treated as a completed database row.

The public runtime services were converted as well:

- catalog
- Catalog V2 product projection
- inquiries
- health

SQLite-only runtime SQL was removed, including `RETURNING`, `ON CONFLICT`, `strftime()` and `date('now')`. The one remaining `PRAGMA quick_check(1)` is isolated behind `database.kind === 'sqlite'` in the health service and is not executed by MySQL.

## MySQL transaction model

A write transaction performs these steps:

```text
pool.getConnection()
       ↓
GET_LOCK("telecom-runtime-write:<database>")
       ↓
beginTransaction()
       ↓
all transaction queries use the same connection
       ↓
commit() / rollback()
       ↓
RELEASE_LOCK()
       ↓
connection.release()
```

`AsyncLocalStorage` keeps repository calls inside the transaction pinned to the acquired connection. Nested service/repository transaction helpers reuse the current transaction instead of opening a second connection.

The named lock is intentionally conservative. It preserves the serialization guarantees required by existing multi-table flows while the application is being moved from SQLite to MySQL. A later optimization can reduce lock scope after every artificial ID-allocation or cross-table race has been removed.

## Constraint errors

The MySQL adapter maps common MySQL errors into semantics already understood by the service layer:

- `ER_DUP_ENTRY` → `constraintKind = "unique"`
- `ER_NO_REFERENCED_ROW_2` / `ER_ROW_IS_REFERENCED_2` → `constraintKind = "foreign-key"`
- `ER_CHECK_CONSTRAINT_VIOLATED` → `constraintKind = "check"`

Known unique keys are also translated to the existing `UNIQUE constraint failed: table.column` form where the service currently needs a precise field-level conflict message.

## Production environment

Use the runtime account, not the migration account:

```text
NODE_ENV=production
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=intern
DB_PASSWORD=<intern password>
WEBSITE_DB_NAME=website_db
TELECOM_DB_NAME=telecom_boss
DB_CONNECTION_LIMIT=10
DB_TRANSACTION_LOCK_TIMEOUT=15
PORT=4173
ENABLE_DEVELOPMENT_LOGIN=false
```

`intern_migrate` remains reserved for schema migration and backup/migration administration.

## Deployment order

1. Install dependencies with `npm install --omit=dev` (or `npm ci --omit=dev` once a lockfile is committed).
2. Back up the current MySQL databases.
3. Apply/verify MySQL migration v2 from Step 2 using `intern_migrate`.
4. Configure the runtime environment with `DB_DRIVER=mysql` and `DB_USER=intern`.
5. Run `npm run check`.
6. Run `npm test` in a safe staging/build environment.
7. Start the Node service.
8. Verify `/api/v1/health`, public Catalog V2 reads, an inquiry write, and representative Admin read/write flows against the real MySQL instance.

## Verification completed in this package

The local regression suite and the dedicated adapter tests pass. Dedicated MySQL adapter tests validate pool query normalization, transaction connection pinning, named-lock release, rollback, pool lifecycle, and MySQL constraint-error mapping without requiring a live MySQL server.

A live MySQL server was not available in the build environment, so real network authentication, server SQL mode, privileges, trigger execution and production data behavior still require a staging/VM smoke test before deployment.
