# PostgreSQL deployment

PostgreSQL is an optional production adapter; the Exchange Core and SPI do not depend on it. PostgreSQL 15+ with built-in JSONB and row-level security is sufficient—no extensions are required.

## Migrations

Run `npm run postgres:migrate -- --connection-string "$DATABASE_URL"`. For a plan without connecting, use `--dry-run`. The tool orders common tenant, authority, runtime, hardening, Context, Endpoint, Connector and Phase 5 operability migrations by numeric ID and never prints the connection string. Migration `007_operability.sql` adds collaboration views, append-only audit, discrepancy and recovery persistence without adding a database dependency to Core/SPI.

For a smoke check, set `PG_TEST_URL` and run `npm run postgres:smoke`. It verifies migrations and, when enabled, that tenant RLS prevents a second tenant from reading the probe row.

Migrations are additive and recorded in `work_fabric_schema_migrations`. Back up before applying them; rollback is a forward migration, not a destructive down script. The runtime hardening migration removes duplicate legacy delivery-attempt rows deterministically before installing the stricter key.

Operational history and journal high-water visibility should be composed with
`PostgresRuntimeState`'s bounded keyset port and
`PostgresPartitionJournalPositionSource`. Migration `007_operability.sql` adds
the matching indexes. The Node service accepts both through technology-neutral
composition ports; it never discovers credentials or a database implicitly.

## Runtime settings

Use a bounded pool, statement timeout and connection timeout appropriate to the deployment. Keep the database role that owns migrations separate from the application role. Application transactions must enter through `TenantSession`, which sets `app.tenant_id` locally before any tenant table query. Do not grant application code a bypass-RLS role.

## Operations

Back up authority, outbox and runtime tables together. Monitor outbox age, lease expiry, delivery retry/dead-letter counts, projection lag and failed migrations. Retain event and audit history according to the tenant's compliance policy. Read replicas may serve explicitly designed projections, but authority and CAS writes remain on the primary.

Phase 5 stores preserve tenant predicates and RLS on every path. Collaboration projections are rebuildable from Journal/Handoff facts; audit is immutable until a bounded `pruneBefore` retention job; recovery requests use idempotent submit and fenced claims. Do not manually edit these tables to repair Handoff state. Use the authenticated recovery API and worker owners described in [Operations](operations.md).

The `service-node` PostgreSQL profile requires deployment-owned adapters to be injected explicitly. It does not construct a pool from ambient credentials or ship a production Identity/Authority policy. Pool, Identity, Authority, secret resolution, worker topology and TLS remain deployment responsibilities.

`PG_TEST_URL` integration tests are intentionally skipped when unset; fake-client tests still validate transaction ordering, tenant predicates, cloning, CAS and fencing.
