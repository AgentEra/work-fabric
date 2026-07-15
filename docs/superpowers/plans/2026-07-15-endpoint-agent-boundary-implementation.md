# Endpoint and Local Agent Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 4A connection boundary in which an administrator provisions an Endpoint, an external Agent Runtime maintains a fenced lease, an external Resolver discovers unranked capability facts, and the Runtime receives durable Handoff notifications through a bounded SDK-based Gateway without Work Fabric executing or scheduling the work.

**Architecture:** Add transport-neutral Endpoint Directory and inbox ports below focused domain services, with Memory and PostgreSQL adapters sharing conformance profiles. Bind those services through the existing authenticated HTTP server and TypeScript SDK, then build `@work-fabric/agent-gateway` strictly as a connection/session multiplexer over public SDK operations.

**Tech Stack:** Node.js >=22.20.0, TypeScript 7, JSON Schema 2020-12, Ajv, Vitest, Fastify, PostgreSQL, Server-Sent Events, npm workspaces.

## Global Constraints

- Work Fabric owns connection, identity-bound Endpoint facts, leases, routing facts, protocol delivery, acknowledgement, and auditability; it does not own Agent reasoning, execution, target selection, or automatic responsibility acceptance.
- All public writes are tenant-scoped, authority-checked, bounded, and replay-safe only through their explicit idempotency or sequence fields.
- Discovery returns deterministically paged facts and never score, rank, recommendation, load prediction, or selected target.
- There is one active fenced Runtime session per Endpoint; expiry is enforced by clock comparison on every relevant read.
- Endpoint inbox data contains routing facts only; Context, prompts, result bodies, credentials, and execution state are not copied.
- Signal acknowledgement and Handoff acceptance remain separate explicit SDK calls.
- Node.js and TypeScript are the reference implementation; public ports do not couple to HTTP, PostgreSQL, or a local IPC technology.
- All lists, page sizes, capability counts, Binding counts, active streams, queues, retries, and lease durations have positive configured bounds.
- Phase 4A does not implement Feishu, a Console, an Agent brain, a scheduler, automatic failover, Codex invocation, Local IPC, A2A/MCP, or production deployment composition.

---

## File map

- `protocol/schemas/v1/endpoint/*`: canonical Endpoint registration, session, discovery, and inbox representations.
- `packages/exchange-spi/src/endpoint-directory.ts`: persistence-neutral Directory/session contracts.
- `packages/exchange-spi/src/endpoint-inbox.ts`: rebuildable inbox routing contracts.
- `packages/endpoint-directory/src/*`: validation, session lifecycle, discovery, and target eligibility.
- `packages/adapter-endpoint-memory/src/*`: executable reference Directory and inbox stores.
- `packages/adapter-storage-postgres/src/postgres-endpoint-*.ts`: durable implementations with RLS and indexes.
- `packages/exchange-conformance/src/endpoint-*-profile.ts`: reusable adapter behavioral profiles.
- `packages/exchange-runtime/src/projection/endpoint-inbox-projector.ts`: committed Handoff Event to routing-fact projection.
- `packages/transport-http/src/routes/endpoint-routes.ts`: authenticated Endpoint HTTP binding.
- `packages/sdk-typescript/src/endpoint-client.ts`: public `client.endpoints` logical client.
- `packages/agent-gateway/src/*`: external Runtime lease and multi-partition Delivery connection mechanics.

### Task 1: Canonical Endpoint schemas and stable SPI

**Files:**
- Create: `protocol/schemas/v1/endpoint/endpoint-registration.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-session-open.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-session.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-heartbeat.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-session-close.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-discovery-page.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-inbox-partition-page.schema.json`
- Modify: `protocol/README.md`
- Create: `packages/exchange-spi/src/endpoint-directory.ts`
- Create: `packages/exchange-spi/src/endpoint-inbox.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Test: `tools/conformance/test/endpoint-boundary-schemas.test.ts`
- Test: `packages/exchange-spi/test/endpoint-ports.test.ts`

**Interfaces:**
- Consumes: existing `CapabilityManifest`, `ExchangeAdapter`, `UtcTimestamp`, and `JsonObject` types plus the canonical JSON Schema vocabulary.
- Produces: TypeScript `EndpointActorRef`, `EndpointDescriptor`, `CapabilityDescriptor`, and `BindingDescriptor` projections; `EndpointDirectoryStore`, `EndpointInboxStore`, `EndpointRegistration`, `EndpointSession`, `EndpointDiscoveryQuery`, `EndpointInboxPartition`, `CapabilityConstraintEvaluator`; and the eight authority action constants used by later tasks.

- [ ] **Step 1: Write schema tests that prove bounds and secret rejection**

```ts
it("accepts a bounded provisioned Endpoint and rejects credential material", () => {
  expect(validate("endpoint-registration", registration)).toEqual([]);
  expect(validate("endpoint-registration", {
    ...registration,
    extensions: { client_secret: "must-not-enter-the-contract" },
  })).toContainEqual(expect.objectContaining({ keyword: "propertyNames" }));
});

it.each([
  ["endpoint-session-open", openSession],
  ["endpoint-heartbeat", heartbeat],
  ["endpoint-session-close", closeSession],
  ["endpoint-discovery-page", discoveryPage],
  ["endpoint-inbox-partition-page", inboxPage],
])("validates %s", (schema, value) => {
  expect(validate(schema, value)).toEqual([]);
});
```

- [ ] **Step 2: Run the schema tests and confirm missing schemas fail**

Run: `npm test -- tools/conformance/test/endpoint-boundary-schemas.test.ts`

Expected: FAIL because the Endpoint boundary schemas are not registered.

- [ ] **Step 3: Add closed JSON Schemas with explicit limits**

Use `additionalProperties: false`, existing `$defs` references, `minLength: 1`, `maxLength: 255` for opaque IDs, `maxItems: 64` for capabilities, `maxItems: 16` for Bindings, and this secret-name guard on extension keys:

```json
{
  "type": "object",
  "maxProperties": 32,
  "propertyNames": {
    "not": {
      "pattern": "(?:[sS][eE][cC][rR][eE][tT]|[pP][aA][sS][sS][wW][oO][rR][dD]|[tT][oO][kK][eE][nN]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL])"
    }
  },
  "additionalProperties": true
}
```

Define session states as `active | closed | fenced`, availability as `available | busy | draining | unavailable`, positive integer `registration_version`, `fencing_token`, and `heartbeat_sequence`, and RFC 3339 `expires_at` / `renew_after` values. Discovery and inbox pages must require `items` and allow only an opaque optional `next_cursor`.

- [ ] **Step 4: Add compile-time SPI contract tests**

```ts
const store: EndpointDirectoryStore = candidateStore;
expect(store.manifest.profile).toBe("exchange.endpoint-directory.v1");
expect(ENDPOINT_AUTHORITY_ACTIONS).toEqual([
  "workfabric.endpoint.provision.v1",
  "workfabric.endpoint.disable.v1",
  "workfabric.endpoint.session.open.v1",
  "workfabric.endpoint.session.heartbeat.v1",
  "workfabric.endpoint.session.close.v1",
  "workfabric.endpoint.read.v1",
  "workfabric.endpoint.discover.v1",
  "workfabric.endpoint.inbox.read.v1",
]);
```

- [ ] **Step 5: Implement the transport-neutral ports**

```ts
export interface EndpointDirectoryStore extends ExchangeAdapter {
  putRegistration(input: PutEndpointRegistration): Promise<EndpointRegistration>;
  getRegistration(tenantId: string, endpointId: string): Promise<EndpointRegistration | null>;
  openSession(input: OpenEndpointSession): Promise<EndpointSession>;
  heartbeat(input: HeartbeatEndpointSession): Promise<EndpointSession>;
  closeSession(input: CloseEndpointSession): Promise<EndpointSession>;
  getProjectedEndpoint(tenantId: string, endpointId: string, now: UtcTimestamp): Promise<EndpointDescriptor | null>;
  discover(input: EndpointDiscoveryQuery): Promise<EndpointDiscoveryPage>;
  listActorEndpoints(tenantId: string, actorId: string, now: UtcTimestamp): Promise<readonly EndpointDescriptor[]>;
}

export interface EndpointInboxStore extends ExchangeAdapter {
  upsertRoutingFact(fact: EndpointInboxRoutingFact): Promise<void>;
  listPartitions(input: EndpointInboxPartitionQuery): Promise<EndpointInboxPartitionPage>;
  clearTenantProjection(tenantId: string): Promise<void>;
}

export interface CapabilityConstraintEvaluator extends ExchangeAdapter {
  evaluate(input: CapabilityConstraintEvaluation): Promise<"match" | "mismatch" | "unavailable">;
}
```

Every stored and returned type is readonly, tenant-scoped, and contains no concrete database or transport type.

- [ ] **Step 6: Run focused and full type/schema verification**

Run: `npm test -- tools/conformance/test/endpoint-boundary-schemas.test.ts packages/exchange-spi/test/endpoint-ports.test.ts && npm run typecheck`

Expected: all focused tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the contract increment**

```bash
git add protocol packages/exchange-spi tools/conformance/test/endpoint-boundary-schemas.test.ts
git commit -m "feat: define Endpoint boundary contracts"
```

### Task 2: Directory service and Memory reference adapter

**Files:**
- Create: `packages/endpoint-directory/package.json`
- Create: `packages/endpoint-directory/src/errors.ts`
- Create: `packages/endpoint-directory/src/validation.ts`
- Create: `packages/endpoint-directory/src/endpoint-directory-service.ts`
- Create: `packages/endpoint-directory/src/index.ts`
- Create: `packages/adapter-endpoint-memory/package.json`
- Create: `packages/adapter-endpoint-memory/src/memory-endpoint-directory-store.ts`
- Create: `packages/adapter-endpoint-memory/src/memory-endpoint-inbox-store.ts`
- Create: `packages/adapter-endpoint-memory/src/index.ts`
- Create: `packages/exchange-conformance/src/endpoint-directory-profile.ts`
- Create: `packages/exchange-conformance/src/endpoint-inbox-profile.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Test: `packages/endpoint-directory/test/endpoint-directory-service.test.ts`
- Test: `packages/adapter-endpoint-memory/test/memory-endpoint-stores.test.ts`

**Interfaces:**
- Consumes: Task 1 stores and records.
- Produces: `EndpointDirectoryService`, `MemoryEndpointDirectoryStore`, `MemoryEndpointInboxStore`, `runEndpointDirectoryProfile`, and `runEndpointInboxProfile`.

- [ ] **Step 1: Write service tests with deterministic clock and IDs**

```ts
it("replays an identical open and rejects semantic key reuse", async () => {
  const first = await service.openSession(context, openRequest);
  const replay = await service.openSession(context, structuredClone(openRequest));
  expect(replay).toEqual(first);
  await expect(service.openSession(context, {
    ...openRequest,
    availability: "busy",
  })).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("fences the previous session and expires availability by read time", async () => {
  const first = await service.openSession(context, openRequest);
  const second = await service.openSession(context, { ...openRequest, client_session_id: "client-2" });
  expect(second.fencing_token).toBeGreaterThan(first.fencing_token);
  await expect(service.heartbeat(context, first.session_id, heartbeat(first))).rejects.toMatchObject({ code: "session_fenced" });
  clock.advance(60_001);
  await expect(service.getEndpoint(context, endpointId)).resolves.toMatchObject({ availability: "unavailable" });
});
```

- [ ] **Step 2: Run focused tests and confirm the package is missing**

Run: `npm test -- packages/endpoint-directory/test/endpoint-directory-service.test.ts`

Expected: FAIL because `EndpointDirectoryService` does not exist.

- [ ] **Step 3: Implement validation and bounded public errors**

```ts
export class EndpointDirectoryError extends Error {
  constructor(
    readonly code: "not_found" | "version_conflict" | "idempotency_conflict" | "session_fenced" | "stale_sequence" | "invalid_request" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface EndpointDirectoryLimits {
  readonly min_lease_ms: number;
  readonly default_lease_ms: number;
  readonly max_lease_ms: number;
  readonly renew_ahead_ms: number;
  readonly max_capabilities: number;
  readonly max_bindings: number;
  readonly default_page_limit: number;
  readonly max_page_limit: number;
}
```

Validate IDs, semver/version constraints, media types, duplicate capability IDs, requested lease bounds, expected registration version, and forbidden extension keys before invoking the store.

- [ ] **Step 4: Implement Directory orchestration without concrete storage imports**

```ts
export class EndpointDirectoryService {
  constructor(private readonly dependencies: {
    store: EndpointDirectoryStore;
    clock: { now(): UtcTimestamp };
    ids: { sessionId(): string };
    limits: EndpointDirectoryLimits;
  }) {}

  provision(context: EndpointCallContext, input: EndpointRegistrationInput): Promise<EndpointRegistration>;
  disable(context: EndpointCallContext, endpointId: string, expectedVersion: number): Promise<EndpointRegistration>;
  openSession(context: EndpointCallContext, endpointId: string, input: EndpointSessionOpenInput): Promise<EndpointSession>;
  heartbeat(context: EndpointCallContext, endpointId: string, sessionId: string, input: EndpointHeartbeatInput): Promise<EndpointSession>;
  closeSession(context: EndpointCallContext, endpointId: string, sessionId: string, input: EndpointSessionCloseInput): Promise<EndpointSession>;
  getEndpoint(context: EndpointCallContext, endpointId: string): Promise<EndpointDescriptor>;
  discover(context: EndpointCallContext, query: EndpointDiscoveryInput): Promise<EndpointDiscoveryPage>;
}
```

The service computes a canonical SHA-256 digest of open/heartbeat/close semantics, derives expiry and renew times from the injected clock, and delegates the compare-and-swap to the port.

- [ ] **Step 5: Implement Memory stores with atomic clone-on-read behavior**

Use maps keyed by `tenant_id + endpoint_id`; keep immutable session history plus one active-session pointer and monotonically increasing Endpoint-local fencing counter. For every mutation, validate all preconditions against a cloned candidate before replacing map entries. Cursor pages encode the last `(endpoint_id)` or `(partition_id)` key as base64url JSON and reject tenant/query-shape mismatch.

- [ ] **Step 6: Run the reusable profiles against both Memory stores**

```ts
describe("memory Endpoint stores", () => {
  runEndpointDirectoryProfile(() => new MemoryEndpointDirectoryStore());
  runEndpointInboxProfile(() => new MemoryEndpointInboxStore());
});
```

Run: `npm test -- packages/endpoint-directory/test packages/adapter-endpoint-memory/test packages/exchange-conformance/test && npm run typecheck`

Expected: service tests and both profiles PASS.

- [ ] **Step 7: Commit the reference implementation**

```bash
git add packages/endpoint-directory packages/adapter-endpoint-memory packages/exchange-conformance
git commit -m "feat: add Endpoint Directory reference service"
```

### Task 3: PostgreSQL Directory and inbox persistence

**Files:**
- Create: `packages/adapter-storage-postgres/migrations/004_endpoint_boundary.sql`
- Create: `packages/adapter-storage-postgres/src/postgres-endpoint-directory-store.ts`
- Create: `packages/adapter-storage-postgres/src/postgres-endpoint-inbox-store.ts`
- Modify: `packages/adapter-storage-postgres/src/index.ts`
- Test: `packages/adapter-storage-postgres/test/postgres-endpoint-boundary.test.ts`
- Modify: `tools/postgres-smoke.ts`

**Interfaces:**
- Consumes: Task 1 ports and Task 2 conformance profiles.
- Produces: durable `PostgresEndpointDirectoryStore` and `PostgresEndpointInboxStore` with the same observable behavior as Memory.

- [ ] **Step 1: Add failing PostgreSQL profile and RLS tests**

```ts
describe.runIf(postgresAvailable)("PostgreSQL Endpoint boundary", () => {
  runEndpointDirectoryProfile(() => new PostgresEndpointDirectoryStore(pool));
  runEndpointInboxProfile(() => new PostgresEndpointInboxStore(pool));

  it("does not expose another tenant through discovery or cursor reuse", async () => {
    const page = await tenantA.discover({ limit: 1 });
    await expect(tenantB.discover({ limit: 1, cursor: page.next_cursor })).rejects.toThrow("invalid cursor");
  });
});
```

- [ ] **Step 2: Run the PostgreSQL test and confirm missing migration/store failure**

Run: `npm test -- packages/adapter-storage-postgres/test/postgres-endpoint-boundary.test.ts`

Expected: FAIL because PostgreSQL Endpoint stores are not exported.

- [ ] **Step 3: Create tenant-owned tables and indexes**

The migration creates `wf_endpoint_registrations`, `wf_endpoint_sessions`, `wf_endpoint_active_sessions`, and `wf_endpoint_inbox_facts`. Use composite primary/foreign keys containing `tenant_id`, unique `(tenant_id, endpoint_id, client_session_id)`, `CHECK` constraints for positive versions/sequences/tokens, JSONB for bounded canonical descriptors, and indexes for `(tenant_id, actor_id)`, capability lookup, lease expiry, and `(tenant_id, audience_endpoint_id, partition_id)`. Enable and force RLS using the existing `workfabric.tenant_id` session setting pattern.

- [ ] **Step 4: Implement transactional session fencing and replay**

```sql
SELECT fencing_token, session_id
FROM wf_endpoint_active_sessions
WHERE tenant_id = $1 AND endpoint_id = $2
FOR UPDATE;

UPDATE wf_endpoint_sessions
SET state = 'fenced', updated_at = $3
WHERE tenant_id = $1 AND endpoint_id = $2 AND session_id = $4 AND state = 'active';
```

Within the same transaction, compare any existing idempotency digest, increment the fencing token, insert immutable history, and replace the active pointer. Heartbeat and close update only when session ID, fencing token, and expected sequence all match; zero affected rows are re-read and mapped to a bounded conflict reason.

- [ ] **Step 5: Implement keyset pagination and clock-aware reads**

Discovery SQL filters `enabled`, active state, `expires_at > now`, availability, capability ID, version/media requirements that can be evaluated structurally, then orders only by `endpoint_id`. Inbox partitions union actor and endpoint audiences, group by `partition_id`, order by `partition_id`, and never select Context/result payload columns because none exist in the table.

- [ ] **Step 6: Run migration, adapter profiles, and smoke verification**

Run: `npm run postgres:migrate && npm test -- packages/adapter-storage-postgres/test/postgres-endpoint-boundary.test.ts && npm run postgres:smoke && npm run typecheck`

Expected: migration applies idempotently, profiles PASS, RLS checks PASS, smoke output reports Endpoint boundary healthy.

- [ ] **Step 7: Commit durable persistence**

```bash
git add packages/adapter-storage-postgres tools/postgres-smoke.ts
git commit -m "feat: persist Endpoint Directory in PostgreSQL"
```

### Task 4: Directory-backed explicit target eligibility

**Files:**
- Create: `packages/endpoint-directory/src/directory-target-eligibility-verifier.ts`
- Modify: `packages/endpoint-directory/src/index.ts`
- Test: `packages/endpoint-directory/test/directory-target-eligibility-verifier.test.ts`

**Interfaces:**
- Consumes: existing `TargetEligibilityVerifier`, Task 1 `CapabilityConstraintEvaluator`, and Task 2 Directory store.
- Produces: `DirectoryTargetEligibilityVerifier` for injection into the existing target-resolution path.

- [ ] **Step 1: Write the eligibility matrix before implementation**

```ts
it.each([
  ["disabled", "ineligible", "endpoint_disabled"],
  ["expired", "ineligible", "endpoint_unavailable"],
  ["busy", "ineligible", "endpoint_unavailable"],
  ["capability mismatch", "ineligible", "capability_mismatch"],
  ["store failure", "unavailable", "directory_unavailable"],
  ["unknown constraints", "unavailable", "constraint_evaluator_unavailable"],
])("fails closed for %s", async (fixture, kind, reason) => {
  expect(await verifyFixture(fixture)).toEqual({ kind, reason });
});
```

Add positive cases for explicit Endpoint and Actor targets, semver ranges, input/output media inclusion, and a constraint evaluator match. The Actor case must prove it returns only `eligible`, never the matching Endpoint ID.

- [ ] **Step 2: Run the matrix and confirm missing verifier failure**

Run: `npm test -- packages/endpoint-directory/test/directory-target-eligibility-verifier.test.ts`

Expected: FAIL because the verifier is not exported.

- [ ] **Step 3: Implement fail-closed matching**

```ts
export class DirectoryTargetEligibilityVerifier implements TargetEligibilityVerifier {
  readonly manifest = Object.freeze({
    profile: "exchange.target-eligibility.v1",
    adapter: "endpoint-directory",
    capabilities: { explicit_target_only: true, no_candidate_selection: true, fail_closed: true },
  });

  async verify(request: TargetEligibilityRequest): Promise<TargetEligibilityDecision> {
    try {
      const candidates = await this.loadOnlyExplicitTarget(request);
      if (candidates.length === 0) return { kind: "ineligible", reason: "endpoint_unavailable" };
      return this.matchAnyWithoutSelecting(candidates, request.requirement);
    } catch (error) {
      return this.toBoundedUnavailable(error);
    }
  }
}
```

Use a semver parser local to the package with no network dependency. Evaluate all structural requirements before optional constraints. Catch store/evaluator errors and return bounded codes; never return exceptions or candidate facts.

- [ ] **Step 4: Prove no ranking or target mutation exists**

Run: `rg -n "rank|score|recommend|selected_endpoint|load_prediction" packages/endpoint-directory/src/directory-target-eligibility-verifier.ts`

Expected: no matches.

Run: `npm test -- packages/endpoint-directory/test/directory-target-eligibility-verifier.test.ts && npm run typecheck`

Expected: all cases PASS.

- [ ] **Step 5: Commit the verifier**

```bash
git add packages/endpoint-directory
git commit -m "feat: verify explicit targets through Endpoint facts"
```

### Task 5: Rebuildable Endpoint inbox projection

**Files:**
- Create: `packages/exchange-runtime/src/projection/endpoint-inbox-projector.ts`
- Create: `packages/exchange-runtime/src/projection/endpoint-inbox-query-service.ts`
- Modify: `packages/exchange-runtime/src/index.ts`
- Test: `packages/exchange-runtime/test/endpoint-inbox-projector.test.ts`
- Test: `packages/exchange-runtime/test/endpoint-inbox-query-service.test.ts`

**Interfaces:**
- Consumes: committed `EventRecord` audience facts, Handoff protocol events, Task 1 inbox store, and Directory registrations.
- Produces: `EndpointInboxProjector` and authorized `EndpointInboxQueryService`.

- [ ] **Step 1: Write projection and rebuild tests**

```ts
it("projects only Handoff routing facts for every visible Actor and Endpoint", async () => {
  await projector.apply(committedHandoffEvent);
  expect(await store.listPartitions(queryForAgent)).toEqual({
    items: [{ partition_id: "handoff:h-1", latest_position: 7, active_handoff_count: 1 }],
  });
  expect(JSON.stringify(store)).not.toContain("context-bundle");
});

it("deactivates terminal Handoffs and rebuilds deterministically", async () => {
  await projector.rebuild("tenant-a", journal.scan("tenant-a"));
  expect(await store.listPartitions(queryForAgent)).toEqual({ items: [] });
});
```

- [ ] **Step 2: Run tests and confirm missing projection failure**

Run: `npm test -- packages/exchange-runtime/test/endpoint-inbox-projector.test.ts packages/exchange-runtime/test/endpoint-inbox-query-service.test.ts`

Expected: FAIL because projector/query service do not exist.

- [ ] **Step 3: Implement event-to-routing-fact reduction**

```ts
export class EndpointInboxProjector {
  async apply(record: EventRecord): Promise<void> {
    if (!isHandoffLifecycleEvent(record.event_type)) return;
    const fact = {
      tenant_id: record.tenant_id,
      partition_id: record.partition_id,
      handoff_id: record.handoff_id,
      resource_version: record.stream_version,
      lifecycle_state: handoffStateFromEvent(record.event_type, record.protocol_data),
      last_event_id: record.event_id,
      observed_position: record.partition_position,
      visible_actor_ids: [...record.visible_actor_ids],
      visible_endpoint_ids: [...record.visible_endpoint_ids],
      active: !isTerminalHandoffEvent(record.event_type),
    } satisfies EndpointInboxRoutingFact;
    await this.store.upsertRoutingFact(fact);
  }
}
```

Ignore non-Handoff events. Reject resource-version regression. Rebuild clears only the requested tenant projection, scans journal order, and reuses `apply`.

- [ ] **Step 4: Implement bounded audience-authorized queries**

`EndpointInboxQueryService.listPartitions` first loads the provisioned Endpoint in the same tenant, proves the caller can represent its immutable Actor/Endpoint binding, clamps the limit through configuration, then queries the union of matching Actor and Endpoint audience facts. Disabled or unrelated Endpoints return the same not-found result.

- [ ] **Step 5: Run projection, Memory, and PostgreSQL inbox profiles**

Run: `npm test -- packages/exchange-runtime/test packages/adapter-endpoint-memory/test packages/adapter-storage-postgres/test/postgres-endpoint-boundary.test.ts && npm run typecheck`

Expected: projection/rebuild/tenant/page tests PASS for both adapters.

- [ ] **Step 6: Commit inbox routing**

```bash
git add packages/exchange-runtime packages/adapter-endpoint-memory packages/adapter-storage-postgres
git commit -m "feat: project Endpoint inbox routing facts"
```

### Task 6: Authorized Endpoint HTTP surface

**Files:**
- Create: `packages/transport-http/src/routes/endpoint-routes.ts`
- Modify: `packages/transport-http/src/config.ts`
- Modify: `packages/transport-http/src/internal/create-server.ts`
- Modify: `packages/transport-http/src/index.ts`
- Test: `packages/transport-http/test/endpoint-routes.test.ts`
- Test: `packages/transport-http/test/endpoint-route-authorization.test.ts`

**Interfaces:**
- Consumes: Directory and inbox services plus existing Identity, Authority, Problem Details, request ID, JSON validation, and safe logging infrastructure.
- Produces: the seven Endpoint routes from the design with exact action checks.

- [ ] **Step 1: Write route and authority tests for all roles**

```ts
it.each([
  ["PUT", "/v1/admin/endpoints/ep-1", "workfabric.endpoint.provision.v1"],
  ["GET", "/v1/endpoints/ep-1", "workfabric.endpoint.read.v1"],
  ["GET", "/v1/endpoints?capability_id=code", "workfabric.endpoint.discover.v1"],
  ["POST", "/v1/endpoints/ep-1/sessions", "workfabric.endpoint.session.open.v1"],
  ["POST", "/v1/endpoints/ep-1/sessions/s-1/heartbeat", "workfabric.endpoint.session.heartbeat.v1"],
  ["POST", "/v1/endpoints/ep-1/sessions/s-1/close", "workfabric.endpoint.session.close.v1"],
  ["GET", "/v1/endpoints/ep-1/inbox/partitions", "workfabric.endpoint.inbox.read.v1"],
])("checks %s %s with %s", async (method, url, action) => {
  await server.inject({ method, url, headers: runtimeHeaders, payload: payloadFor(url) });
  expect(authority.lastAction).toBe(action);
});
```

Add cross-role tests proving admin, Runtime, Resolver, and unrelated principals cannot borrow one another's actions or Actor representation.
Also prove an enabled-to-disabled `PUT` checks `workfabric.endpoint.disable.v1`, while create and non-disabling updates check `workfabric.endpoint.provision.v1`.

- [ ] **Step 2: Run route tests and confirm 404/missing dependency failures**

Run: `npm test -- packages/transport-http/test/endpoint-routes.test.ts packages/transport-http/test/endpoint-route-authorization.test.ts`

Expected: FAIL because no Endpoint routes are registered.

- [ ] **Step 3: Extend service bounds**

Add `endpoint_min_lease_ms`, `endpoint_default_lease_ms`, `endpoint_max_lease_ms`, `endpoint_renew_ahead_ms`, `endpoint_max_capabilities`, `endpoint_max_bindings`, and `endpoint_max_inbox_partitions` to `HttpServiceConfig`. Validate positive integers, min <= default <= max, and renew-ahead < min lease.

- [ ] **Step 4: Register routes only when complete dependencies are supplied**

```ts
export interface EndpointRouteDependencies {
  readonly directory: EndpointDirectoryService;
  readonly inbox: EndpointInboxQueryService;
  readonly identity: IdentityResolver;
  readonly authority: AuthorityEvaluator;
}

export function registerEndpointRoutes(server: FastifyInstance, dependencies: EndpointRouteDependencies): void;
```

Each handler performs identity resolution, one exact action evaluation, path/query/body schema validation, service call, and bounded response encoding. Map Directory conflicts to RFC 9457 `409`, validation to `400`, hidden disabled/unrelated resources to `404`, unavailable dependencies to `503`, and deny to `403`; do not include session tokens, dependency messages, or request bodies in logs.

- [ ] **Step 5: Run HTTP regression and type checks**

Run: `npm test -- packages/transport-http/test && npm run typecheck`

Expected: Endpoint tests and all prior HTTP command/query/SSE tests PASS.

- [ ] **Step 6: Commit the transport binding**

```bash
git add packages/transport-http
git commit -m "feat: expose authorized Endpoint HTTP resources"
```

### Task 7: TypeScript SDK Endpoint logical client

**Files:**
- Create: `packages/sdk-typescript/src/endpoint-client.ts`
- Modify: `packages/sdk-typescript/src/protocol-types.ts`
- Modify: `packages/sdk-typescript/src/client.ts`
- Modify: `packages/sdk-typescript/src/index.ts`
- Test: `packages/sdk-typescript/test/endpoint-client.test.ts`

**Interfaces:**
- Consumes: existing SDK transport, auth refresh, timeout, Abort, redirect rejection, Problem Details, and command options.
- Produces: `client.endpoints` with provision/get/discover/openSession/heartbeat/closeSession/listInboxPartitions.

- [ ] **Step 1: Write exact request-shape and no-write-retry tests**

```ts
it("encodes Endpoint IDs and discovery query values", async () => {
  await client.endpoints.discover({ capability_id: "code/review", availability: ["available"], limit: 20 });
  expect(fetch.lastUrl).toBe("https://wf.test/v1/endpoints?capability_id=code%2Freview&availability=available&limit=20");
});

it.each(["provision", "openSession", "heartbeat", "closeSession"])("does not automatically retry %s", async (operation) => {
  fetch.failOnceAfterSend();
  await expect(invoke(operation)).rejects.toBeInstanceOf(WorkFabricTransportError);
  expect(fetch.calls).toHaveLength(1);
});
```

Add Abort, timeout, Problem Details, auth-refresh-once, path encoding, cursor encoding, and response clone tests.

- [ ] **Step 2: Run SDK tests and confirm missing logical client failure**

Run: `npm test -- packages/sdk-typescript/test/endpoint-client.test.ts`

Expected: FAIL because `client.endpoints` does not exist.

- [ ] **Step 3: Implement the public logical client**

```ts
export interface EndpointClient {
  provision(endpointId: string, input: EndpointRegistrationInput, options?: RequestOptions): Promise<EndpointRegistration>;
  get(endpointId: string, options?: RequestOptions): Promise<EndpointDescriptor>;
  discover(input?: EndpointDiscoveryInput, options?: RequestOptions): Promise<EndpointDiscoveryPage>;
  openSession(endpointId: string, input: EndpointSessionOpenInput, options?: RequestOptions): Promise<EndpointSession>;
  heartbeat(endpointId: string, sessionId: string, input: EndpointHeartbeatInput, options?: RequestOptions): Promise<EndpointSession>;
  closeSession(endpointId: string, sessionId: string, input: EndpointSessionCloseInput, options?: RequestOptions): Promise<EndpointSession>;
  listInboxPartitions(endpointId: string, input?: EndpointInboxPartitionInput, options?: RequestOptions): Promise<EndpointInboxPartitionPage>;
}
```

Use `encodeURIComponent` for every path component and `URLSearchParams` for every query value. Pass `retry: "never"` for all four write operations. Reuse the existing transport's response validation and safe error types.

- [ ] **Step 4: Compose and export `client.endpoints`**

Construct one frozen Endpoint client from the same private transport used by handoffs/subscriptions. Export only public protocol/request/response types; do not expose bearer tokens or HTTP internals.

- [ ] **Step 5: Run the complete SDK suite**

Run: `npm test -- packages/sdk-typescript/test && npm run typecheck`

Expected: all SDK logical clients PASS and existing behavior is unchanged.

- [ ] **Step 6: Commit SDK support**

```bash
git add packages/sdk-typescript
git commit -m "feat: add Endpoint TypeScript SDK client"
```

### Task 8: Local Agent Gateway connection library

**Files:**
- Create: `packages/agent-gateway/package.json`
- Create: `packages/agent-gateway/src/config.ts`
- Create: `packages/agent-gateway/src/errors.ts`
- Create: `packages/agent-gateway/src/bounded-async-queue.ts`
- Create: `packages/agent-gateway/src/partition-multiplexer.ts`
- Create: `packages/agent-gateway/src/agent-endpoint-session.ts`
- Create: `packages/agent-gateway/src/index.ts`
- Test: `packages/agent-gateway/test/agent-endpoint-session.test.ts`
- Test: `packages/agent-gateway/test/boundary.test.ts`

**Interfaces:**
- Consumes: only `@work-fabric/sdk-typescript` public clients and injected clock/timer/ID utilities.
- Produces: `AgentGateway.start`, `AgentEndpointSession.incoming`, explicit `IncomingHandoff.acknowledgeSignal`, and unchanged `session.handoffs` operations.

- [ ] **Step 1: Write connection, fencing, backpressure, and boundary tests**

```ts
it("renews the same fenced session and stops on fencing conflict", async () => {
  const session = await gateway.start();
  clock.advanceTo(session.renew_at);
  expect(client.endpoints.heartbeat).toHaveBeenCalledWith("ep-1", session.session_id, expect.objectContaining({ fencing_token: 3 }));
  client.endpoints.heartbeat.mockRejectedValueOnce(problem(409, "session_fenced"));
  await expect(session.closed).resolves.toMatchObject({ reason: "fenced" });
});

it("does not Ack or Accept while its bounded queue is full", async () => {
  await gateway.start();
  await streams.emit(queueCapacity + 1, deliveries);
  expect(client.subscriptions.acknowledge).not.toHaveBeenCalled();
  expect(client.handoffs.accept).not.toHaveBeenCalled();
});
```

Add tests for subscription create-or-verify mismatch, partition refresh, one cursor per partition, reconnect replay, max active streams, explicit Ack only, graceful draining/close, and abort.

- [ ] **Step 2: Run Gateway tests and confirm package absence**

Run: `npm test -- packages/agent-gateway/test`

Expected: FAIL because the Gateway package does not exist.

- [ ] **Step 3: Implement strict positive bounded configuration**

```ts
export interface AgentGatewayConfig {
  readonly endpoint_id: string;
  readonly subscription_id: string;
  readonly open_session: EndpointSessionOpenInput;
  readonly inbox_refresh_ms: number;
  readonly max_active_partitions: number;
  readonly incoming_queue_capacity: number;
  readonly heartbeat_retry_count: number;
  readonly heartbeat_backoff_ms: number;
  readonly graceful_close_timeout_ms: number;
}
```

Reject zero/negative/non-safe integers, max active partitions above 128, queue capacity above 1024, retries above 5, and close timeout above 60 seconds.

- [ ] **Step 4: Implement the bounded queue and per-partition multiplexer**

The queue's producer `push` waits for capacity and never drops. The multiplexer refreshes paginated inbox partitions, starts at most the configured number of SSE streams, stores a separate opaque cursor for each partition, reconnects only through the SDK's bounded SSE policy, and removes streams for inactive partitions after pending items drain. It provides arrival order only and exposes no priority comparator.

- [ ] **Step 5: Implement session lifecycle and explicit incoming API**

```ts
export interface IncomingHandoff {
  readonly partition_id: string;
  readonly delivery: EventDelivery;
  readonly handoff: HandoffSnapshot;
  acknowledgeSignal(outcome: "acknowledged" | "retry" | "rejected", options?: RequestOptions): Promise<AckResult>;
}

export interface AgentEndpointSession {
  readonly session_id: string;
  readonly handoffs: HandoffClient;
  readonly closed: Promise<{ readonly reason: "closed" | "aborted" | "fenced" | "failed" }>;
  incoming(): AsyncIterable<IncomingHandoff>;
  close(options?: { readonly signal?: AbortSignal }): Promise<void>;
}
```

`start` creates or reads the configured SSE Subscription and verifies exact tenant owner, actor, endpoint, mode, and empty filter. It opens one session, schedules heartbeat using `renew_after`, and may explicitly replay only the identical request after an ambiguous transport failure within retry bounds. It never calls acknowledge, accept, decline, status, result, model, tool, or Codex methods on its own. Graceful close heartbeats `draining`, stops streams, then submits fenced close.

- [ ] **Step 6: Enforce the package dependency boundary**

```ts
it("depends only on the public SDK", () => {
  expect(packageJson.dependencies).toEqual({ "@work-fabric/sdk-typescript": "0.1.0" });
  expect(sourceText).not.toMatch(/exchange-core|exchange-runtime|adapter-|fastify|openai|codex|model|tool/i);
});
```

Run: `npm test -- packages/agent-gateway/test && npm run typecheck`

Expected: lifecycle, boundedness, and negative boundary tests PASS.

- [ ] **Step 7: Commit the Gateway**

```bash
git add packages/agent-gateway
git commit -m "feat: add external Agent connection gateway"
```

### Task 9: Black-box reference flow, docs, and final gates

**Files:**
- Create: `packages/agent-gateway/test/reference-flow.integration.test.ts`
- Create: `examples/local-agent-runtime/package.json`
- Create: `examples/local-agent-runtime/src/index.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `protocol/README.md`
- Create: `docs/endpoint-agent-boundary.md`

**Interfaces:**
- Consumes: Tasks 1–8 and existing Handoff/Subscription SDK clients.
- Produces: one real HTTP + SDK + Gateway proof and user-facing Phase 4A operating documentation.

- [ ] **Step 1: Write the failing real reference-flow test**

```ts
it("connects an external Runtime without executing it inside Work Fabric", async () => {
  await admin.endpoints.provision("ep-agent", registration);
  const session = await gateway.start();
  const facts = await resolver.endpoints.discover({ capability_id: "software.implementation" });
  expect(facts.items.map(({ endpoint_id }) => endpoint_id)).toContain("ep-agent");

  await resolver.handoffs.resolveTarget(handoffId, { endpoint_id: "ep-agent" }, commandOptions);
  const incoming = await first(session.incoming());
  await persistInExternalRuntime(incoming.delivery);
  await incoming.acknowledgeSignal("acknowledged");
  await session.handoffs.accept({ handoff_id: handoffId }, commandOptions);
  await session.handoffs.reportStatus({ handoff_id: handoffId, status: statusUpdate }, commandOptions);
  await session.handoffs.submitResult({ handoff_id: handoffId, result }, commandOptions);

  expect(externalRuntimeCalls).toEqual(["persist", "decide", "work"]);
  expect(workFabricExecutionCalls).toEqual([]);
});
```

- [ ] **Step 2: Run the flow and fix only real integration gaps**

Run: `npm test -- packages/agent-gateway/test/reference-flow.integration.test.ts`

Expected before wiring: FAIL at the first unbound service dependency. Wire Memory stores, Directory service, verifier, projector, HTTP server, real SDK client, and Gateway through public constructors; do not introduce test-only production callbacks.

- [ ] **Step 3: Add a deterministic external Runtime example**

The example reads configuration from environment variables, starts the Gateway, persists the Delivery ID before explicit Ack, prints only non-sensitive Handoff IDs/states, and delegates its decision to a local function outside the Gateway package. The example must require the operator to choose `accept` or `decline`; it must not auto-accept.

- [ ] **Step 4: Update positioning, architecture, protocol, and roadmap docs**

Document:

- Work Fabric is the connection and handoff fabric, not the worker or brain.
- admin provisioning, Runtime session/heartbeat/close, Resolver discovery/explicit selection, and inbox Delivery sequence;
- Signal Ack versus Handoff Accept;
- multi-partition per-cursor semantics and absence of global order;
- Memory for local evaluation and PostgreSQL for durable deployment;
- exact configuration bounds and failure codes;
- Phase 4A marked complete only after final verification, with Phase 4B Feishu Connector next.

- [ ] **Step 5: Run boundary scans and performance-bound tests**

Run: `rg -n "auto.?accept|auto.?ack|executeTask|runTask|selected_endpoint|rank|score|recommend|openai|codex" packages/agent-gateway packages/endpoint-directory`

Expected: matches occur only in negative tests/documented prohibitions, never production execution or selection code.

Run: `npm test -- packages/agent-gateway/test packages/endpoint-directory/test packages/transport-http/test packages/sdk-typescript/test`

Expected: stream, queue, capability, Binding, lease, retry, and page bounds are covered and PASS.

- [ ] **Step 6: Run repository verification from a clean process**

Run: `npm run verify:exchange`

Expected: typecheck PASS, all package tests PASS except explicitly environment-gated PostgreSQL cases, and WFPP conformance remains 106/106 or higher with no regression.

Run: `git status --short`

Expected: only the intended Phase 4A documentation/example/integration files remain before the final commit.

- [ ] **Step 7: Commit the completed Phase 4A slice**

```bash
git add README.md docs examples packages/agent-gateway/test/reference-flow.integration.test.ts
git commit -m "docs: complete Phase 4A Agent connection boundary"
```

- [ ] **Step 8: Review final history and branch diff**

Run: `git log --oneline main..HEAD && git diff --stat main...HEAD && git status --short`

Expected: nine focused Phase 4A increments, no unrelated files, and a clean worktree.
