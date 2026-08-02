# Work Fabric Participation Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `workfabric.discovery.v1` so an authenticated generic Agent can obtain its authorized view of Exchanges, capabilities, Endpoints, and safe channel bindings without network-wide broadcast, then use the existing Resolver/Federation/Handoff path under a fresh authorization decision.

**Architecture:** Add an independent Discovery SPI and Runtime beside, never inside, Exchange Core and Federation Runtime. Existing Endpoint Sessions remain the local authority; a policy-filtered exporter derives stable records, durable adapters hold separate local/remote records and tombstones, signed direct-peer pull/query exchanges update caches under strict budgets, and HTTP/SDK expose caller-authorized unranked facts.

**Tech Stack:** TypeScript 7, Node.js 22+, Vitest, canonical JSON, Ed25519 via `node:crypto`, Fastify, existing Work Fabric Identity/Authority, SQLite local durable adapter, PostgreSQL/RLS production adapter.

## Global Constraints

- Profile name is exactly `workfabric.discovery.v1`.
- Exchange Core, Federation Runtime, Cluster Runtime, and WFPP Handoff state machine MUST NOT import Discovery.
- Runtime Session IDs, heartbeat sequences, fencing tokens, credentials, tenant IDs, private addresses, prompts, Context, and Results MUST NOT enter cross-Exchange records.
- Runtime heartbeats remain local; unchanged exported semantic digests produce zero cross-Exchange updates.
- Discovery returns attributable, deterministic, unranked facts; it MUST NOT score, recommend, select, invoke, accept, or execute.
- Discoverability does not grant trust, Invocation Authority, or responsibility.
- Public/peer responses are bounded to 65,536 bytes; message TTL is 1–300 seconds; allowed clock skew is 0–60 seconds.
- Default transit is disabled; any transitive query has monotonically decreasing hop, fan-out, result, byte, and deadline budgets.
- Unauthorized and absent Actor/Endpoint detail MUST have indistinguishable external behavior.
- Memory is development/reference only; SQLite is restart-safe single-process; PostgreSQL is the production multi-host store.
- Tests use fake clocks/IDs/transports and MUST NOT use timing sleeps or public network access.
- Each task begins with a failing test and ends with a focused commit.

---

## File map

### New packages

```text
packages/discovery-spi/
  src/records.ts          closed record and payload contracts
  src/messages.ts         signed peer request/response contracts and budgets
  src/ports.ts            store, source, policy, crypto, transport, clock ports
  src/capabilities.ts     profile constants, Authority actions, adapter manifest
  src/index.ts            public exports only

packages/discovery-runtime/
  src/canonical-json.ts   strict canonical JSON bytes/digests
  src/errors.ts           stable public/runtime error taxonomy
  src/record-codec.ts     record normalization, origin sign/verify
  src/message-codec.ts    peer envelope normalization, audience/time/signature
  src/cache-service.ts    revision/tombstone/expiry/conflict state machine
  src/endpoint-exporter.ts stable Endpoint Directory -> capability route projection
  src/export-coordinator.ts coalesced, jitter-ready local refresh scheduling
  src/query-service.ts    caller-scoped local/cache query and detail resolution
  src/gateway.ts          bounded sync/query request-response protocol
  src/operations.ts       bounded low-cardinality operational snapshots
  src/index.ts            public exports

packages/adapter-discovery-memory/
  src/memory-discovery-store.ts bounded tenant-view record/change/cursor store
  src/memory-peer-store.ts      versioned explicit Peer bindings
  src/index.ts

packages/adapter-discovery-node-crypto/
  src/index.ts            Ed25519 signer and explicit Exchange/key trust map
```

### Existing packages

```text
packages/exchange-conformance/src/discovery-profile.ts
packages/adapter-storage-sqlite/src/sqlite-discovery-store.ts
packages/adapter-storage-postgres/src/postgres-discovery-store.ts
packages/adapter-storage-postgres/migrations/010_discovery.sql
packages/transport-http/src/routes/discovery-routes.ts
packages/sdk-typescript/src/discovery-client.ts
packages/service-node/src/compose.ts
tools/check-discovery-boundaries.ts
```

---

### Task 1: Discovery SPI and closed contracts

**Files:**
- Create: `packages/discovery-spi/package.json`
- Create: `packages/discovery-spi/src/capabilities.ts`
- Create: `packages/discovery-spi/src/records.ts`
- Create: `packages/discovery-spi/src/messages.ts`
- Create: `packages/discovery-spi/src/ports.ts`
- Create: `packages/discovery-spi/src/index.ts`
- Create: `packages/discovery-spi/test/contracts.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `DiscoveryRecord`, `DiscoveryRecordPayload`, `DiscoveryQuery`, `DiscoveryPage`, `DiscoveryStore`, `DiscoveryDisclosurePolicy`, `DiscoverySigner`, `DiscoveryTrustResolver`, `DiscoveryPeerTransport`, `DiscoveryPeerBindingStore`, `DiscoveryClock`, and profile constants.
- Consumes: `JsonObject`, `CapabilityDescriptor`, `EndpointActorRef`, `BindingDescriptor` from `@work-fabric/exchange-spi` only.

- [ ] **Step 1: Write the failing package contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_AUTHORITY_ACTIONS,
  DISCOVERY_MAX_MESSAGE_BYTES,
  DISCOVERY_PROFILE,
  DISCOVERY_REQUIRED_STORE_CAPABILITIES,
} from "../src/index.js";

describe("discovery SPI", () => {
  it("publishes a closed bounded profile", () => {
    expect(DISCOVERY_PROFILE).toBe("workfabric.discovery.v1");
    expect(DISCOVERY_MAX_MESSAGE_BYTES).toBe(65_536);
    expect(DISCOVERY_AUTHORITY_ACTIONS).toEqual([
      "workfabric.discovery.query.v1",
      "workfabric.discovery.resolve.v1",
      "workfabric.discovery.peer.read.v1",
      "workfabric.discovery.peer.manage.v1",
      "workfabric.discovery.sync.v1",
      "workfabric.discovery.export.v1",
    ]);
    expect(DISCOVERY_REQUIRED_STORE_CAPABILITIES).toContain("conflicting_replay_rejection");
  });
});
```

- [ ] **Step 2: Run the test and verify the package does not yet resolve**

Run: `npx vitest run packages/discovery-spi/test/contracts.test.ts`

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 3: Implement exact immutable SPI contracts**

Define these discriminants and common fields exactly:

```ts
export type DiscoveryRecordKind = "exchange" | "capability_route" | "participant" | "endpoint";
export type DiscoveryVisibility = "public" | "federated" | "peer";
export type DiscoveryCoverage = "authoritative" | "complete" | "partial";

export interface DiscoveryUnsignedRecord<P extends DiscoveryRecordPayload = DiscoveryRecordPayload> {
  readonly profile: typeof DISCOVERY_PROFILE;
  readonly record_id: string;
  readonly record_kind: DiscoveryRecordKind;
  readonly origin_exchange_id: string;
  readonly revision: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly visibility: DiscoveryVisibility;
  readonly audiences: readonly string[];
  readonly transitive: boolean;
  readonly max_hops: number;
  readonly payload: P;
  readonly payload_digest: string;
  readonly key_id: string;
}

export interface DiscoveryRecord<P extends DiscoveryRecordPayload = DiscoveryRecordPayload>
  extends DiscoveryUnsignedRecord<P> {
  readonly signature: string;
}
```

Define payloads without tenant/session/fencing/heartbeat fields. Define `DiscoveryQueryBudget` with `deadline`, `remaining_hops`, `remaining_fanout`, `remaining_results`, and `remaining_bytes`. Every internal Store operation carries both local `tenant_id` for RLS/authority isolation and `tenant_view_id` for the caller-visible directory partition; neither field enters cross-Exchange records. Define `DiscoveryStore` methods `apply`, `get`, `query`, `changes`, `prune`, and `status`; `DiscoveryPeerBindingStore` methods `put`, `get`, and `list`; and manifests requiring tenant/view isolation, monotonic revisions, tombstones, expiry filtering, cursor binding, deterministic pagination, bounded capacity, and conflicting replay rejection.

- [ ] **Step 4: Run contracts and typecheck**

Run: `npx vitest run packages/discovery-spi/test/contracts.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the SPI**

```bash
git add packages/discovery-spi package-lock.json
git commit -m "feat(discovery): define participation discovery contracts"
```

### Task 2: Strict canonical records and Ed25519 adapter

**Files:**
- Create: `packages/discovery-runtime/package.json`
- Create: `packages/discovery-runtime/src/canonical-json.ts`
- Create: `packages/discovery-runtime/src/errors.ts`
- Create: `packages/discovery-runtime/src/record-codec.ts`
- Create: `packages/discovery-runtime/src/index.ts`
- Create: `packages/discovery-runtime/test/record-codec.test.ts`
- Create: `packages/adapter-discovery-node-crypto/package.json`
- Create: `packages/adapter-discovery-node-crypto/src/index.ts`
- Create: `packages/adapter-discovery-node-crypto/test/ed25519.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 `DiscoverySigner`, `DiscoveryTrustResolver`, record types.
- Produces: `DiscoveryRecordCodec.sign`, `DiscoveryRecordCodec.verify`, `discoveryPayloadDigest`, `NodeEd25519DiscoverySigner`, `NodeEd25519DiscoveryTrustResolver`.

- [ ] **Step 1: Write failing strict-codec tests**

Test a valid exchange record plus exact failures for unknown member, non-canonical bytes, payload digest mismatch, wrong audience, invalid signature, future issue time, expiry, TTL over 300 seconds, and bytes over 65,536. Include a JSON byte sequence with a duplicate key and a Unicode normalization variant.

```ts
await expect(codec.verify(tampered, { audience: "exchange-b" }))
  .rejects.toMatchObject({ code: "discovery_signature_invalid" });
await expect(codec.verify(overlong, { audience: "exchange-b" }))
  .rejects.toMatchObject({ code: "discovery_record_too_large" });
```

- [ ] **Step 2: Run codec tests and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/record-codec.test.ts`

Expected: FAIL because the Runtime package does not exist.

- [ ] **Step 3: Implement canonical JSON and record codec**

Adapt the strict canonical behavior from `federation-runtime` without importing that package. Verify exact sorted keys, closed payload keys per record kind, canonical byte equality, SHA-256 payload digest, origin identity, signature, audience, TTL, skew, and size before returning a structured clone.

```ts
export class DiscoveryRecordCodec {
  async sign(input: Omit<DiscoveryUnsignedRecord, "profile" | "key_id" | "payload_digest">): Promise<Uint8Array>;
  async verify(bytes: Uint8Array, input: { readonly audience: string }): Promise<DiscoveryRecord>;
}
```

- [ ] **Step 4: Implement the Node Ed25519 adapter and rotation test**

Use `sign(null, canonical, privateKey)` and `verify(null, canonical, publicKey, signature)`. Trust lookup key is `origin_exchange_id + audience + key_id`; unknown origin/key and a valid key for the wrong audience fail. Test old/new key overlap and removal.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run packages/discovery-runtime/test/record-codec.test.ts packages/adapter-discovery-node-crypto/test/ed25519.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the codec and crypto adapter**

```bash
git add packages/discovery-runtime packages/adapter-discovery-node-crypto package-lock.json
git commit -m "feat(discovery): sign and verify canonical records"
```

### Task 3: Memory record store and reusable conformance profile

**Files:**
- Create: `packages/adapter-discovery-memory/package.json`
- Create: `packages/adapter-discovery-memory/src/memory-discovery-store.ts`
- Create: `packages/adapter-discovery-memory/src/memory-peer-store.ts`
- Create: `packages/adapter-discovery-memory/src/index.ts`
- Create: `packages/adapter-discovery-memory/test/memory-discovery-store.test.ts`
- Create: `packages/exchange-conformance/src/discovery-profile.ts`
- Create: `packages/exchange-conformance/test/discovery-profile.test.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Modify: `packages/exchange-conformance/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 store and peer contracts.
- Produces: `MemoryDiscoveryStore`, `MemoryDiscoveryPeerBindingStore`, `verifyDiscoveryStoreProfile`.

- [ ] **Step 1: Write the failing conformance profile**

The profile must prove tenant-view isolation; structured-clone safety; idempotent same revision/digest; conflicting same revision rejection; lower revision ignore; higher revision replace; early tombstone; expiry exclusion; deterministic filtering/pagination; query-bound cursors; bounded per-origin eviction; and prune behavior.

```ts
await store.apply({ tenant_view_id: "view-a", source_peer_id: "peer-a", record });
assert.equal((await store.query({ tenant_view_id: "view-b", now, limit: 10 })).items.length, 0);
await assert.rejects(store.apply({ tenant_view_id: "view-a", source_peer_id: "peer-a", record: conflict }), /discovery_record_conflict/);
```

- [ ] **Step 2: Run the conformance test and verify failure**

Run: `npx vitest run packages/exchange-conformance/test/discovery-profile.test.ts`

Expected: FAIL because the adapter and profile do not exist.

- [ ] **Step 3: Implement the Memory stores**

Use explicit maps keyed by `tenant_id + tenant_view_id + origin_exchange_id + record_id`. Store a change sequence and opaque base64url cursor whose decoded signature binds tenant, view, and query filters. Never extend expiry on an ignored replay. Tombstones remain query-hidden but sync-visible until the retention timestamp.

- [ ] **Step 4: Verify the profile and adapter manifest**

Run: `npx vitest run packages/adapter-discovery-memory/test packages/exchange-conformance/test/discovery-profile.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Memory persistence semantics**

```bash
git add packages/adapter-discovery-memory packages/exchange-conformance package-lock.json
git commit -m "feat(discovery): add bounded record store profile"
```

### Task 4: Cache state machine and withdrawal safety

**Files:**
- Create: `packages/discovery-runtime/src/cache-service.ts`
- Create: `packages/discovery-runtime/test/cache-service.test.ts`
- Modify: `packages/discovery-runtime/src/index.ts`

**Interfaces:**
- Consumes: `DiscoveryRecordCodec`, `DiscoveryStore`, `DiscoveryClock`.
- Produces: `DiscoveryCacheService.accept(bytes, context)`, `withdrawLocal`, `prune`.

- [ ] **Step 1: Write failing cache transition tests**

Use a fake clock to cover accepted, duplicate, stale, conflicting, withdrawn, expired, wrong source Peer, and clock-skew cases. Prove a lost withdrawal is eventually removed by record expiry and an old live record cannot resurrect after a retained tombstone.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/cache-service.test.ts`

Expected: FAIL with missing `DiscoveryCacheService`.

- [ ] **Step 3: Implement minimal verified cache mutation**

```ts
export class DiscoveryCacheService {
  accept(input: {
    readonly tenant_id: string;
    readonly tenant_view_id: string;
    readonly source_peer_id: string;
    readonly audience_exchange_id: string;
    readonly bytes: Uint8Array;
  }): Promise<DiscoveryApplyResult>;
  prune(tenantViewId: string): Promise<number>;
}
```

Verification must finish before the store is called. Map internal failures to stable `DiscoveryError` codes without echoing record content.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run packages/discovery-runtime/test/cache-service.test.ts packages/discovery-runtime/test/record-codec.test.ts && npm run typecheck`

```bash
git add packages/discovery-runtime
git commit -m "feat(discovery): enforce cache revision and expiry safety"
```

### Task 5: Stable local Endpoint exporter

**Files:**
- Create: `packages/discovery-runtime/src/endpoint-exporter.ts`
- Create: `packages/discovery-runtime/src/export-coordinator.ts`
- Create: `packages/discovery-runtime/test/endpoint-exporter.test.ts`
- Create: `packages/discovery-runtime/test/export-coordinator.test.ts`
- Modify: `packages/discovery-runtime/src/index.ts`
- Modify: `packages/discovery-runtime/package.json`

**Interfaces:**
- Consumes: existing `EndpointDirectoryStore.discover`, Task 2 codec, Task 3 store, `DiscoveryExportPolicy`.
- Produces: `EndpointDiscoveryExporter.refresh(tenantId, tenantViewId)` returning `{changed, unchanged, withdrawn}` counts and `DiscoveryExportCoordinator.requestRefresh()` for deterministic coalescing.

- [ ] **Step 1: Write failing export/redaction tests**

Provision two Endpoints with the same capability and many heartbeats. Assert one aggregate `capability_route` record, no Runtime fields, no tenant ID, safe binding types/security schemes only, and no new revision when only session/heartbeat metadata changes. Assert policy removal emits a higher-revision tombstone.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/endpoint-exporter.test.ts`

Expected: FAIL with missing exporter.

- [ ] **Step 3: Implement deterministic aggregation**

Page through the local directory with a configured maximum Endpoint count. Group by capability ID/version/media/interaction modes/safe binding types, sort every set, remove `constraints` unless policy explicitly returns a safe replacement, and derive stable `record_id = capability-route:<sha256-of-public-key>`.

Only the externally visible payload digest advances the record revision. Use configured `record_ttl_seconds` between 1 and 300 and never include individual availability beyond `available | constrained | unavailable`. `DiscoveryExportCoordinator` accepts an injected scheduler/clock; all requests within `coalescing_window_ms` produce one refresh at the end of the window, and a request arriving during a refresh schedules at most one follow-up refresh.

- [ ] **Step 4: Run focused Endpoint and export tests**

Run: `npx vitest run packages/discovery-runtime/test/endpoint-exporter.test.ts packages/discovery-runtime/test/export-coordinator.test.ts packages/endpoint-directory/test packages/adapter-endpoint-memory/test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the exporter**

```bash
git add packages/discovery-runtime
git commit -m "feat(discovery): derive stable capability routes"
```

### Task 6: Caller-scoped query and authoritative detail service

**Files:**
- Create: `packages/discovery-runtime/src/query-service.ts`
- Create: `packages/discovery-runtime/test/query-service.test.ts`
- Modify: `packages/discovery-runtime/src/index.ts`

**Interfaces:**
- Consumes: `DiscoveryStore`, existing `EndpointDirectoryService`, `DiscoveryDisclosurePolicy`, fakeable clock.
- Produces: `DiscoveryQueryService.findCapabilities`, `getExchange`, `getParticipant`, `getEndpoint`.

- [ ] **Step 1: Write failing authorization and non-disclosure tests**

Test two callers against the same records. Allowed caller receives sorted local and fresh remote records with origin/revision/freshness. Denied caller receives the same `not_found` result for a hidden Endpoint and a nonexistent Endpoint. Expired records never appear. Results contain no score or preferred target.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/query-service.test.ts`

Expected: FAIL with missing query service.

- [ ] **Step 3: Implement narrow call context and query limits**

```ts
export interface DiscoveryCallContext {
  readonly tenant_id: string;
  readonly tenant_view_id: string;
  readonly principal_id: string;
  readonly represented_actor?: EndpointActorRef;
  readonly represented_endpoint_id?: string;
}

export interface DiscoveryFindCapabilitiesInput {
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly input_media_types?: readonly string[];
  readonly output_media_types?: readonly string[];
  readonly interaction_modes?: readonly string[];
  readonly binding_types?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}
```

Evaluate disclosure per returned record at read time. Do not expose policy reason, hidden count, Peer topology, or remote tenant identifiers.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run packages/discovery-runtime/test/query-service.test.ts && npm run typecheck`

```bash
git add packages/discovery-runtime
git commit -m "feat(discovery): add caller-scoped discovery queries"
```

### Task 7: Signed direct-peer sync protocol

**Files:**
- Create: `packages/discovery-runtime/src/message-codec.ts`
- Create: `packages/discovery-runtime/src/gateway.ts`
- Create: `packages/discovery-runtime/test/message-codec.test.ts`
- Create: `packages/discovery-runtime/test/gateway-sync.integration.test.ts`
- Modify: `packages/discovery-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 1 peer/message ports, Task 2 crypto, Task 3 stores, Task 4 cache.
- Produces: `DiscoveryMessageCodec`, `DiscoveryGateway.prepareSync`, `receiveSync`, `deliverSync`.

- [ ] **Step 1: Write failing peer-envelope tests**

Test canonical `sync_request` and `sync_response`, exact audience, request correlation, request digest, deadline, TTL, maximum bytes, stable retry bytes, and rejection of unknown members or mismatched Peer binding.

- [ ] **Step 2: Write failing two-peer sync test**

Exchange A has two changes; B requests with no cursor, applies both, repeats the exact request, then requests with the returned opaque cursor and receives no changes. A policy-revoked record syncs as a tombstone. No call mutates Endpoint Directory or Handoff stores.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/message-codec.test.ts packages/discovery-runtime/test/gateway-sync.integration.test.ts`

Expected: FAIL because codec/gateway are missing.

- [ ] **Step 4: Implement message codec and direct sync**

```ts
export class DiscoveryGateway {
  prepareSync(input: { readonly peer_id: string; readonly cursor?: string; readonly etag?: string }): Promise<PreparedDiscoveryRequest>;
  receiveSync(request: Uint8Array): Promise<Uint8Array>;
  deliverSync(prepared: PreparedDiscoveryRequest, transport: DiscoveryPeerTransport): Promise<DiscoverySyncResult>;
}
```

Generate peer-specific pages only after export policy. Retryable transport failure returns without mutating cursors. The caller retries the identical prepared request bytes. Same message ID/different digest fails closed.

- [ ] **Step 5: Run sync tests and commit**

Run: `npx vitest run packages/discovery-runtime/test/message-codec.test.ts packages/discovery-runtime/test/gateway-sync.integration.test.ts && npm run typecheck`

```bash
git add packages/discovery-runtime
git commit -m "feat(discovery): add signed conditional peer sync"
```

### Task 8: Bounded on-demand and transitive queries

**Files:**
- Modify: `packages/discovery-runtime/src/gateway.ts`
- Create: `packages/discovery-runtime/src/query-budget.ts`
- Create: `packages/discovery-runtime/test/gateway-query.integration.test.ts`
- Create: `packages/discovery-runtime/test/storm-control.test.ts`

**Interfaces:**
- Consumes: Task 7 message codec/gateway.
- Produces: `prepareQuery`, `receiveQuery`, `deliverQuery`, `DiscoveryQueryDeduplicator`, `consumeQueryBudget`.

- [ ] **Step 1: Write failing cycle and budget tests**

Create A -> B -> C -> A transports. One query uses `remaining_hops: 2`, `remaining_fanout: 3`, `remaining_results: 5`, `remaining_bytes: 32_768`. Assert each Exchange processes the query ID once, A is never revisited, all returned budgets decrease, and the result is marked `partial` when any path is not queried.

Test duplicate concurrent queries single-flight, negative cache, deadline expiry, queue saturation, and response byte truncation at a complete record boundary.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/gateway-query.integration.test.ts packages/discovery-runtime/test/storm-control.test.ts`

Expected: FAIL for missing query methods.

- [ ] **Step 3: Implement monotonic budget consumption**

No relay may increase a budget. Deduplicate by `source_exchange_id + query_id` through the full request expiry. Reject a visited path containing the local Exchange. Default `transitive=false`; forwarding requires origin query permission, Peer binding transit permission, remaining hop > 0, remaining fan-out > 0, deadline remaining, and queue capacity.

- [ ] **Step 4: Implement cache/single-flight/backoff primitives**

Use injected clock/random/scheduler. Negative cache keys are canonical query fingerprints and live no longer than 60 seconds. Poll backoff uses configured min/max and deterministic jitter bounds; tests inspect computed deadlines and never sleep.

- [ ] **Step 5: Verify storm termination and commit**

Run: `npx vitest run packages/discovery-runtime/test/gateway-query.integration.test.ts packages/discovery-runtime/test/storm-control.test.ts && npm run typecheck`

```bash
git add packages/discovery-runtime
git commit -m "feat(discovery): bound federated query propagation"
```

### Task 9: SQLite restart-safe discovery adapter

**Files:**
- Create: `packages/adapter-storage-sqlite/src/sqlite-discovery-store.ts`
- Create: `packages/adapter-storage-sqlite/test/sqlite-discovery-store.test.ts`
- Modify: `packages/adapter-storage-sqlite/src/index.ts`
- Modify: `packages/adapter-storage-sqlite/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 3 Memory stores and conformance profile.
- Produces: `createSqliteDiscoveryStore`, `createSqliteDiscoveryPeerBindingStore`.

- [ ] **Step 1: Write failing restart and tenant-guard tests**

Use `SqliteSession` and the existing `work_fabric_local_store_operations` log. Apply live record, tombstone, Peer CAS update, close/reopen, then run the full Discovery profiles. Cross-tenant or cross-view input rejects before an operation is persisted.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/adapter-storage-sqlite/test/sqlite-discovery-store.test.ts`

Expected: FAIL because factories are missing.

- [ ] **Step 3: Implement durable delegates**

Use separate `store_kind` values `discovery-records:<tenant_view_id>` and `discovery-peers:<tenant_view_id>`. Mutation sets are `apply/prune` and `put`; guards bind all operations to the configured local tenant and view. The proxy manifest must report `local_file_durability=true`, `single_process_writer=true`, `clustered_claims=false`.

- [ ] **Step 4: Run profiles twice across restart and commit**

Run: `npx vitest run packages/adapter-storage-sqlite/test/sqlite-discovery-store.test.ts packages/adapter-storage-sqlite/test/migrations.test.ts && npm run typecheck`

```bash
git add packages/adapter-storage-sqlite package-lock.json
git commit -m "feat(discovery): persist local discovery state in sqlite"
```

### Task 10: PostgreSQL/RLS discovery adapter

**Files:**
- Create: `packages/adapter-storage-postgres/migrations/010_discovery.sql`
- Create: `packages/adapter-storage-postgres/src/postgres-discovery-store.ts`
- Create: `packages/adapter-storage-postgres/test/postgres-discovery-store.test.ts`
- Modify: `packages/adapter-storage-postgres/src/index.ts`
- Modify: `packages/adapter-storage-postgres/package.json`
- Modify: `tools/postgres-migrate.ts`
- Modify: `tools/postgres-migrate.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 ports and Task 3 conformance.
- Produces: `DISCOVERY_MIGRATION`, `PostgresDiscoveryStore`, `PostgresDiscoveryPeerBindingStore`.

- [ ] **Step 1: Write failing migration/store tests**

Assert tables for records, changes, peers, and retained tombstones; primary keys include local tenant, tenant view, and origin; RLS is enabled and forced; policies compare `tenant_id` to `work_fabric_current_tenant()`; cursor queries have indexes. Use fake Postgres clients for exact CAS/conflict behavior and run live conformance when `WORK_FABRIC_TEST_POSTGRES_URL` is set.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/adapter-storage-postgres/test/postgres-discovery-store.test.ts tools/postgres-migrate.test.ts`

Expected: FAIL for missing migration/store.

- [ ] **Step 3: Implement atomic revision/CAS SQL**

Bind each store instance to one tenant view. Use transaction-scoped tenant sessions, `SELECT ... FOR UPDATE`, monotonic revision checks, same-revision digest conflict, tombstone retention, deterministic ordered pagination, and versioned Peer binding CAS. JSONB stores closed public records only.

- [ ] **Step 4: Run adapter and migration suites**

Run: `npx vitest run packages/adapter-storage-postgres/test/postgres-discovery-store.test.ts packages/adapter-postgres-common/test/migrations.test.ts tools/postgres-migrate.test.ts && npm run typecheck`

Expected: PASS without a live database; live profile is conditional like existing PostgreSQL tests.

- [ ] **Step 5: Commit PostgreSQL support**

```bash
git add packages/adapter-storage-postgres tools package-lock.json
git commit -m "feat(discovery): add postgres discovery persistence"
```

### Task 11: Authenticated HTTP participant and peer bindings

**Files:**
- Create: `packages/transport-http/src/routes/discovery-routes.ts`
- Create: `packages/transport-http/test/discovery-routes.test.ts`
- Modify: `packages/transport-http/src/internal/create-server.ts`
- Modify: `packages/transport-http/src/index.ts`
- Modify: `packages/transport-http/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 6 `DiscoveryQueryService`, Task 7/8 optional `DiscoveryGateway`, existing `authorizeRoute`.
- Produces: participant `/v1/discovery/*`, peer `/.well-known/work-fabric` and `/v1/discovery/peer/*` routes.

- [ ] **Step 1: Write failing route/auth tests**

Verify participant routes call `workfabric.discovery.query.v1` or `.resolve.v1`, propagate frozen Principal/Actor/Endpoint context, parse repeated bounded filters, return 404 identically for hidden/missing detail, 400 for invalid query, 413 for peer bytes over 65,536, 429 for budget/rate denial, and 503 for unavailable stores. Verify Peer routes accept `application/workfabric-discovery+json` bytes and do not parse them as generic JSON.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/transport-http/test/discovery-routes.test.ts`

Expected: FAIL because routes are unregistered.

- [ ] **Step 3: Implement narrow dependency wiring**

Add optional dependencies:

```ts
readonly discovery?: DiscoveryQueryService;
readonly discovery_gateway?: DiscoveryGateway;
readonly discovery_manifest?: () => Promise<Uint8Array>;
```

Register participant routes only when Identity, Authority, and query service exist. Register Peer routes only when the gateway exists. Never expose internal Peer list/topology through participant errors.

- [ ] **Step 4: Run HTTP dependency boundaries and commit**

Run: `npx vitest run packages/transport-http/test/discovery-routes.test.ts packages/transport-http/test/dependency-boundaries.test.ts && npm run typecheck`

```bash
git add packages/transport-http package-lock.json
git commit -m "feat(discovery): expose authorized discovery HTTP binding"
```

### Task 12: Public TypeScript SDK discovery client

**Files:**
- Create: `packages/sdk-typescript/src/discovery-client.ts`
- Create: `packages/sdk-typescript/test/discovery-client.test.ts`
- Modify: `packages/sdk-typescript/src/client.ts`
- Modify: `packages/sdk-typescript/src/index.ts`
- Modify: `packages/sdk-typescript/src/protocol-types.ts`
- Modify: `packages/sdk-typescript/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 11 participant HTTP JSON contract.
- Produces: immutable `client.discovery` with `getExchange`, `findCapabilities`, `getParticipant`, `getEndpoint`, `query`.

- [ ] **Step 1: Write failing SDK mapping tests**

Capture URLs, repeated media/channel query keys, headers, representation override, and POST query body. Reject invalid identifiers, empty arrays, limit over the server bound, budget outside bounds, and malformed results before returning. Assert GETs use bounded query retry, POST query uses no automatic retry, and no method ranks or invokes a result.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run packages/sdk-typescript/test/discovery-client.test.ts`

Expected: FAIL because `client.discovery` does not exist.

- [ ] **Step 3: Implement the immutable SDK client**

```ts
export class DiscoveryClient {
  getExchange(exchangeId: string, options?: RequestOptions): Promise<DiscoveryResult>;
  findCapabilities(input?: DiscoveryFindCapabilitiesInput, options?: RequestOptions): Promise<DiscoveryPage>;
  getParticipant(actorId: string, options?: RequestOptions): Promise<DiscoveryResult>;
  getEndpoint(endpointId: string, options?: RequestOptions): Promise<DiscoveryResult>;
  query(input: DiscoveryFederatedQueryInput, options?: RequestOptions): Promise<DiscoveryPage>;
}
```

Structural decode validates required discriminants, arrays, coverage, origin, revision, and timestamps. It does not cryptographically verify server-returned records; the authenticated local Exchange owns that verification.

- [ ] **Step 4: Run SDK suite and commit**

Run: `npx vitest run packages/sdk-typescript/test/discovery-client.test.ts packages/sdk-typescript/test/endpoint-client.test.ts && npm run typecheck`

```bash
git add packages/sdk-typescript package-lock.json
git commit -m "feat(discovery): add generic agent discovery SDK"
```

### Task 13: Service composition and explicit configuration

**Files:**
- Modify: `packages/service-node/src/config.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/package.json`
- Modify: `packages/service-node/test/config.test.ts`
- Create: `packages/service-node/test/discovery-composition.integration.test.ts`
- Modify: `examples/config/README.md`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Tasks 3/5/6/9/10/11.
- Produces: optional local Discovery query composition for `memory-demo`, `sqlite-local`, and injected PostgreSQL; optional deployment-owned peer gateway injection.

- [ ] **Step 1: Write failing strict-config tests**

Add optional closed `discovery` object:

```ts
interface NodeDiscoveryConfig {
  readonly enabled: boolean;
  readonly tenant_view_id: string;
  readonly record_ttl_seconds: number;       // 1..300
  readonly default_page_limit: number;       // 1..100
  readonly max_page_limit: number;           // default..1000
  readonly max_records_per_origin: number;   // 1..100000
  readonly sync_page_size: number;            // 1..1000
  readonly query_max_hops: number;            // 0..8
  readonly query_max_fanout: number;          // 0..32
  readonly query_max_bytes: number;           // 1024..65536
}
```

Unknown fields, unsafe IDs, inconsistent limits, and discovery on `worker`-only role fail. No private key or Peer credential appears in service YAML.

- [ ] **Step 2: Run config tests and verify failure**

Run: `npx vitest run packages/service-node/test/config.test.ts packages/service-node/test/discovery-composition.integration.test.ts`

Expected: FAIL for unrecognized/missing discovery composition.

- [ ] **Step 3: Extend storage composition without coupling Core**

Add `discoveryRecords` and `discoveryPeers` to `NodeStorageComposition`. Memory and SQLite create their adapters. PostgreSQL requires injected conforming stores. Compose exporter/query service only for API/all. Accept optional `discovery_gateway` in `NodeServiceCompositionOptions`; do not create network trust or crypto from YAML.

- [ ] **Step 4: Prove optional failure isolation**

Tests must show disabled Discovery leaves existing service shape unchanged; Discovery store failure returns 503 on discovery routes but local Handoff and Endpoint routes still work; worker-only composition never loads Discovery HTTP dependencies.

- [ ] **Step 5: Run composition tests and commit**

Run: `npx vitest run packages/service-node/test/config.test.ts packages/service-node/test/discovery-composition.integration.test.ts packages/service-node/test/memory-composition.integration.test.ts packages/service-node/test/sqlite-restart.integration.test.ts && npm run typecheck`

```bash
git add packages/service-node examples/config package-lock.json
git commit -m "feat(discovery): compose optional node discovery service"
```

### Task 14: Bounded operations, audit, and health views

**Files:**
- Create: `packages/discovery-runtime/src/operations.ts`
- Create: `packages/discovery-runtime/test/operations.test.ts`
- Modify: `packages/discovery-runtime/src/index.ts`
- Modify: `packages/operations-spi/src/semantic-observer.ts`
- Modify: `packages/operations-spi/test/semantic-observer.test.ts`
- Modify: `packages/transport-http/src/routes/operations-routes.ts`
- Modify: `packages/transport-http/test/operations-routes.test.ts`

**Interfaces:**
- Consumes: Discovery Store/Peer Store status, gateway counters, existing semantic observer/audit route patterns.
- Produces: `DiscoveryOperationsService.snapshot(context)`, `/v1/operations/discovery`, fixed discovery operation/reason telemetry values.

- [ ] **Step 1: Write failing bounded snapshot tests**

Assert fresh/expired/withdrawn/conflicting counts, cache utilization, last successful sync age, coalesced updates, prevented forwards, and Peer health summaries are bounded by configured page limits. Raw record payloads, signatures, URLs, Exchange/Peer/Actor/Endpoint/Capability/tenant IDs, query filters, and credentials never appear in the aggregate snapshot.

- [ ] **Step 2: Write failing low-cardinality telemetry tests**

Allow only fixed operations `discovery_query`, `discovery_sync`, `discovery_export`, `discovery_prune` and fixed reasons `accepted`, `denied`, `expired`, `invalid_signature`, `conflict`, `budget_exhausted`, `rate_limited`, `unavailable`. Verify arbitrary values are dropped by `observeSemanticSafely` and detailed identifiers stay only in an injected retention-bounded audit sink.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run packages/discovery-runtime/test/operations.test.ts packages/operations-spi/test/semantic-observer.test.ts packages/transport-http/test/operations-routes.test.ts`

Expected: FAIL because Discovery operations are absent.

- [ ] **Step 4: Implement snapshot and optional operations route**

Use immutable aggregate records and existing operations Authority. Store/gateway failure returns an unhealthy dependency summary rather than record contents. Peer management and forced sync remain separate, expected-version/idempotency-protected administrative commands and are not added as direct mutable query routes.

- [ ] **Step 5: Run operations and sensitive-observability checks**

Run: `npx vitest run packages/discovery-runtime/test/operations.test.ts packages/operations-spi/test/semantic-observer.test.ts packages/transport-http/test/operations-routes.test.ts && npm run check:sensitive-observability && npm run typecheck`

- [ ] **Step 6: Commit operational visibility**

```bash
git add packages/discovery-runtime packages/operations-spi packages/transport-http
git commit -m "feat(discovery): add bounded operational visibility"
```

### Task 15: End-to-end generic Agent discovery and Handoff proof

**Files:**
- Create: `packages/discovery-runtime/test/discovery-agent.e2e.test.ts`
- Create: `packages/discovery-runtime/test/discovery-federation-boundary.e2e.test.ts`
- Modify: `packages/discovery-runtime/package.json`

**Interfaces:**
- Consumes: all previous public APIs plus existing Federation/Handoff test harnesses.
- Produces: executable proof of the user-visible outcome and responsibility boundary.

- [ ] **Step 1: Write the failing two-Exchange user-flow test**

Build independent Exchange A/B Endpoint stores, Discovery stores/codecs/gateways, real HTTP services, and TypeScript clients. Provision/open an Agent Endpoint on A; sync the aggregate capability route to B; query from a generic Agent on B; resolve authorized Endpoint detail; select A externally; then use the existing Federation Gateway/Bridge to create a target Handoff and explicitly accept it.

Assertions:

```ts
expect(page.items[0]?.record_kind).toBe("capability_route");
expect(page.items[0]?.payload).not.toHaveProperty("heartbeat_sequence");
expect(targetHandoff.lifecycle_state).toBe("offered");
await targetClient.handoffs.accept(...);
expect((await targetClient.queries.getHandoff(id)).lifecycle_state).toBe("accepted");
```

- [ ] **Step 2: Run and verify the unimplemented flow fails**

Run: `npx vitest run packages/discovery-runtime/test/discovery-agent.e2e.test.ts`

Expected: FAIL until all public wiring is correct.

- [ ] **Step 3: Add only missing test-harness adapters, never production shortcuts**

The Bridge must call the target Exchange public SDK/API idempotently. Discovery results cannot write Handoff state. Delivery Ack and Handoff Accept remain separate explicit facts.

- [ ] **Step 4: Add the no-Discovery regression proof**

Disable both Discovery Gateways and explicitly address the target Exchange/Endpoint. Existing Federation and local Handoff flow must still pass unchanged.

- [ ] **Step 5: Run E2E and commit**

Run: `npx vitest run packages/discovery-runtime/test/discovery-agent.e2e.test.ts packages/discovery-runtime/test/discovery-federation-boundary.e2e.test.ts packages/federation-runtime/test/federation-exchange.e2e.test.ts && npm run typecheck`

```bash
git add packages/discovery-runtime
git commit -m "test(discovery): prove generic agent federation flow"
```

### Task 16: Boundary gates, storm verification, documentation, and full release check

**Files:**
- Create: `tools/check-discovery-boundaries.ts`
- Create: `tools/check-discovery-boundaries.test.ts`
- Create: `tools/benchmark-discovery.ts`
- Create: `tools/benchmark-discovery.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Create: `docs/participation-discovery.md`
- Create: `docs/performance-discovery-baseline.md` generated from the reproducible benchmark

**Interfaces:**
- Consumes: complete implementation.
- Produces: `check:discovery-boundaries`, `benchmark:discovery`, operational documentation, release evidence.

- [ ] **Step 1: Write failing static boundary tests**

Scan production imports and schema/property names. Fail if Exchange Core, Federation Runtime, Cluster Runtime, or protocol schemas import Discovery; if Discovery Runtime imports Fastify, database, NATS, Agent/model/tool packages; if `fencing_token`, `heartbeat_sequence`, `session_id`, `tenant_id`, credential/token/private key fields appear in cross-Exchange record/message schemas; or if SDK contains `rank`, `score`, `recommend`, `selectTarget`, or automatic invocation APIs.

- [ ] **Step 2: Run and verify the gate detects planted in-memory violations**

Run: `npx vitest run tools/check-discovery-boundaries.test.ts`

Expected: PASS only after fixtures prove every rule both rejects and accepts the intended paths.

- [ ] **Step 3: Add the deterministic storm benchmark**

The benchmark reports:

- 10,000 local heartbeats with unchanged public digest -> 0 peer updates;
- 1,000 rapid public state changes inside coalescing windows -> bounded final updates;
- cached local query p50/p95;
- direct two-Peer delta sync p50/p95 and bytes;
- three-Exchange cycle -> each query processed at most once per Exchange;
- expired/withdrawn pruning time and bounded retained size.

Use generated in-memory data, a fake clock, fixed seed/random, and no external services. The test checks invariants, not environment-sensitive latency thresholds.

- [ ] **Step 4: Document deployment and boundaries**

Document join, publish/read/export/transit/invoke decisions, API/SDK examples, direct Peer bootstrap, key rotation, TTL/cursor recovery, partial coverage, no-broadcast topology, Memory/SQLite/PostgreSQL profiles, operational limits, failure handling, and explicit non-goals. Update the architecture diagram so Discovery sits between Endpoint Directory and external Resolver, beside rather than inside Federation.

- [ ] **Step 5: Run focused release verification**

Run:

```bash
npm run typecheck
npm run check:discovery-boundaries
npx vitest run packages/discovery-spi/test packages/discovery-runtime/test packages/adapter-discovery-memory/test packages/adapter-discovery-node-crypto/test packages/adapter-storage-sqlite/test/sqlite-discovery-store.test.ts packages/adapter-storage-postgres/test/postgres-discovery-store.test.ts packages/transport-http/test/discovery-routes.test.ts packages/sdk-typescript/test/discovery-client.test.ts packages/service-node/test/discovery-composition.integration.test.ts tools/check-discovery-boundaries.test.ts tools/benchmark-discovery.test.ts
npm run conformance
```

Expected: all pass.

- [ ] **Step 6: Run the repository-wide verification**

Run: `npm run verify`

Expected: all pass. If the known port `127.0.0.1:8787` is still occupied, record the external PID, run every non-conflicting test plus the isolated failing test after the port is released, and do not claim a clean full verify until it passes.

- [ ] **Step 7: Review the final diff against the design**

Confirm every design acceptance criterion has a named passing test; inspect package dependencies; search for secrets/sensitive fields; confirm no unrelated user file changed; and verify `git diff --check` is clean.

- [ ] **Step 8: Commit release evidence and documentation**

```bash
git add package.json README.md docs tools
git commit -m "docs: complete participation discovery profile"
```
