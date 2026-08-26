# Production Admin Authentication — Step 7

## Result

Step 7 adds a production password login endpoint without changing the existing Session or RBAC model.

- Endpoint: `POST /api/v1/admin/auth/login`
- Identifier: staff number or company email
- Password KDF: Node.js 24 native Argon2id
- Argon2id: 19 MiB memory, 2 passes, parallelism 1, 32-byte tag, random 16-byte salt
- New-password length: 15–128 Unicode code points, NFC normalized
- Credential storage: `staff_password_credentials`; plaintext passwords are never stored
- Account throttle: 5 failures within 15 minutes locks the account for 15 minutes
- IP throttle: in-memory 10 attempts / 15 minutes limiter keyed by the trusted reverse-proxy client address
- Reverse-proxy trust: `X-Forwarded-For` is used only when Node sees the immediate peer as loopback; the rightmost valid address is used because Apache appends the directly connected client address
- Failure response: generic `AUTHENTICATION_FAILED` for unknown user, wrong password, and locked account
- Production session cookie: `HttpOnly; SameSite=Strict; Secure`
- Development login remains available only when explicitly enabled outside Production

Node.js added native `crypto.argon2()` in 24.7.0. Production currently targets Node.js 24.19.0.

The production topology assumes Apache is the only process that can reach Node on `127.0.0.1:4173`. Apache `mod_proxy_http` adds `X-Forwarded-For` by default. Do not expose port 4173 publicly, because the trusted-proxy client-IP rule intentionally trusts forwarded data only from a loopback peer.

## MySQL migration v3

Migration registry entry:

```text
3 | create_admin_password_auth
```

New table:

```text
staff_password_credentials
```

The table contains only the encoded password hash, failure counters, lock timing, and password-change timestamps. It has a one-to-one FK to `staff_users` with `ON DELETE CASCADE`.

## Deployment order

Do not restart the Step 7 server before v3 exists because runtime readiness now requires v1, v2, and v3.

1. Keep the current Step 6 service running.
2. Extract Step 7 into a staging directory and run `npm run check` and `npm test`.
3. Create a fresh `telecom_boss` MySQL backup.
4. Point `MYSQL_MIGRATION_BACKUP_PATH` at that new non-empty backup.
5. Load `/etc/telecom-site/migrate.env` and run `npm run db:migrate:mysql:dry`.
6. Run `npm run db:migrate:mysql`. v2 should report `already-applied`; v3 should report `applied` on first execution.
7. Verify `_schema_migrations` contains v3 and `staff_password_credentials` exists.
8. Verify `/usr/local/bin/node` exposes native Argon2: `node -e "const c=require('node:crypto'); console.log(typeof c.argon2)"` must print `function`.
9. Choose an existing active `staff_users` account that already has the intended RBAC role.
10. Set the initial password with `scripts/admin-password.mjs` using the runtime `intern` account.
11. Switch the Step 7 files into `/srv/telecom-site`, restore `root:telecom` ownership, then restart `telecom-site`.
12. Run `smoke:mysql`, `smoke:http`, `/health`, and `verify:host`.
13. Test `https://<host>/admin/` with the new staff number/email and password.

## Set or reset an admin password

Use the runtime environment, not `intern_migrate`. Do not put the password on the command line.

```bash
read -rsp "New admin password: " ADMIN_PASSWORD
echo
printf '%s\n' "$ADMIN_PASSWORD" | sudo -u telecom bash -c '
  set -a
  source /etc/telecom-site/telecom-site.env
  set +a
  cd /srv/telecom-site
  /usr/local/bin/node scripts/admin-password.mjs --staff-no=YOUR_STAFF_NO --stdin
'
unset ADMIN_PASSWORD
```

To generate a high-entropy initial password instead:

```bash
sudo -u telecom bash -c '
  set -a
  source /etc/telecom-site/telecom-site.env
  set +a
  cd /srv/telecom-site
  /usr/local/bin/node scripts/admin-password.mjs --staff-no=YOUR_STAFF_NO --generate
'
```

The generated password is printed once. Store it in the organization's approved password manager.

## Verification SQL

```sql
SELECT version, name FROM _schema_migrations ORDER BY version;

SELECT COUNT(*) AS credential_table_count
FROM information_schema.tables
WHERE table_schema = 'telecom_boss'
  AND table_name = 'staff_password_credentials';

SELECT s.id, s.staff_no, s.email, s.display_name, s.is_active,
       CASE WHEN c.staff_user_id IS NULL THEN 0 ELSE 1 END AS has_password
FROM staff_users AS s
LEFT JOIN staff_password_credentials AS c ON c.staff_user_id = s.id
ORDER BY s.id;
```

Do not select `password_hash` during routine operations.

## Security boundary

This removes the Step 6 production-login blocker, but it is still single-factor authentication. For an Internet-reachable administrative system, enterprise SSO/passkeys/MFA remain a later hardening step. Development login stays forbidden in Production.
