# Phase 6B NATS Wakeup Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production NATS JetStream Adapter that accelerates internal partition wakeups without making Broker state authoritative or changing public WFPP/HTTP/SDK behavior.

**Architecture:** Keep the Phase 6A database catalog, Journal, Outbox, checkpoints, delivery positions and leases authoritative. A technology-specific NATS package implements the existing wakeup Publisher/Consumer ports using strict metadata encoding, HMAC tenant subjects, a pre-provisioned stream and durable pull consumer; service-node remains NATS-free and database polling always remains active.

**Tech Stack:** TypeScript 7, Node.js 22.20+, Vitest 4, `@nats-io/transport-node` 3.1.0, `@nats-io/jetstream` 3.1.0, NATS Server 2.10+ (release proof on 2.12.1), existing Work Fabric cluster SPI/runtime and semantic telemetry.

## Global Constraints

- Broker payloads are closed-shape metadata only and at most 4,096 bytes.
- Journal, Outbox, checkpoints, delivery positions, readiness catalog and leases remain authoritative.
- Database polling remains enabled during Broker health, outage and recovery.
- No NATS type or dependency enters Exchange Core, cluster runtime, service-node, HTTP, SDK or WFPP artifacts.
- No target ranking, workflow scheduling, Agent reasoning, model/tool invocation or participant execution is added.
- Runtime credentials and connections are deployment-injected; code never loads or prints ambient NATS secrets.
- Every pull, queue, poison skip, retry, page, benchmark input and shutdown wait is bounded.
- New behavior follows red-green-refactor and each task ends in a focused commit.

---

### Task 1: Wakeup transport capability and conformance profile

**Files:**
- Modify: `packages/cluster-spi/src/contracts.ts`
- Create: `packages/exchange-conformance/src/wakeup-transport-profile.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/wakeup-transport-profile.test.ts`
- Modify: `packages/adapter-cluster-memory/src/index.ts`
- Modify: `packages/adapter-cluster-memory/test/memory-cluster.test.ts`

**Interfaces:**
- Consumes: existing `PartitionWakeupPublisher`, `PartitionWakeupConsumer`, `PartitionWakeup`, `WakeupDelivery`.
- Produces: `WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES`, `WakeupTransportProfileSubject`, `WakeupTransportProfileFactory`, `verifyWakeupTransportProfile(factory)`.

- [x] **Step 1: Write the failing conformance test**

```ts
it("verifies a standalone metadata wakeup transport", async () => {
  await verifyWakeupTransportProfile(
    () => new MemoryClusterAdapter(),
  );
});
```

The profile must publish the canonical fixture twice, assert immutable cloned
deliveries, Retry/redelivery, Ack removal, second-settlement rejection,
pre-aborted `next()` rejection and all required capability flags.

- [x] **Step 2: Run the red test**

Run:

```sh
npx vitest run packages/exchange-conformance/test/wakeup-transport-profile.test.ts
```

Expected: FAIL because `verifyWakeupTransportProfile` and the capability list
do not exist.

- [x] **Step 3: Add the technology-neutral capability list**

```ts
export const WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "bounded_delivery",
  "explicit_settlement",
  "duplicate_wakeup_tolerance",
  "lost_wakeup_poll_recovery",
  "payload_size_limit",
  "deep_clone",
] as const;
```

Keep `CLUSTER_REQUIRED_CAPABILITIES` for the composite catalog profile and add
the Wakeup flags to the Memory Adapter manifest without renaming the
`workfabric.cluster.v1` profile.

- [x] **Step 4: Implement the reusable profile**

```ts
export type WakeupTransportProfileSubject =
  PartitionWakeupPublisher & PartitionWakeupConsumer;

export type WakeupTransportProfileFactory = () =>
  | WakeupTransportProfileSubject
  | Promise<WakeupTransportProfileSubject>;

export async function verifyWakeupTransportProfile(
  factory: WakeupTransportProfileFactory,
): Promise<void>;
```

Use `node:assert`, the existing canonical cluster fixture and
`assertCapabilities`. Never inspect Adapter-private queues.

- [x] **Step 5: Run focused and type verification**

```sh
npm run typecheck
npx vitest run packages/exchange-conformance/test/wakeup-transport-profile.test.ts packages/adapter-cluster-memory/test
```

Expected: PASS.

- [x] **Step 6: Commit**

```sh
git add packages/cluster-spi packages/exchange-conformance packages/adapter-cluster-memory
git commit -m "feat(cluster): define wakeup transport profile"
```

---

### Task 2: Strict Wakeup payload and tenant subject codecs

**Files:**
- Create: `packages/adapter-cluster-nats/package.json`
- Create: `packages/adapter-cluster-nats/src/errors.ts`
- Create: `packages/adapter-cluster-nats/src/config.ts`
- Create: `packages/adapter-cluster-nats/src/wakeup-codec.ts`
- Create: `packages/adapter-cluster-nats/src/subject-codec.ts`
- Create: `packages/adapter-cluster-nats/src/index.ts`
- Create: `packages/adapter-cluster-nats/test/wakeup-codec.test.ts`
- Create: `packages/adapter-cluster-nats/test/subject-codec.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `validatePartitionWakeup`, `PARTITION_WORK_KINDS`.
- Produces: `NatsWakeupError`, `encodeWakeup`, `decodeWakeup`, `HmacWakeupSubjectCodec`, `normalizeNatsWakeupRuntimeConfig`.

- [x] **Step 1: Add the workspace package and write failing codec tests**

Package manifest:

```json
{
  "name": "@work-fabric/adapter-cluster-nats",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "dependencies": {
    "@nats-io/jetstream": "3.1.0",
    "@nats-io/transport-node": "3.1.0",
    "@work-fabric/cluster-spi": "0.1.0",
    "@work-fabric/exchange-spi": "0.1.0"
  },
  "devDependencies": {
    "@work-fabric/exchange-conformance": "0.1.0"
  }
}
```

Tests assert exact JSON round-trip, unknown field rejection, missing field
rejection, invalid timestamp/position rejection, arbitrary `content` and
`credential` rejection, oversized bytes rejection and defensive cloning.

- [x] **Step 2: Run the red codec tests**

```sh
npm install
npx vitest run packages/adapter-cluster-nats/test/wakeup-codec.test.ts packages/adapter-cluster-nats/test/subject-codec.test.ts
```

Expected: FAIL because codec modules do not exist.

- [x] **Step 3: Implement closed-shape payload encoding**

```ts
export const NATS_WAKEUP_SCHEMA = "workfabric.partition-wakeup.v1";
export const NATS_WAKEUP_MAX_BYTES = 4_096;

export function encodeWakeup(wakeup: PartitionWakeup): Uint8Array;
export function decodeWakeup(bytes: Uint8Array): PartitionWakeup;
```

Require exactly `schema` plus the seven Wakeup fields via sorted key equality.
Parse UTF-8 with fatal decoding, reject non-object/array values, validate with
`validatePartitionWakeup`, and clone all returned values.

- [x] **Step 4: Implement HMAC tenant subjects**

```ts
export class HmacWakeupSubjectCodec {
  constructor(options: {
    subject_prefix: string;
    subject_key_id: string;
    subject_key: Uint8Array;
    allowed_tenant_ids: readonly string[];
  });

  subjectFor(wakeup: PartitionWakeup): string;
  filterSubjects(): readonly string[];
  assertMatches(subject: string, wakeup: PartitionWakeup): void;
}
```

Use HMAC-SHA256 base64url, compare token strings with constant-time byte
comparison, validate literal NATS tokens, sort/deduplicate Tenant IDs and emit
exactly Tenant × four work-kind filters. Reject keys outside 32–128 bytes and
Tenant sets outside 1–250.

- [x] **Step 5: Implement stable local errors and normalized bounds**

```ts
export type NatsWakeupErrorCode =
  | "invalid_wakeup_payload"
  | "invalid_wakeup_subject"
  | "wakeup_transport_unavailable"
  | "wakeup_delivery_settled"
  | "wakeup_adapter_closed"
  | "wakeup_topology_drift";
```

Errors expose only the stable code. Runtime configuration defaults are pull
1,000 ms, Retry 1,000 ms and poison limit 10, with exact design bounds.

- [x] **Step 6: Run green tests and commit**

```sh
npm run typecheck
npx vitest run packages/adapter-cluster-nats/test/wakeup-codec.test.ts packages/adapter-cluster-nats/test/subject-codec.test.ts
git add package-lock.json packages/adapter-cluster-nats
git commit -m "feat(nats): encode isolated wakeup hints"
```

Expected: PASS.

---

### Task 3: JetStream Publisher and bounded pull Consumer

**Files:**
- Create: `packages/adapter-cluster-nats/src/nats-port.ts`
- Create: `packages/adapter-cluster-nats/src/nats-wakeup-publisher.ts`
- Create: `packages/adapter-cluster-nats/src/nats-wakeup-consumer.ts`
- Create: `packages/adapter-cluster-nats/src/nats-wakeup-adapter.ts`
- Modify: `packages/adapter-cluster-nats/src/index.ts`
- Create: `packages/adapter-cluster-nats/test/fake-nats-port.ts`
- Create: `packages/adapter-cluster-nats/test/nats-wakeup-publisher.test.ts`
- Create: `packages/adapter-cluster-nats/test/nats-wakeup-consumer.test.ts`
- Create: `packages/adapter-cluster-nats/test/nats-wakeup-conformance.test.ts`

**Interfaces:**
- Consumes: Task 1 Wakeup profile; Task 2 codecs/config/errors; injected `NatsConnection`.
- Produces: internal `WakeupJetStreamPort`, `NatsWakeupPublisher`, `NatsWakeupConsumer`, `createNatsWakeupAdapter(options)`.

- [x] **Step 1: Write failing Publisher behavior tests**

Assert:

```ts
await expect(publisher.publish(wakeup)).resolves.toBe("accepted");
expect(port.publications[0]).toMatchObject({
  subject: subjectCodec.subjectFor(wakeup),
  message_id: wakeup.wakeup_id,
});
```

Also assert timeout/disconnect/server failures return `retryable_failure`,
invalid input throws before the fake port is called, and no raw Broker error is
returned.

- [x] **Step 2: Run Publisher tests red, then implement minimal Publisher**

```sh
npx vitest run packages/adapter-cluster-nats/test/nats-wakeup-publisher.test.ts
```

The lower port is:

```ts
export interface WakeupJetStreamPort {
  publish(input: {
    subject: string;
    payload: Uint8Array;
    message_id: string;
  }): Promise<void>;
  pull(input: {
    stream: string;
    consumer: string;
    expires_ms: number;
  }): Promise<WakeupJetStreamMessage | null>;
}
```

The real implementation wraps the `@nats-io/jetstream` 3.1.0 API over an
injected `@nats-io/transport-node` connection and owns no
connection credentials.

- [x] **Step 3: Write failing Consumer settlement tests**

Cover one valid delivery, Ack once, delayed Nak once, mixed/double settlement,
pre-aborted call, abort during pull, pull expiry, closed Adapter and deep clone.
The fake message exposes `ack()`, `nak(delayMs)` and `term()` call counts.

- [x] **Step 4: Implement one-outstanding-pull Consumer**

```ts
export class NatsWakeupConsumer implements PartitionWakeupConsumer {
  next(signal: AbortSignal): Promise<WakeupDelivery | null>;
  close(): Promise<void>;
}
```

Race the lower-port pull with the caller AbortSignal, but configure the server
request with `expires_ms` so an aborted request cannot remain unbounded. Guard
settlement locally before sending Ack/Nak.

- [x] **Step 5: Add bounded poison handling**

Within one `next()` call, terminate at most `max_poison_per_pull` malformed,
oversized or subject-mismatched messages. Return `null` after the bound and emit
only a fixed semantic outcome through the optional observer. Never include
subject, Tenant, payload or Broker exception in telemetry.

- [x] **Step 6: Compose Publisher/Consumer and run conformance**

```ts
export async function createNatsWakeupAdapter(
  options: NatsWakeupRuntimeOptions,
): Promise<NatsWakeupAdapter>;
```

Two factories sharing one fake stream must pass
`verifyWakeupTransportProfile`. Keep connection close/drain deployment-owned;
Adapter `close()` cancels pulls and refuses new operations.

- [x] **Step 7: Run focused tests and commit**

```sh
npm run typecheck
npx vitest run packages/adapter-cluster-nats/test/nats-wakeup-publisher.test.ts packages/adapter-cluster-nats/test/nats-wakeup-consumer.test.ts packages/adapter-cluster-nats/test/nats-wakeup-conformance.test.ts
git add packages/adapter-cluster-nats
git commit -m "feat(nats): transport bounded wakeup hints"
```

Expected: PASS.

---

### Task 4: Declarative JetStream topology and explicit CLI

**Files:**
- Create: `packages/adapter-cluster-nats/src/topology.ts`
- Create: `packages/adapter-cluster-nats/test/topology.test.ts`
- Create: `tools/nats-wakeup-topology.ts`
- Create: `tools/nats-wakeup-topology.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: subject codec filter subjects and `NatsConnection.jetstreamManager()`.
- Produces: `desiredNatsWakeupTopology(config)`, `reconcileNatsWakeupTopology(port, desired, mode)`, `npm run nats:wakeup-topology`.

- [x] **Step 1: Write failing desired-topology tests**

Assert stream limits/file/discard-old/4,096-byte settings and consumer
explicit-Ack/deliver-new/filter/timing settings exactly match the design.
Validate max age 60–86,400 seconds, max bytes 1 MiB–10 GiB, replicas 1–5,
Ack wait 5–300 seconds, MaxDeliver 1–20, MaxAckPending 1–10,000 and MaxWaiting
1–256.

- [x] **Step 2: Write failing reconciliation tests**

Use an in-memory management port to prove:

- missing resources produce a plan and mutate only in `apply` mode;
- exact resources produce no action;
- compatible max-age/max-bytes/replica/timing/filter changes update;
- subject namespace, retention and storage drift throw
  `wakeup_topology_drift`;
- no path deletes or purges resources.

- [x] **Step 3: Implement topology normalization and reconciliation**

```ts
export type NatsTopologyMode = "plan" | "verify" | "apply";
export interface NatsTopologyResult {
  readonly mode: NatsTopologyMode;
  readonly actions: readonly {
    readonly resource: "stream" | "consumer";
    readonly action: "create" | "update";
  }[];
}
```

The result contains no URL, subject key, Tenant ID or raw server response.

- [x] **Step 4: Add explicit CLI and tests**

CLI accepts `--connection-string`, `--config`, one of `--plan`, `--verify`,
`--apply`, defaults to plan, loads the subject key only from
`WORK_FABRIC_NATS_SUBJECT_KEY`, and writes a safe JSON action summary. It must
never print the connection string or key, including on failure.

- [x] **Step 5: Run and commit**

```sh
npm run typecheck
npx vitest run packages/adapter-cluster-nats/test/topology.test.ts tools/nats-wakeup-topology.test.ts
git add package.json packages/adapter-cluster-nats tools/nats-wakeup-topology.ts tools/nats-wakeup-topology.test.ts
git commit -m "feat(nats): provision wakeup topology safely"
```

Expected: PASS.

---

### Task 5: Live NATS integration and reproducible benchmark

**Files:**
- Create: `packages/adapter-cluster-nats/test/nats-wakeup.live.test.ts`
- Create: `tools/benchmark-nats-wakeup.ts`
- Create: `tools/nats-server-release.ts`
- Create: `tools/nats-server-release.test.ts`
- Modify: `package.json`
- Create: `docs/performance-nats-wakeup-baseline.md`

**Interfaces:**
- Consumes: production topology and Adapter.
- Produces: `verify:nats`, `benchmark:wakeup`, official temporary NATS Server release runner and recorded baseline.

- [x] **Step 1: Write the live test behind `NATS_TEST_URL`**

Use a cryptographically unique prefix/stream/consumer, provision replicas 1,
and test Publish/Ack, delayed Retry/redelivery, duplicate message ID tolerance
and two Adapter instances sharing one durable consumer. Cleanup deletes only
the exact unique test consumer/stream.

- [x] **Step 2: Verify explicit skip without a server**

```sh
npx vitest run packages/adapter-cluster-nats/test/nats-wakeup.live.test.ts
```

Expected: one explicit skip when `NATS_TEST_URL` is absent; all non-live tests
remain executed by `verify:nats`.

- [x] **Step 3: Add an official release verifier**

`tools/nats-server-release.ts` downloads the exact official NATS Server 2.12.1
archive for Darwin arm64 or Linux x64/arm64 into an OS temporary directory,
using
`https://github.com/nats-io/nats-server/releases/download/v2.12.1/` assets,
verifies the release `SHA256SUMS` entry before extraction, starts with
JetStream on an ephemeral port, waits on the server readiness endpoint without
fixed sleep, runs a supplied command with `NATS_TEST_URL`, then terminates and
removes the temporary directory. Unsupported platforms fail with a clear
message rather than silently skipping.

The unit test covers asset selection, checksum mismatch and cleanup using
injected downloader/process ports without network access.

- [x] **Step 4: Run the live proof on the official temporary server**

Add these exact scripts:

```json
{
  "verify:nats": "npm run typecheck && vitest run packages/adapter-cluster-nats/test tools/nats-wakeup-topology.test.ts tools/nats-server-release.test.ts",
  "nats:release": "tsx tools/nats-server-release.ts --",
  "verify:nats:release": "npm run nats:release -- npm run verify:nats",
  "benchmark:wakeup": "tsx tools/benchmark-nats-wakeup.ts"
}
```

```sh
npm run verify:nats:release
```

Expected: all NATS package tests pass and the live test count contains zero
skips.

- [x] **Step 5: Implement the bounded live benchmark**

```ts
export interface NatsWakeupBenchmarkOptions {
  readonly messages: number;      // 1–100000
  readonly publishers: number;    // 1–64 and <= messages
  readonly consumers: number;     // 1–64 and <= messages
  readonly samples: number;       // 1–20
}
```

Require `NATS_TEST_URL`, pre-provision a unique topology, publish deterministic
metadata only, Ack every delivery, and report environment/configuration,
PubAck p50/p95/p99, consume-to-Ack p50/p95/p99, throughput, duplicate ratio and
redelivery count. Use bounded worker loops rather than unbounded Promise arrays.

- [x] **Step 6: Record the reference run and commit**

```sh
npm run nats:release -- npm run benchmark:wakeup -- --messages 1000 --publishers 4 --consumers 4 --samples 3
git add package.json packages/adapter-cluster-nats/test tools docs/performance-nats-wakeup-baseline.md
git commit -m "test(nats): prove live wakeup acceleration"
```

Document hardware/runtime, exact server/client versions, measured percentiles
and the explicit non-claim that this measures participant work.

---

### Task 6: Broker outage fallback, boundaries and deployment docs

**Files:**
- Create: `packages/service-node/test/phase-6b-nats-fallback.integration.test.ts`
- Modify: `tools/check-cluster-boundaries.ts`
- Modify: `tools/check-sensitive-observability.ts`
- Modify: `tools/phase6-gates.test.ts`
- Modify: `docs/cluster-runtime.md`
- Create: `docs/nats-wakeup-deployment.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Phase 6A HTTP/SDK lifecycle and Cluster Host; production NATS Adapter via fake-disconnectable lower port for deterministic fault proof.
- Produces: outage/recovery integration proof, dependency/safety gates and operator documentation.

- [x] **Step 1: Write the failing fallback integration test**

The test creates authoritative lifecycle events through the real HTTP and
TypeScript SDK, makes NATS publish/pull unavailable, runs two Cluster Hosts,
and proves database catalog polling still advances Handoff and collaboration
projections plus Signal delivery. After Broker recovery, stale/repeated hints
must not add Signal deliveries or advance checkpoints twice.

- [x] **Step 2: Run red and connect the Adapter seam**

```sh
npx vitest run packages/service-node/test/phase-6b-nats-fallback.integration.test.ts
```

Expected initial failure: missing NATS Adapter/fault fixture. Implement only
deployment injection needed by the test; do not add NATS imports or config to
service-node.

- [x] **Step 3: Strengthen static boundaries**

The gate must enforce:

- `@nats-io/transport-node` and `@nats-io/jetstream` imports exist only under
  `packages/adapter-cluster-nats` and the two NATS tools;
- no Broker vocabulary enters `cluster-spi` public identifiers;
- NATS payload codec cannot import Handoff/Context/Result domain types;
- no unbounded `Promise.all` over pull or publish result sets;
- telemetry contains no Tenant, partition, subject, stream, consumer,
  Wakeup/Event/Handoff ID, URL, credential or payload labels.

Add bad fixtures for each dependency and telemetry rule.

- [x] **Step 4: Document exact operating boundary**

Document topology planning/apply, separate management/runtime credentials,
TLS/NKey/JWT responsibility, HMAC subject key handling, rotation via new key
ID, Tenant assignment, monitoring, Broker degradation, database polling,
shutdown order and resource retention. Mark 6B complete only after all gates.

- [x] **Step 5: Run focused verification and commit**

```sh
npm run typecheck
npx vitest run packages/service-node/test/phase-6b-nats-fallback.integration.test.ts tools/phase6-gates.test.ts
npm run check:cluster-boundaries
npm run check:sensitive-observability
git add README.md docs packages/service-node/test tools
git commit -m "docs(nats): operate wakeup acceleration safely"
```

Expected: PASS.

---

### Task 7: Full Phase 6B release verification

**Files:**
- Modify: `docs/superpowers/plans/2026-07-16-phase-6b-nats-wakeup-acceleration-implementation.md`

**Interfaces:**
- Consumes: all previous Phase 6B deliverables.
- Produces: clean, committed and pushed Phase 6B branch with reproducible evidence.

- [ ] **Step 1: Run the complete release chain**

```sh
npm run verify:exchange
npm run verify:postgres
npm run verify:nats:release
npm run check:cluster-boundaries
npm run check:sensitive-observability
npm run benchmark:cluster -- --partitions 100 --tenants 4 --concurrency 8 --samples 3
npm run nats:release -- npm run benchmark:wakeup -- --messages 1000 --publishers 4 --consumers 4 --samples 3
npm run verify
git diff --check
```

Expected: zero failures; environment-dependent PostgreSQL tests may explicitly
skip without `PG_TEST_URL`; the temporary NATS release run has zero NATS live
skips; WFPP remains 120/120.

- [ ] **Step 2: Review the project boundary**

Verify by source search and test assertions that Broker data is metadata only,
polling remains active, no public API/SDK schema changed, and no participant
execution/scheduling code was introduced.

- [ ] **Step 3: Mark this plan complete and commit**

```sh
git add docs/superpowers/plans/2026-07-16-phase-6b-nats-wakeup-acceleration-implementation.md
git commit -m "test(nats): complete Phase 6B wakeup acceleration"
```

- [ ] **Step 4: Push without force**

```sh
git push -u origin codex/phase-6b-nats-wakeup
```

Expected: remote branch points at the verified commit and the worktree remains
available for review.

---

## Completion checklist

- [ ] Existing public Wakeup SPI remains technology neutral.
- [ ] NATS package is the only production dependency on the official NATS.js packages.
- [ ] Payloads are strict metadata and at most 4,096 bytes.
- [ ] Tenant subjects are HMAC-isolated and filter-bound.
- [ ] Publisher uses PubAck and stable retryable classification.
- [ ] Consumer pull, poison handling and settlement are bounded.
- [ ] Database catalog polling recovers every Broker loss/outage case.
- [ ] Topology mutation is explicit, safe and never destructive.
- [ ] Runtime and management credentials are separable.
- [ ] Live official-server proof contains no NATS skips.
- [ ] Benchmark evidence is reproducible and narrowly scoped.
- [ ] Full repository verification and WFPP 120/120 pass.
