# MySQL Catalog V2 Migration v2

This migration adds the Catalog V2 schema to the existing `telecom_boss` MySQL database.
It expects the original MySQL v1 deployment to already be present.

## Safety model

- Runtime account `intern` is rejected by the migration command.
- Schema migration must run as `intern_migrate`.
- The database must already contain `_schema_migrations` with:
  - version `1`
  - name `create_telecom_schema`
- Required core tables must exist and use signed `BIGINT` IDs:
  - `staff_users`
  - `service_plans`
  - `stock_items`
  - `promotions`
- A MySQL named lock serializes schema migration attempts.
- Pending v2 requires an existing readable, non-empty backup file.
- MySQL DDL implicitly commits, so ordinary transaction rollback is not treated as sufficient.
  If v2 fails before its registry row is written, the runner executes the v2 down script as a compensating rollback.
- If Catalog V2 objects exist without a v2 registry row, the runner stops rather than guessing whether those objects contain valuable data.

## 1. Install runtime dependency

The MySQL runner uses `mysql2/promise`.

```bash
cd /srv/telecom-site
npm install --omit=dev --no-audit --no-fund
```

## 2. Dry run

Dry run does not connect to MySQL and does not require a password or backup.

```bash
npm run db:migrate:mysql:dry
```

The v2 plan should report:

```text
version: 2
name: create_catalog_v2_schema
up statements: 15
create tables: 10
create triggers: 2
down statements: 12
```

## 3. Create a MySQL backup before a pending migration

Example:

```bash
sudo mkdir -p /var/backups/telecom-site
sudo chmod 700 /var/backups/telecom-site

mysqldump --single-transaction --no-tablespaces \
  -u intern_migrate -p telecom_boss \
  > /var/backups/telecom-site/telecom_boss-before-catalog-v2.sql

sudo test -s /var/backups/telecom-site/telecom_boss-before-catalog-v2.sql
```

Do not put the password directly in shell history.

## 4. Migration environment

Copy the example:

```bash
sudo cp deploy/env/telecom-migrate.env.example /etc/telecom-site/migrate.env
sudo nano /etc/telecom-site/migrate.env
sudo chown root:root /etc/telecom-site/migrate.env
sudo chmod 600 /etc/telecom-site/migrate.env
```

Set at least:

```text
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=intern_migrate
DB_PASSWORD=<migration password>
TELECOM_DB_NAME=telecom_boss
MYSQL_MIGRATION_BACKUP_PATH=/var/backups/telecom-site/telecom_boss-before-catalog-v2.sql
DB_TRANSACTION_LOCK_TIMEOUT=15
```

## 5. Apply v2

```bash
sudo bash -c '
  set -a
  source /etc/telecom-site/migrate.env
  set +a
  cd /srv/telecom-site
  /usr/local/bin/npm run db:migrate:mysql
'
```

A first successful run returns `status: applied`.
A later run returns `status: already-applied` and does not recreate the tables.
An already-applied run does not require a fresh backup file.

## 6. Verify in MySQL

```sql
USE telecom_boss;

SELECT version, name, applied_at
FROM _schema_migrations
ORDER BY version;

SHOW TABLES LIKE 'catalog_%';

SELECT TRIGGER_NAME
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = 'telecom_boss'
  AND TRIGGER_NAME IN (
    'trg_catalog_categories_insert_depth',
    'trg_catalog_categories_update_parent'
  );
```

Expected migration history includes:

```text
1  create_telecom_schema
2  create_catalog_v2_schema
```

## 7. Manual rollback

Manual rollback deletes all Catalog V2 tables and their data. Restore from backup if the data must be preserved.
The command therefore requires both a backup path and an explicit destructive confirmation flag embedded in the npm script.

```bash
sudo bash -c '
  set -a
  source /etc/telecom-site/migrate.env
  set +a
  cd /srv/telecom-site
  /usr/local/bin/npm run db:migrate:mysql:rollback:v2
'
```

Rollback is blocked if a migration later than v2 has already been applied.
