# Production Smoke / Deployment Verification — Step 6

## Scope

Step 6 adds deployment verification without weakening production security. It does not connect to or modify a remote VM by itself.

## Pre-deployment gates

1. `npm run check`
2. `npm test`
3. `npm run db:migrate:mysql:dry` with the migration account.
4. Verify a current MySQL backup exists before any pending migration.
5. Apply MySQL migration using `intern_migrate` only when the dry run reports a pending migration.
6. Switch back to the runtime environment using `DB_USER=intern`.

## Real MySQL runtime smoke

Run with the production runtime environment loaded:

```bash
npm run smoke:mysql
```

The command checks both required migrations, reads representative operational/Catalog tables, and performs one Catalog write inside a transaction that is deliberately rolled back. A successful run must leave no smoke row behind.

## HTTP smoke

After systemd starts the application:

```bash
npm run smoke:http
```

This verifies health, Catalog V2 and the unauthenticated Admin bootstrap contract. `SMOKE_BASE_URL` defaults to `http://127.0.0.1:4173`.

## Host verification

```bash
npm run verify:host
```

This script is read-only. It checks Node.js, systemd state, Apache configuration syntax, Apache site enablement, loopback binding, local health/Catalog endpoints and prints recent service logs.

Environment overrides:

- `SERVICE_NAME` (default `telecom-site.service`)
- `APACHE_SITE` (default `telecom-site.conf`)
- `SMOKE_BASE_URL` (default `http://127.0.0.1:4173`)

## Historical Step 6 Production Admin authentication blocker

At Step 6, the application contained only the development-login endpoint. Production correctly rejects `ENABLE_DEVELOPMENT_LOGIN=true`, and there is no implemented OIDC/SSO or production credential login route yet. Therefore Step 6 cannot truthfully mark Production Admin login or authenticated Admin HTTP CRUD as passed.

Do not enable development login in Production to bypass this gate. Before external production use, integrate the intended identity provider and then add authenticated Admin smoke cases for at least session bootstrap, Catalog read, order read, invoice read and one reversible/controlled write workflow.

## Expected result before go-live

- MySQL runtime smoke: PASS
- HTTP health: PASS
- Catalog API: PASS
- systemd: active/enabled
- Apache config: PASS
- Application socket: only `127.0.0.1:4173`
- Historical Step 6 result: Production Admin authentication was BLOCKED. Step 7 adds the production password-authentication path.
