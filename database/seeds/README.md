# Seed data

`npm run db:seed` imports only the checked-in schema snapshots:

- `website_db` receives the telecom navigation catalog: 8 modules, 39 tables, 421 columns,
  64 relations, and 64 foreign-key selector definitions.
- `telecom_boss` receives 24 reference/demo rows, including four roles, nine permissions,
  three service plans, four price periods, one equipment model, one promotion, and two
  promotion-plan links.

Seeding is idempotent by primary key and runs inside one transaction per database. DECIMAL
values are converted to fixed-scale integers before they reach SQLite; for example, `288.00`
is stored as `28800` and converted back at the API boundary.

When `telecom_boss.sqlite` contains migration version 2, the same telecom transaction also
performs the idempotent Catalog V2 backfill:

- every service plan is linked to one `catalog_products` row;
- only active stock items with a positive selling price are linked as sellable products;
- stable service/product category roots, localized starter content, primary category mappings,
  and generalized promotion links are inserted only when absent;
- operational prices, stock balances, movements, orders, subscriptions, inquiries, IDs, and
  historical snapshots are never copied or updated by the backfill.

Re-running the seed preserves any later Catalog V2 edits because backfill conflicts use
`DO NOTHING`; it only fills missing deterministic source mappings.
