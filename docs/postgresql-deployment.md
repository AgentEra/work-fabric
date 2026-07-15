# PostgreSQL deployment

PostgreSQL is an optional production adapter; the Exchange Core and SPI do not depend on it. PostgreSQL 15+ with built-in JSONB and row-level security is sufficient—no extensions are required.

## Migrations

Run `npm run postgres:migrate -- --connection-string "$DATABASE_URL"`. For a plan without connecting, use `--dry-run`. The tool orders common tenant, authority, runtime, hardening and Context migrations by numeric ID and never prints the connection string.

For a smoke check, set `PG_TEST_URL` and run `npm run postgres:smoke`. It verifies migrations and, when enabled, that tenant RLS prevents a second tenant from reading the probe row.

Migrations are additive and recorded in `work_fabric_schema_migrations`. Back up before applying them; rollback is a forward migration, not a destructive down script. The runtime hardening migration removes duplicate legacy delivery-attempt rows deterministically before installing the stricter key.

## Runtime settings

Use a bounded pool, statement timeout and connection timeout appropriate to the deployment. Keep the database role that owns migrations separate from the application role. Application transactions must enter through `TenantSession`, which sets `app.tenant_id` locally before any tenant table query. Do not grant application code a bypass-RLS role.

## Operations

Back up authority, outbox and runtime tables together. Monitor outbox age, lease expiry, delivery retry/dead-letter counts, projection lag and failed migrations. Retain event and audit history according to the tenant's compliance policy. Read replicas may serve explicitly designed projections, but authority and CAS writes remain on the primary.

`PG_TEST_URL` integration tests are intentionally skipped when unset; fake-client tests still validate transaction ordering, tenant predicates, cloning, CAS and fencing.
