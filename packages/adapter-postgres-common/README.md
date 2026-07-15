# PostgreSQL Common Adapter

Technology-neutral PostgreSQL boundaries used by Work Fabric adapters.

- `createPgPool` wraps the native pool without leaking `pg` types into SPI.
- `createTenantSession` enforces `BEGIN → set_config(app.tenant_id) → callback → COMMIT` and rolls back on failure.
- `runMigrations` validates and orders migration sources by numeric prefix.

The package owns the database client and tenant transaction boundary. Exchange, runtime and Context semantics remain in their own adapters.
