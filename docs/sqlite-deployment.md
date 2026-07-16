# SQLite local deployment

The `sqlite-local` profile is a restart-safe, single-process Work Fabric
deployment for local Agent development, evaluation and small controlled
installations. It implements the same technology-neutral Exchange, Context,
Endpoint, Connector and operations ports as other adapters. Core and public
contracts do not depend on SQLite.

SQLite is not the clustered production profile. It does not provide PostgreSQL
RLS, multi-process worker claims, read replicas or horizontal writer scaling.
Do not point multiple Work Fabric processes at one file.

## Requirements and migration

Use the repository-supported Node.js version (22.20 or newer) with built-in
`node:sqlite`. Preview and apply ordered, checksummed migrations:

```sh
npm run sqlite:migrate -- --location ./var/work-fabric.db --dry-run
npm run sqlite:migrate -- --location ./var/work-fabric.db
```

The adapter enables foreign keys, a bounded busy timeout and WAL for file-backed
databases. A changed migration checksum fails startup; add a forward migration
instead of rewriting applied history.

Operational histories use indexed keyset pagination and journal high-water
uses `MAX(partition_position)` on the tenant/partition index. These choices
keep Console and SDK visibility reads bounded as the local journal grows; they
do not change SQLite's single-process deployment boundary.

## Start the service

Copy `examples/customer-project-lifecycle/config.example.json` outside source
control, replace all identity and Authority placeholders, and run:

```sh
export WORK_FABRIC_CONFIG=/absolute/path/work-fabric.local.json
npm run service:start
```

`memory-demo` additionally requires `development_mode: true` and loses all
state on restart. `sqlite-local` requires an explicit file and never silently
mixes durable Core state with Memory side stores.

The bundled local Identity/Authority adapters are exact and default-deny. They
are suitable for explicit local facts, not dynamic production authorization.
Tokens belong in a deployment-owned secret/session integration, not committed
configuration or Console assets.

## Backup and recovery

- Stop the single process before taking a simple file copy, or use a SQLite
  online-backup mechanism that includes WAL state.
- Back up the database and migration history together.
- Restore into an offline path, run migration verification, then start exactly
  one process.
- Use public projection rebuild and recovery actions for derived state; never
  repair Handoff facts with direct SQL.
- Run bounded audit, completed ingress and dead-letter retention jobs according
  to tenant policy.

Crash/reopen tests cover Exchange, Context, Endpoint, Connector, collaboration,
audit, discrepancy and recovery state. Those tests prove local restart
behavior, not network-filesystem durability or multi-host failover.
