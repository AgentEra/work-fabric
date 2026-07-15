# PostgreSQL Production Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production PostgreSQL Adapter and the durable Outbox/Worker Lease contracts required to run the Phase 1 Exchange semantics in a tenant-isolated modular monolith.

**Architecture:** `exchange-spi` gains technology-neutral outbox and lease ports. A shared `adapter-postgres-common` package owns the `pg` pool, transaction/session boundary, migrations, RLS tenant context and safe SQL helpers. `adapter-storage-postgres` implements Exchange, projection, subscription and delivery persistence; `adapter-context-postgres` implements immutable scoped Context metadata. Core and Runtime remain unaware of PostgreSQL.

**Tech Stack:** Node.js >=22.20, TypeScript/ESM, `pg`, PostgreSQL 15+, SQL migrations, Vitest, existing WFPP validator and Conformance Profiles. No ORM, query builder or PostgreSQL import is allowed in `exchange-core` or `exchange-spi`.

## Global Constraints

- All tenant-owned rows require `tenant_id`; application queries and PostgreSQL RLS both enforce tenant isolation.
- A tenant session must set a transaction-local `app.tenant_id`; missing or mismatched tenant context fails closed.
- Authoritative command/event/outbox writes are one SQL transaction; external delivery is never inside that transaction.
- Stream version checks, idempotency, active delivery CAS, settlement and checkpoint CAS preserve the existing SPI semantics exactly.
- Event and Context bodies are cloned/immutable at the public boundary; SQL JSONB is never returned as a mutable shared reference.
- Timestamps accept the existing strict UTC 1–9 fractional-second format and compare without millisecond truncation.
- PostgreSQL Adapter package names, migrations and driver imports must not appear in Core/SPI source or package dependencies.
- Every task starts with a failing test, ends with focused tests, full typecheck/conformance, and one commit.
- Real PostgreSQL integration tests run when `PG_TEST_URL` is set; deterministic fake-client tests run in every environment.

---

### Task 1: Add Technology-Neutral Outbox and Worker Lease Contracts

**Files:**

- Create: `packages/exchange-spi/src/durability.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Create: `packages/exchange-conformance/src/durability-profile.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/durability-profile.test.ts`
- Create: `packages/exchange-spi/test/durability-contract.test.ts`

**Interfaces:**

```ts
import type { EventRecord } from "./events.js";

export interface OutboxRecord {
  readonly outbox_id: string;
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly position: number;
  readonly event: EventRecord;
  readonly attempt: number;
  readonly next_attempt_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly fencing_token: number;
}

export interface OutboxClaim {
  readonly owner: string;
  readonly now: string;
  readonly lease_seconds: number;
  readonly limit: number;
  readonly tenant_id: string;
  readonly partition_id: string;
}

export interface OutboxStore {
  claim(request: OutboxClaim): Promise<readonly OutboxRecord[]>;
  markPublished(
    outboxId: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean>;
  recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean>;
  listPending(tenantId: string, partitionId: string): Promise<readonly OutboxRecord[]>;
}

export interface WorkerLease {
  readonly lease_key: string;
  readonly owner: string;
  readonly fencing_token: number;
  readonly expires_at: string;
}

export interface WorkerLeaseStore {
  acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null>;
  renew(
    leaseKey: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  release(leaseKey: string, owner: string, fencingToken: number): Promise<boolean>;
}
```

- [ ] **Step 1: Write the failing contract tests**

Assert that the SPI exports the exact types, required capabilities are named,
and the Conformance Profile rejects an Adapter that ignores owner/fencing token,
returns an expired lease, claims another tenant, or marks an outbox row without
the matching lease.

- [ ] **Step 2: Run the focused tests and confirm the symbols are missing**

Run:

```bash
npx vitest run packages/exchange-spi/test/durability-contract.test.ts packages/exchange-conformance/test/durability-profile.test.ts
```

Expected: FAIL because `durability.ts` and its profile do not exist.

- [ ] **Step 3: Implement the ports and reusable profile**

Export the interfaces, required capability constants, strict input validation
and a profile that exercises lease acquisition/renewal/release, fencing,
expired-owner recovery, outbox claim ordering, retry schedule and publish
idempotency. Keep the profile independent of SQL or PostgreSQL.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run packages/exchange-spi/test/durability-contract.test.ts packages/exchange-conformance/test/durability-profile.test.ts
npm run typecheck
```

Expected: focused tests pass and TypeScript has no errors. Commit:

```bash
git add packages/exchange-spi packages/exchange-conformance
git commit -m "feat(spi): add outbox and worker lease contracts"
```

### Task 2: Build the Shared PostgreSQL Session, Migration and RLS Foundation

**Files:**

- Create: `packages/adapter-postgres-common/package.json`
- Create: `packages/adapter-postgres-common/src/postgres-client.ts`
- Create: `packages/adapter-postgres-common/src/tenant-session.ts`
- Create: `packages/adapter-postgres-common/src/migrations.ts`
- Create: `packages/adapter-postgres-common/src/index.ts`
- Create: `packages/adapter-postgres-common/migrations/001_tenant_context.sql`
- Create: `packages/adapter-postgres-common/test/tenant-session.test.ts`
- Create: `packages/adapter-postgres-common/test/migrations.test.ts`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export interface PostgresQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(error?: Error): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export interface TenantSession {
  readonly tenant_id: string;
  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T>;
}

export interface MigrationSource {
  readonly id: string;
  readonly sql: string;
}

export function createPgPool(connectionString: string): PostgresPool;
export function createTenantSession(
  pool: PostgresPool,
  tenantId: string,
): TenantSession;
export function runMigrations(
  client: PostgresClient,
  sources: readonly MigrationSource[],
): Promise<number>;
```

- [ ] **Step 1: Write failing SQL/session tests**

Use a scripted fake pool to assert `BEGIN`, `set_config('app.tenant_id', $1,
true)`, transaction callback, `COMMIT` on success, `ROLLBACK` on error, and
`release`. Assert invalid tenant IDs are rejected before a connection is
acquired. Assert migration statements create the tenant context helper and
RLS policy templates without interpolating tenant input.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run packages/adapter-postgres-common/test
```

Expected: FAIL because the package and session implementation do not exist.

- [ ] **Step 3: Implement the driver boundary and migrations**

Add `pg` as a dependency only to `adapter-postgres-common`; wrap the native
Pool/PoolClient in the small public interfaces. The transaction sequence is:

```sql
BEGIN;
SELECT set_config('app.tenant_id', $1, true);
-- callback statements
COMMIT;
```

On any callback/commit failure issue `ROLLBACK`, release the client and rethrow
the original error. Migrations are ordered, checksum-able strings and never
accept runtime values.

- [ ] **Step 4: Add optional PostgreSQL integration checks**

When `PG_TEST_URL` is present, create a temporary test schema, run migrations,
set two tenant sessions and assert an RLS-protected probe table cannot cross
read or write. When it is absent, mark only those integration cases skipped;
the fake-client contract tests remain mandatory.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run typecheck
npx vitest run packages/adapter-postgres-common/test
git diff --check
```

Commit:

```bash
git add packages/adapter-postgres-common package-lock.json
git commit -m "feat(postgres): add tenant session and migration foundation"
```

### Task 3: Implement PostgreSQL Exchange Streams, Idempotency and Outbox Atomicity

**Files:**

- Create: `packages/adapter-storage-postgres/package.json`
- Create: `packages/adapter-storage-postgres/src/postgres-exchange-persistence.ts`
- Create: `packages/adapter-storage-postgres/src/index.ts`
- Create: `packages/adapter-storage-postgres/migrations/002_exchange_authority.sql`
- Create: `packages/adapter-storage-postgres/test/postgres-exchange-persistence.test.ts`
- Create: `packages/adapter-storage-postgres/test/postgres-exchange-integration.test.ts`
- Modify: `packages/adapter-postgres-common/src/index.ts`

**Interfaces:**

```ts
export class PostgresExchangePersistence
  implements ExchangePersistence, SnapshotRepository {
  constructor(sessionFactory: (tenantId: string) => TenantSession);
  readonly manifest: CapabilityManifest;
  commitAtomically(request: AtomicCommitRequest): Promise<AtomicCommitResult>;
  readStream(streamId: string, fromVersion?: number): Promise<readonly EventRecord[]>;
  readPartition(partitionId: string, afterPosition?: number, limit?: number): Promise<readonly EventRecord[]>;
  findCommand(tenantId: string, idempotencyKey: string): Promise<CommandRecord | null>;
  loadSnapshot(streamId: string): Promise<SnapshotRecord | null>;
  saveSnapshot(snapshot: SnapshotRecord): Promise<void>;
  deleteSnapshot(streamId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing stream/outbox tests**

Cover one commit, same-key replay, same-key changed digest, expected-version
conflict, ordered stream/partition positions, immutable returned events,
event-ID uniqueness, snapshot round trip, and the atomic invariant that every
committed event has an outbox row in the same transaction. Add a fake SQL client
that records the query order and a mutation test that fails if the outbox insert
is performed after `COMMIT`.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run packages/adapter-storage-postgres/test/postgres-exchange-persistence.test.ts
```

Expected: FAIL because the PostgreSQL Adapter and migration do not exist.

- [ ] **Step 3: Add authoritative migrations**

Create tenant-scoped tables for streams, events, command records, snapshots and
outbox rows. Export the migration as `MigrationSource` data so the common
migration runner can order it with runtime and Context migrations. Use unique
constraints for `(tenant_id, idempotency_key)`,
`(tenant_id, event_id)`, `(tenant_id, stream_id, stream_version)` and
`(tenant_id, partition_id, partition_position)`. Store immutable protocol/domain
JSON in JSONB and expose only mapped `EventRecord` values.

- [ ] **Step 4: Implement the transaction**

Inside one `TenantSession.withTransaction`, lock/check the command record,
validate every stream/version precondition, allocate ordered positions, insert
events, insert one outbox row per event, then insert the command outcome. On a
conflict return the existing SPI result without writing anything. Never return
raw SQL rows or mutable JSONB references.

- [ ] **Step 5: Add optional live PostgreSQL integration**

With `PG_TEST_URL`, run the real migration and exercise concurrent same-key and
same-stream commits from two sessions. Assert one commit, one replay/conflict,
no orphan outbox row and no cross-tenant read. Without it, fake-client tests
still validate SQL ordering and row mapping.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm run typecheck
npx vitest run packages/adapter-storage-postgres/test
npm run conformance
```

Commit:

```bash
git add packages/adapter-storage-postgres packages/adapter-postgres-common
git commit -m "feat(postgres): persist exchange streams and outbox atomically"
```

### Task 4: Add PostgreSQL Projection, Subscription, Delivery and Lease State

**Files:**

- Modify: `packages/adapter-storage-postgres/src/postgres-exchange-persistence.ts`
- Create: `packages/adapter-storage-postgres/src/postgres-runtime-state.ts`
- Create: `packages/adapter-storage-postgres/migrations/003_runtime_state.sql`
- Create: `packages/adapter-storage-postgres/test/postgres-runtime-state.test.ts`
- Create: `packages/adapter-storage-postgres/test/postgres-runtime-integration.test.ts`
- Create: `packages/exchange-conformance/test/postgres-adapter-profile.test.ts`

**Interfaces:**

```ts
export class PostgresRuntimeState
  implements ProjectionCheckpointStore, ProjectionFailureStore,
    DeliveryStateStore, SubscriptionStore, OutboxStore, WorkerLeaseStore {}
```

- [ ] **Step 1: Write failing state/concurrency tests**

Use the existing Persistence, Subscription and Projection Profiles plus the new
Durability Profile. Add explicit SQL-level tests for checkpoint CAS, one active
Pull Delivery per subscription/partition, atomic rejected settlement, attempt
and dead-letter compound uniqueness, outbox fencing and lease takeover after
expiry. Mutation adapters must fail when active pointers, fencing tokens or
tenant predicates are removed.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run packages/adapter-storage-postgres/test packages/exchange-conformance/test/postgres-adapter-profile.test.ts
```

Expected: FAIL because runtime tables and state adapter do not exist.

- [ ] **Step 3: Add runtime migrations**

Create tenant-scoped checkpoint, failure, subscription, delivery position,
pending delivery, attempt, dead-letter, outbox lease and worker lease tables.
Use unique/partial indexes for active delivery and compound first-write keys.
Use `SELECT ... FOR UPDATE` or an atomic `UPDATE ... WHERE fencing_token = ?`
for every CAS boundary.

- [ ] **Step 4: Implement state mapping and clone boundaries**

Map SQL rows to exact SPI records, validate every scalar before returning,
deep-clone JSONB values, sort deterministic list results, and preserve old
delivery records after replacement. A stale owner or position returns `false`
or the typed conflict result; it never deletes a newer active record.

- [ ] **Step 5: Verify live concurrency and profiles**

With `PG_TEST_URL`, run two clients against the same tenant/partition and prove
one CAS wins, leases fence the old owner, settlement is atomic and a second
tenant cannot see the first tenant's rows. Run all reusable profiles in every
environment.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm run typecheck
npx vitest run packages/adapter-storage-postgres/test packages/exchange-conformance/test
npm run conformance
```

Commit:

```bash
git add packages/adapter-storage-postgres packages/exchange-conformance
git commit -m "feat(postgres): persist runtime state and fenced leases"
```

### Task 5: Implement the PostgreSQL Context Adapter

**Files:**

- Create: `packages/adapter-context-postgres/package.json`
- Create: `packages/adapter-context-postgres/src/postgres-context-repository.ts`
- Create: `packages/adapter-context-postgres/src/index.ts`
- Create: `packages/adapter-context-postgres/migrations/004_context.sql`
- Create: `packages/adapter-context-postgres/test/postgres-context-repository.test.ts`
- Create: `packages/adapter-context-postgres/test/postgres-context-integration.test.ts`

**Interfaces:**

```ts
export class PostgresContextRepository implements ContextRepository {
  constructor(sessionFactory: (tenantId: string) => TenantSession);
  readonly manifest: CapabilityManifest;
  putBundle(tenantId: string, bundle: JsonObject): Promise<ContextReference>;
  checkAvailability(request: ContextAccessRequest): Promise<ContextAvailability>;
}
```

- [ ] **Step 1: Write failing Context profile and immutability tests**

Run the existing Context Profile against the new Adapter and add tests for
same-version idempotency, changed-body rejection, digest mismatch, actor and
endpoint visibility, tenant isolation, JSON clone-on-write/read and expiry
metadata preservation.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run packages/adapter-context-postgres/test
```

Expected: FAIL because the package and Context migration do not exist.

- [ ] **Step 3: Add immutable Context tables and implement queries**

Export the migration as `MigrationSource` data. Create tenant-scoped
bundle/version/item metadata with a unique
`(tenant_id, context_id, version)` key. Store visibility arrays and digest
canonically. `putBundle` inserts once and returns the existing reference only
when the complete body is equal; `checkAvailability` checks tenant, digest,
actor, endpoint and expiry before returning `available`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run typecheck
npx vitest run packages/adapter-context-postgres/test packages/exchange-conformance/test/adapter-profiles.test.ts
```

Commit:

```bash
git add packages/adapter-context-postgres
git commit -m "feat(postgres): persist scoped context bundles"
```

### Task 6: Add PostgreSQL Conformance Runner, Migration Tooling and Documentation

**Files:**

- Create: `tools/postgres-migrate.ts`
- Create: `tools/postgres-smoke.ts`
- Modify: `package.json`
- Modify: `packages/exchange-conformance/package.json`
- Create: `packages/adapter-storage-postgres/README.md`
- Create: `packages/adapter-postgres-common/README.md`
- Create: `docs/postgresql-deployment.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `protocol/README.md`
- Create: `packages/adapter-storage-postgres/test/postgres-conformance.test.ts`

**Interfaces:**

```ts
export interface PostgresSmokeOptions {
  readonly connection_string: string;
  readonly tenant_id: string;
  readonly verify_rls: boolean;
}

export async function runPostgresSmoke(
  options: PostgresSmokeOptions,
): Promise<{ readonly migrations: number; readonly profiles: string[] }>;
```

- [ ] **Step 1: Write failing migration/smoke command tests**

Assert the CLI refuses an empty connection string, never logs credentials,
orders migrations by numeric prefix, supports `--dry-run`, and reports profile
names only after successful checks.

- [ ] **Step 2: Implement safe tooling**

Use `PG_TEST_URL` or an explicit CLI argument, collect the common, storage and
Context `MigrationSource` exports, sort by numeric migration ID, run migrations
in one transaction per migration, set tenant context before profile queries,
and close pools in a `finally` block. Never print the connection string or
secret values.

- [ ] **Step 3: Add deployment and architecture docs**

Document PostgreSQL 15+, required extensions (none beyond built-ins), pool and
timeout defaults, RLS setup, migration/rollback policy, backups, retention,
readiness, `PG_TEST_URL` integration testing and how future Kafka/NATS Adapters
reuse the same SPI. Explicitly state that PostgreSQL is an Adapter, not a Core
dependency.

- [ ] **Step 4: Run the complete verification gate**

Run:

```bash
npm run typecheck
npm test
npm run conformance
npm run verify:postgres
git diff --check
```

Expected: all existing and PostgreSQL profiles pass; live-only tests are
skipped with a clear message when `PG_TEST_URL` is absent.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json package-lock.json tools packages README.md docs protocol
git commit -m "feat: add PostgreSQL production persistence foundation"
```

## Completion Gate

Do not declare this sub-project complete until:

- every Phase 1 Conformance Profile passes for PostgreSQL and Context;
- fake-client SQL tests prove tenant session, transaction order, RLS setup,
  outbox atomicity, CAS/fencing and clone boundaries;
- `PG_TEST_URL` live tests prove cross-tenant denial and concurrent CAS when
  PostgreSQL is available;
- `npm run verify`, `npm run verify:exchange` and `npm run verify:postgres`
  pass, with no Core/SPI concrete database dependency;
- migration and smoke tooling never prints credentials;
- independent review finds no Critical or Important issues;
- the worktree is clean after the final commit.
