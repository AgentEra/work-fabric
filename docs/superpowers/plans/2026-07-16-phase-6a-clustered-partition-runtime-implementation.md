# Phase 6A Clustered Partition Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Work Fabric-owned projection, Signal and Outbox maintenance turns safely across multiple bounded worker hosts without introducing a scheduler brain or a second source of truth.

**Architecture:** Add technology-neutral cluster contracts, a deterministic tenant-fair runtime, existing-owner handler adapters, and a PostgreSQL readiness catalog. The Journal, checkpoints, Delivery positions and Outbox remain authoritative; wakeups are duplicate/loss tolerant hints and SQLite remains single-process.

**Tech Stack:** Node.js 22.20+, TypeScript 7, Vitest 4, PostgreSQL 15+, existing Work Fabric SPI/runtime packages.

## Global Constraints

- Work Fabric coordinates connection and handoff only; participant execution, Agent reasoning, target ranking and business scheduling remain external.
- No Core, protocol or public SDK package imports PostgreSQL, NATS, an HTTP framework or a process host.
- Every queue, page, batch, concurrency set, retry, timer and shutdown wait is explicitly bounded.
- PostgreSQL catalog access is tenant-scoped, keyset ordered and protected by existing RLS sessions.
- Wakeups contain metadata only and are never authoritative; catalog polling must recover lost wakeups.
- Metrics use only fixed operation, outcome and category labels; Tenant, Partition, worker and fencing identities are not metric or trace attributes.
- SQLite supports one local owner only and rejects clustered composition.
- All implementation follows TDD: observe the focused test fail, implement the minimum behavior, then run focused and full verification.

---

## File structure

```text
packages/cluster-spi/
  src/contracts.ts          stable work, catalog, wakeup and turn contracts
  src/validation.ts         closed vocabulary and bound validation
  src/index.ts              public exports
  test/contracts.test.ts    contract shape and negative bounds

packages/exchange-conformance/
  src/cluster-profile.ts    reusable catalog/wakeup profile
  test/cluster-profile.test.ts

packages/cluster-runtime/
  src/ready-queue.ts        tenant round-robin and coalescing
  src/lease-guard.ts        acquire/renew/release ownership guard
  src/partition-worker.ts   one bounded turn
  src/cluster-host.ts       polling, hints, concurrency and drain
  src/handlers.ts           adapters to existing Work Fabric owners
  src/index.ts
  test/*.test.ts

packages/adapter-cluster-memory/
  src/index.ts              conformance fixture catalog and wakeup bus
  test/memory-cluster.test.ts

packages/adapter-storage-postgres/
  migrations/008_cluster_runtime.sql
  src/postgres-partition-work-catalog.ts
  test/postgres-cluster-runtime.test.ts

packages/service-node/
  src/config.ts             bounded cluster configuration
  src/compose.ts            optional worker host composition/lifecycle
  test/cluster-composition.integration.test.ts

tools/
  benchmark-cluster-runtime.ts
  check-cluster-boundaries.ts
```

---

### Task 1: Cluster contracts and conformance profile

**Files:**
- Create: `packages/cluster-spi/package.json`
- Create: `packages/cluster-spi/src/contracts.ts`
- Create: `packages/cluster-spi/src/validation.ts`
- Create: `packages/cluster-spi/src/index.ts`
- Create: `packages/cluster-spi/test/contracts.test.ts`
- Create: `packages/exchange-conformance/src/cluster-profile.ts`
- Create: `packages/exchange-conformance/test/cluster-profile.test.ts`
- Modify: `packages/exchange-conformance/package.json`
- Modify: `packages/exchange-conformance/src/index.ts`

**Interfaces:**
- Consumes: `ExchangeAdapter`, `WorkerLeaseStore`, canonical UTC timestamp helpers.
- Produces: `PartitionWorkKind`, `PartitionWorkItem`, `PartitionWorkCatalog`, `PartitionWakeupPublisher`, `PartitionWakeupConsumer`, `WakeupDelivery`, `PartitionTurnContext`, `PartitionTurnHandler`, `validateClusterLimits()`, `verifyClusterProfile()`.

- [x] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  CLUSTER_REQUIRED_CAPABILITIES,
  PARTITION_WORK_KINDS,
  validateClusterLimits,
} from "../src/index.js";

describe("cluster contracts", () => {
  it("keeps work kinds mechanical and closed", () => {
    expect(PARTITION_WORK_KINDS).toEqual([
      "outbox_wakeup", "handoff_projection",
      "collaboration_projection", "signal_delivery",
    ]);
    expect(JSON.stringify(PARTITION_WORK_KINDS)).not.toMatch(
      /agent|workflow|priority|execute|rank/i,
    );
    expect(CLUSTER_REQUIRED_CAPABILITIES).toContain("tenant_scoped_keyset_scan");
  });

  it("rejects unbounded host limits", () => {
    expect(() => validateClusterLimits({
      max_concurrent_turns: 0, max_ready_items: 100,
      catalog_page_size: 25, turn_item_limit: 100,
      lease_seconds: 30, drain_timeout_seconds: 30,
      poll_interval_ms: 1000, max_tenants_per_host: 10,
    })).toThrow(/max_concurrent_turns/);
  });
});
```

- [x] **Step 2: Run the tests and confirm missing package failure**

Run: `npm test -- packages/cluster-spi/test/contracts.test.ts`

Expected: FAIL because `packages/cluster-spi/src/index.ts` does not exist.

- [x] **Step 3: Implement the closed contracts and validation**

```ts
export const PARTITION_WORK_KINDS = [
  "outbox_wakeup", "handoff_projection",
  "collaboration_projection", "signal_delivery",
] as const;
export type PartitionWorkKind = typeof PARTITION_WORK_KINDS[number];

export interface PartitionWorkItem {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly kind: PartitionWorkKind;
  readonly observed_position: number;
  readonly available_at: string;
}

export interface PartitionWorkCatalog extends ExchangeAdapter {
  scanReady(input: {
    readonly tenant_id: string;
    readonly kinds: readonly PartitionWorkKind[];
    readonly available_at_or_before: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly PartitionWorkItem[];
    readonly next_cursor: string | null;
  }>;
}

export interface PartitionWakeupPublisher extends ExchangeAdapter {
  publish(wakeup: PartitionWakeup): Promise<"accepted" | "retryable_failure">;
}

export interface PartitionWakeupConsumer extends ExchangeAdapter {
  next(signal: AbortSignal): Promise<WakeupDelivery | null>;
}
```

Implement strict IDs (1–128), positive safe positions, canonical timestamps,
unique non-empty work-kind filters, page limits 1–1,000 and the exact global
limits from the design.

- [x] **Step 4: Add reusable catalog/wakeup conformance**

The profile must assert tenant isolation, stable keyset order, `limit`, deep
cloning, duplicate wakeup tolerance, explicit Ack/Retry settlement and
capability advertisement. Export:

```ts
export async function verifyClusterProfile(
  factory: () => PartitionWorkCatalog &
    PartitionWakeupPublisher & PartitionWakeupConsumer,
  fixtures = DEFAULT_CLUSTER_PROFILE_FIXTURES,
): Promise<void>;
```

- [x] **Step 5: Run focused verification**

Run: `npm run typecheck && npm test -- packages/cluster-spi/test packages/exchange-conformance/test/cluster-profile.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```sh
git add packages/cluster-spi packages/exchange-conformance
git commit -m "feat(cluster): define partition runtime contracts"
```

---

### Task 2: Memory cluster Adapter and tenant-fair ready queue

**Files:**
- Create: `packages/adapter-cluster-memory/package.json`
- Create: `packages/adapter-cluster-memory/src/index.ts`
- Create: `packages/adapter-cluster-memory/test/memory-cluster.test.ts`
- Create: `packages/cluster-runtime/package.json`
- Create: `packages/cluster-runtime/src/ready-queue.ts`
- Create: `packages/cluster-runtime/src/index.ts`
- Create: `packages/cluster-runtime/test/ready-queue.test.ts`

**Interfaces:**
- Consumes: Task 1 cluster contracts and conformance.
- Produces: `MemoryClusterAdapter` and `TenantFairReadyQueue` with `offer()`, `take()`, `size`, `dropped`, `clear()`.

- [x] **Step 1: Write failing fairness and coalescing tests**

```ts
it("coalesces identities and serves tenants round-robin", () => {
  const queue = new TenantFairReadyQueue(4);
  queue.offer(item("tenant-a", "p1", 1));
  queue.offer(item("tenant-a", "p1", 9));
  queue.offer(item("tenant-a", "p2", 2));
  queue.offer(item("tenant-b", "p3", 3));
  expect(queue.size).toBe(3);
  expect([
    queue.take()?.tenant_id,
    queue.take()?.tenant_id,
    queue.take()?.tenant_id,
  ]).toEqual(["tenant-a", "tenant-b", "tenant-a"]);
});

it("drops new identities at capacity without dropping newer coalesced state", () => {
  const queue = new TenantFairReadyQueue(1);
  expect(queue.offer(item("tenant-a", "p1", 1))).toBe("queued");
  expect(queue.offer(item("tenant-a", "p1", 2))).toBe("coalesced");
  expect(queue.offer(item("tenant-b", "p2", 1))).toBe("dropped");
  expect(queue.take()?.observed_position).toBe(2);
  expect(queue.dropped).toBe(1);
});
```

- [x] **Step 2: Run and confirm missing queue failure**

Run: `npm test -- packages/cluster-runtime/test/ready-queue.test.ts`

Expected: FAIL because `TenantFairReadyQueue` is missing.

- [x] **Step 3: Implement queue with bounded maps**

Use one `Map<tenant_id, Map<identity, item>>`, a rotating tenant array and an
identity key of `tenant_id\u0000partition_id\u0000kind`. Replacing an existing
identity keeps the greater `observed_position` and later `available_at` while
not growing queue size.

- [x] **Step 4: Implement Memory Adapter and run conformance**

The Adapter stores cloned work items ordered by `available_at`,
`partition_id`, work-kind order. Its wakeup queue requires exactly one of
`acknowledge()` or `retry()` and re-enqueues only on Retry.

Run: `npm run typecheck && npm test -- packages/adapter-cluster-memory/test packages/cluster-runtime/test/ready-queue.test.ts`

Expected: PASS including `verifyClusterProfile()`.

- [x] **Step 5: Commit**

```sh
git add packages/adapter-cluster-memory packages/cluster-runtime
git commit -m "feat(cluster): add fair bounded ready queue"
```

---

### Task 3: Lease guard and one-turn partition worker

**Files:**
- Create: `packages/cluster-runtime/src/errors.ts`
- Create: `packages/cluster-runtime/src/lease-guard.ts`
- Create: `packages/cluster-runtime/src/partition-worker.ts`
- Create: `packages/cluster-runtime/test/lease-guard.test.ts`
- Create: `packages/cluster-runtime/test/partition-worker.test.ts`
- Modify: `packages/cluster-runtime/src/index.ts`

**Interfaces:**
- Consumes: `WorkerLeaseStore`, `Clock`, `PartitionTurnHandler`.
- Produces: `PartitionLeaseGuard` and `PartitionWorker.run(item, signal)`.

- [x] **Step 1: Write failing race and stale-fence tests**

```ts
it("allows one winner and fences an expired owner", async () => {
  const store = new FakeLeaseStore();
  const first = new PartitionWorker(deps("worker-a", store));
  const second = new PartitionWorker(deps("worker-b", store));
  await expect(Promise.all([
    first.run(work, new AbortController().signal),
    second.run(work, new AbortController().signal),
  ])).resolves.toSatisfy((results) =>
    results.filter((result) => result.kind === "ran").length === 1,
  );
  store.expireCurrent();
  await expect(first.run(work, new AbortController().signal))
    .resolves.toMatchObject({ kind: "lease_unavailable" });
});
```

- [x] **Step 2: Run and confirm missing worker failure**

Run: `npm test -- packages/cluster-runtime/test/lease-guard.test.ts packages/cluster-runtime/test/partition-worker.test.ts`

Expected: FAIL because the worker classes are missing.

- [x] **Step 3: Implement lease guard**

`PartitionLeaseGuard.acquire()` uses
`partition:${kind}:${partition_id}`, stores owner/token, and exposes:

```ts
assertOwnership(): Promise<void> // renew same owner/token or throw ClusterError
release(): Promise<boolean>
startHeartbeat(signal: AbortSignal): { stop(): Promise<void> }
```

Heartbeat interval is `floor(lease_seconds * 1000 / 3)`. The injected timer
port is deterministic in tests. A failed renewal aborts the turn controller
and records `partition_lease_lost`; it never releases with another token.

- [x] **Step 4: Implement exactly one bounded handler turn**

`PartitionWorker.run()` validates the item, acquires the lease, starts the
heartbeat, asserts ownership, invokes the matching handler once with
`turn_item_limit`, stops heartbeat, then releases. It returns one of:

```ts
{ kind: "lease_unavailable" }
{ kind: "ran"; outcome: PartitionTurnOutcome; fencing_token: number }
{ kind: "failed"; code: "partition_lease_lost" | "partition_turn_failed" }
```

Never return raw exception text.

- [x] **Step 5: Run focused verification and commit**

Run: `npm run typecheck && npm test -- packages/cluster-runtime/test`

Expected: PASS.

```sh
git add packages/cluster-runtime
git commit -m "feat(cluster): fence bounded partition turns"
```

---

### Task 4: Bounded cluster host, polling and graceful drain

**Files:**
- Create: `packages/cluster-runtime/src/cluster-host.ts`
- Create: `packages/cluster-runtime/src/telemetry.ts`
- Create: `packages/cluster-runtime/test/cluster-host.test.ts`
- Modify: `packages/cluster-runtime/src/index.ts`
- Modify: `packages/operations-spi/src/telemetry.ts`
- Modify: `packages/operations-observability/test/semantic-observer.test.ts`

**Interfaces:**
- Consumes: Catalog, optional wakeup consumer, ready queue, partition worker and semantic observer.
- Produces: `ClusterHost.start()`, `pollOnce()`, `ingestOnce()`, `drain()`, `snapshot()`.

- [x] **Step 1: Write failing host tests**

```ts
it("bounds concurrency and drains without starting queued work", async () => {
  const turns = deferredTurnWorker();
  const host = new ClusterHost(hostDependencies(turns), {
    ...validLimits, max_concurrent_turns: 2, max_ready_items: 4,
  });
  await host.pollOnce();
  await host.pump();
  expect(turns.started).toBe(2);
  const draining = host.drain();
  turns.completeAll();
  await expect(draining).resolves.toMatchObject({ state: "stopped" });
  expect(turns.started).toBe(2);
});

it("recovers a dropped wakeup through catalog polling", async () => {
  const host = new ClusterHost(hostDependenciesWithLostWakeup(), validLimits);
  await host.pollOnce();
  await host.pump();
  expect(host.snapshot().completed_turns).toBe(1);
});
```

- [x] **Step 2: Run and confirm missing host failure**

Run: `npm test -- packages/cluster-runtime/test/cluster-host.test.ts`

Expected: FAIL because `ClusterHost` is missing.

- [x] **Step 3: Implement host state machine**

States are `idle | running | draining | stopped`. `pollOnce()` performs at
most one in-flight scan per configured tenant and feeds the fair queue.
`ingestOnce()` settles one wakeup after enqueue/drop. `pump()` never exceeds
`max_concurrent_turns`. `drain()` stops intake, aborts queued work, waits for
active promises up to `drain_timeout_seconds`, then leaves leases to expire.

- [x] **Step 4: Add low-cardinality telemetry vocabulary**

Extend the semantic operation union only with the six names in the design.
Tests must prove emitted metric attributes remain exactly `operation`,
`outcome`, `category`; queue sizes and counts are measurements, not labels.

- [x] **Step 5: Run focused verification and commit**

Run: `npm run typecheck && npm test -- packages/cluster-runtime/test packages/operations-observability/test/semantic-observer.test.ts`

Expected: PASS.

```sh
git add packages/cluster-runtime packages/operations-spi packages/operations-observability
git commit -m "feat(cluster): coordinate bounded worker hosts"
```

---

### Task 5: Existing-owner handler adapters and fencing hooks

**Files:**
- Create: `packages/cluster-runtime/src/handlers.ts`
- Create: `packages/cluster-runtime/test/handlers.test.ts`
- Modify: `packages/exchange-runtime/src/subscription/signal-dispatcher.ts`
- Modify: `packages/exchange-runtime/src/projection/handoff-projector.ts`
- Modify: `packages/operations-runtime/src/collaboration-projector.ts`
- Modify: corresponding runtime tests

**Interfaces:**
- Consumes: existing projectors, `SignalDispatcher`, Outbox Store and wakeup publisher.
- Produces: `OutboxWakeupHandler`, `HandoffProjectionHandler`, `CollaborationProjectionHandler`, `SignalDeliveryHandler`.

- [ ] **Step 1: Write failing stale-owner tests**

```ts
it("checks ownership before Signal side effect and cursor advance", async () => {
  const fence = sequenceFence([true, false]);
  await dispatcher.dispatchPartition("partition-1", "tenant-1", 10, fence);
  expect(signal.deliveries).toHaveLength(1);
  expect(deliveryState.position).toBe(0);
});

it("publishes metadata wakeups without protocol payload", async () => {
  await handler.run(context, 10);
  expect(publisher.values.map((value) => value.kind)).toEqual([
    "handoff_projection", "collaboration_projection", "signal_delivery",
  ]);
  expect(JSON.stringify(publisher.values)).not.toMatch(/domain_data|protocol_data|context|result/);
});
```

- [ ] **Step 2: Run and confirm signature/handler failures**

Run: `npm test -- packages/cluster-runtime/test/handlers.test.ts packages/exchange-runtime/test/signal-dispatcher.test.ts`

Expected: FAIL because handlers and fence hooks are missing.

- [ ] **Step 3: Add optional owner fence hooks**

Define the local structural type:

```ts
export interface RuntimeOwnershipFence {
  assertOwnership(): Promise<void>;
}
```

Projectors call it before each read-model write and checkpoint CAS.
`SignalDispatcher` calls it immediately before `SignalAdapter.deliver` and
before Delivery position advance/dead-letter settlement. Existing callers may
omit the fence and preserve Phase 1–5 behavior.

- [ ] **Step 4: Implement handlers**

Each handler validates `context.item.kind`, asserts ownership, calls one owner
turn and maps its result to the closed `PartitionTurnOutcome`. The Outbox
handler uses row owner/fencing CAS and emits exactly three metadata wakeups per
claimed row, then marks the row published only after all three are accepted.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test -- packages/cluster-runtime/test/handlers.test.ts packages/exchange-runtime/test packages/operations-runtime/test/collaboration-projector.test.ts`

Expected: PASS.

```sh
git add packages/cluster-runtime packages/exchange-runtime packages/operations-runtime
git commit -m "feat(cluster): adapt partition owner turns"
```

---

### Task 6: PostgreSQL keyset work catalog

**Files:**
- Create: `packages/adapter-storage-postgres/migrations/008_cluster_runtime.sql`
- Create: `packages/adapter-storage-postgres/src/postgres-partition-work-catalog.ts`
- Create: `packages/adapter-storage-postgres/test/postgres-cluster-runtime.test.ts`
- Modify: `packages/adapter-storage-postgres/src/index.ts`
- Modify: `tools/postgres-migrate.ts`
- Modify: `tools/postgres-smoke.ts`

**Interfaces:**
- Consumes: Task 1 `PartitionWorkCatalog`, existing tenant session factory and runtime tables.
- Produces: `PostgresPartitionWorkCatalog` with signed, filter-bound keyset cursors.

- [ ] **Step 1: Write failing fake-client SQL tests**

```ts
it("pushes tenant, due time, keyset and limit into indexed SQL", async () => {
  const catalog = new PostgresPartitionWorkCatalog(factory, "cursor-secret-at-least-32-characters");
  await catalog.scanReady({
    tenant_id: "tenant-1",
    kinds: ["outbox_wakeup", "handoff_projection"],
    available_at_or_before: "2026-07-16T00:00:00.000Z",
    limit: 25,
  });
  expect(client.calls.every((call) => call.values?.includes("tenant-1"))).toBe(true);
  expect(client.calls.some((call) => call.sql.includes("LIMIT"))).toBe(true);
  expect(JSON.stringify(client.calls)).not.toContain("cursor-secret");
});
```

- [ ] **Step 2: Run and confirm missing catalog failure**

Run: `npm test -- packages/adapter-storage-postgres/test/postgres-cluster-runtime.test.ts`

Expected: FAIL because `PostgresPartitionWorkCatalog` is missing.

- [ ] **Step 3: Add migration and catalog**

Migration `008_cluster_runtime` adds only derived readiness/index structures,
RLS policies and supporting indexes. It must not modify Journal/Handoff
authority. Catalog SQL uses tenant predicates, due time, stable
`available_at/partition_id/kind` keysets and `limit + 1`; cursor HMAC material
never enters SQL or logs.

- [ ] **Step 4: Add live PostgreSQL concurrency proof**

Under `PG_TEST_URL`, create two tenant sessions, seed two partitions, race two
lease owners and prove one winner followed by expiry takeover with a greater
fencing token. Verify RLS hides the other tenant. Keep the test skipped when
the environment variable is absent.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test -- packages/adapter-storage-postgres/test/postgres-cluster-runtime.test.ts && npm run verify:postgres`

Expected: fake-client tests PASS; live tests PASS or explicitly SKIP without
`PG_TEST_URL`; WFPP 120/120.

```sh
git add packages/adapter-storage-postgres tools/postgres-migrate.ts tools/postgres-smoke.ts
git commit -m "feat(cluster): discover PostgreSQL partition work"
```

---

### Task 7: Node composition, local boundary and operational snapshot

**Files:**
- Modify: `packages/service-node/src/config.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/src/main.ts`
- Create: `packages/service-node/test/cluster-composition.integration.test.ts`
- Modify: `packages/operations-spi/src/operations.ts`
- Modify: `packages/operations-runtime/src/operations-query-service.ts`
- Modify: `packages/transport-http/src/routes/operations-routes.ts`
- Modify: `packages/sdk-typescript/src/operations-client.ts`
- Modify: corresponding tests

**Interfaces:**
- Consumes: `ClusterHost`, Adapter catalog/lease factory, existing service storage.
- Produces: explicit `api | worker | all` service roles, worker lifecycle, `GET /v1/operations/cluster` metadata snapshot and SDK method.

- [ ] **Step 1: Write failing config and composition tests**

```ts
it("rejects clustered SQLite and unbounded worker settings", () => {
  expect(() => parseServiceConfig({
    ...baseConfig, storage_profile: "sqlite-local", role: "worker",
    cluster: { ...validCluster, worker_owner_id: "worker-a" },
  })).toThrow(/single-process/i);
  expect(() => parseServiceConfig({
    ...baseConfig, storage_profile: "postgres", role: "worker",
    cluster: { ...validCluster, max_concurrent_turns: 0 },
  })).toThrow(/max_concurrent_turns/);
});
```

- [ ] **Step 2: Run and confirm role/config failure**

Run: `npm test -- packages/service-node/test/config.test.ts packages/service-node/test/cluster-composition.integration.test.ts`

Expected: FAIL because `worker` role and cluster configuration are absent.

- [ ] **Step 3: Implement explicit composition**

Add `cluster?: ClusterHostConfig` only for `worker`/`all`. PostgreSQL requires
deployment-injected catalog, tenant-scoped lease factory, wakeup ports and
owner ID. `listen()` starts the HTTP service only for `api`/`all`; `start()`
starts the host only for `worker`/`all`; `close()` drains host before closing
HTTP/storage. No ambient credentials are loaded.

- [ ] **Step 4: Add metadata-only cluster operations view**

Expose only:

```ts
interface ClusterOperationalSnapshot {
  state: "idle" | "running" | "draining" | "stopped";
  ready_items: number;
  in_flight_turns: number;
  completed_turns: number;
  lease_losses: number;
  dropped_wakeups: number;
  observed_at: string;
}
```

Route and SDK use the existing Authority/audit path and never expose owners,
tokens, Tenant/Partition IDs or raw errors.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test -- packages/service-node/test packages/transport-http/test/operations-routes.test.ts packages/sdk-typescript/test/operations-visibility-client.test.ts`

Expected: PASS.

```sh
git add packages/service-node packages/operations-spi packages/operations-runtime packages/transport-http packages/sdk-typescript
git commit -m "feat(cluster): compose bounded worker roles"
```

---

### Task 8: Fault proof, performance baseline, docs and release gates

**Files:**
- Create: `packages/service-node/test/phase-6a-cluster-roundtrip.integration.test.ts`
- Create: `tools/benchmark-cluster-runtime.ts`
- Create: `tools/check-cluster-boundaries.ts`
- Modify: `tools/phase5-gates.test.ts` or create `tools/phase6-gates.test.ts`
- Modify: `package.json`
- Create: `docs/cluster-runtime.md`
- Create: `docs/performance-cluster-baseline.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/postgresql-deployment.md`
- Modify: `docs/sqlite-deployment.md`
- Modify: this plan checklist

**Interfaces:**
- Consumes: all Phase 6A packages and public HTTP/SDK surface.
- Produces: black-box proof, reproducible benchmark, dependency/safety gates and deployment runbook.

- [ ] **Step 1: Write the failing two-host roundtrip**

The test must use real HTTP/SDK lifecycle commands to create committed facts,
two cluster hosts sharing the same durable test Adapter, an in-process wakeup
bus with injected duplicate/loss, and an external Signal probe. Assert:

```ts
expect(authoritativeHandoff.lifecycle_state).toBe("verified");
expect(projectionFreshness.projected_position).toBe(
  projectionFreshness.journal_position,
);
expect(new Set(signalProbe.map((item) => item.event_id)).size).toBe(5);
expect(clusterA.completed_turns + clusterB.completed_turns).toBeGreaterThan(0);
expect(staleOwnerAdvancedPosition).toBe(false);
```

- [ ] **Step 2: Run and confirm the proof fails before final wiring**

Run: `npm test -- packages/service-node/test/phase-6a-cluster-roundtrip.integration.test.ts`

Expected: FAIL until all cluster composition is connected.

- [ ] **Step 3: Complete wiring and pass fault proof**

Exercise race, expiry takeover, dropped hint recovery, duplicate hint
coalescing, hot/quiet tenant fairness and bounded drain without fixed sleeps.

- [ ] **Step 4: Add benchmark and gates**

`benchmark:cluster` accepts bounded `--partitions`, `--tenants`,
`--concurrency`, `--samples`; reports environment plus p50/p95/p99 catalog,
lease, turn, catch-up and fairness. `check:cluster-boundaries` rejects Broker or
database imports from cluster SPI/runtime, participant-execution vocabulary,
unbounded `Promise.all` over catalog results and sensitive telemetry labels.

- [ ] **Step 5: Document exact deployment boundary**

Document worker roles, configuration bounds, tenant source, RLS, graceful
drain, fault recovery, why hints are non-authoritative, SQLite rejection and
the absence of Agent/workflow scheduling. Mark Phase 6A complete and Phase 6B
next only after verification passes.

- [ ] **Step 6: Run complete verification**

```sh
npm run verify:exchange
npm run verify:postgres
npm run check:cluster-boundaries
npm run check:sensitive-observability
npm run benchmark:cluster -- --partitions 100 --tenants 4 --concurrency 8 --samples 3
npm run verify
git diff --check
```

Expected: all tests PASS, environment-dependent PostgreSQL live tests may
explicitly SKIP, WFPP conformance is 120/120, gates report no violations.

- [ ] **Step 7: Commit**

```sh
git add README.md docs package.json packages/service-node/test tools
git commit -m "test(cluster): prove Phase 6A clustered runtime"
```

---

## Completion checklist

- [ ] Cluster SPI and conformance are technology neutral and bounded.
- [ ] Ready queue is tenant-fair, coalescing and capacity bounded.
- [ ] Lease loss aborts stale turns and fencing prevents stale progress.
- [ ] Existing projectors and Signal Dispatcher remain the only owner logic.
- [ ] Wakeup loss/duplication does not lose authoritative work.
- [ ] PostgreSQL catalog is RLS/keyset/index based.
- [ ] SQLite rejects clustered ownership while retaining local operation.
- [ ] Node roles start and drain only their explicitly configured components.
- [ ] Operational views and telemetry contain no sensitive/high-cardinality identity.
- [ ] Two-host HTTP/SDK roundtrip and fault injection pass.
- [ ] Performance evidence is reproducible and narrowly scoped.
- [ ] Full repository verification and WFPP 120/120 pass from a clean branch.
