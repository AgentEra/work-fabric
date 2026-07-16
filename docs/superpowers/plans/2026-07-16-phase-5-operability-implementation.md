# Work Fabric Phase 5 Operability Implementation Plan

> **Execution rule:** implement one checked task at a time. Every behavior
> change starts with a focused failing test, reaches green with the smallest
> production change, runs its neighboring regression tests, and ends in an
> independent commit. Use `superpowers:test-driven-development` throughout and
> `superpowers:verification-before-completion` before every completion claim.

**Goal:** Make Work Fabric's responsibility handoffs and connection failures
understandable and operable through rebuildable projections, equal HTTP/SDK
access, bounded observability, complete local SQLite persistence, a Node
composition root, and a replaceable read-mostly Console.

**Architecture:** Committed WFPP events remain authoritative. New
technology-neutral operations ports store responsibility, timeline,
relationship and audit facts. Projectors and operations services consume
existing journals/stores; HTTP applies the same identity and Authority chain;
the TypeScript SDK is the only Console data path. Memory, SQLite and PostgreSQL
implement the same semantics. Operational recovery is explicit, idempotent,
audited and never mutates Handoff state directly.

**Tech stack:** Node.js >=22.20.0, TypeScript 7, Vitest 4, Fastify, existing
Work Fabric packages, PostgreSQL, Node SQLite for the local profile,
OpenTelemetry API, browser TypeScript/Vite, CSS and accessible HTML.

## Global constraints

- No Phase 5 dependency enters `exchange-core` or protocol schemas.
- No query projection becomes authoritative or accepts direct domain writes.
- No Console-only, Agent-only or admin-backdoor state channel is created.
- Tenant comes from authenticated Principal; filters never select tenant.
- Every list has deterministic opaque cursor pagination and a hard maximum.
- No Context/result/document body, credential, token, claim token or raw
  Connector payload appears in operational views, logs, metrics or traces.
- Metric attributes have bounded cardinality and never contain identity IDs.
- Recovery requests are idempotent, expected-version checked and audited.
- SQLite advertises single-process local durability only and never mixes
  durable Core state with volatile supporting stores.
- Benchmarks report measured environments and never become scale promises.

## Phase 5A — Collaboration visibility

### Task 1: Define stable operations SPI and cursor contract

**Files**

- Create `packages/operations-spi/package.json`
- Create `packages/operations-spi/src/cursor.ts`
- Create `packages/operations-spi/src/collaboration.ts`
- Create `packages/operations-spi/src/audit.ts`
- Create `packages/operations-spi/src/telemetry.ts`
- Create `packages/operations-spi/src/index.ts`
- Create `packages/operations-spi/test/contracts.test.ts`

**Contract**

- Define safe `ResponsibilityView`, `TimelineEntry`, `RelationshipView`, page,
  filter and freshness metadata types.
- Define monotonic/resettable stores with explicit tenant/partition inputs.
- Define versioned opaque cursors whose signed/encoded payload binds sort and
  normalized filters; malformed or oversized cursors fail closed.
- Define append-only `AuditStore`, `AuditRecord`, bounded query and retention
  contracts without HTTP/database/OTel types.
- Define a narrow semantic telemetry observer with enumerated operation,
  outcome and category values; arbitrary label maps are not accepted.

**Steps**

1. Write compile/runtime tests for exact discriminants, bounds, defensive
   cloning expectations, cursor filter binding and technology-name absence.
2. Run `npx vitest run packages/operations-spi/test/contracts.test.ts` and
   confirm RED because the package/contracts do not exist.
3. Implement minimal types, validators and HMAC-capable cursor codec using an
   injected signer/verifier; do not depend on Node crypto in the SPI itself.
4. Run the focused test and `npm run typecheck`.
5. Commit `feat: define operability contracts`.

### Task 2: Memory operations stores and reusable conformance

**Files**

- Create `packages/adapter-operations-memory/package.json`
- Create `packages/adapter-operations-memory/src/memory-collaboration-store.ts`
- Create `packages/adapter-operations-memory/src/memory-audit-store.ts`
- Create `packages/adapter-operations-memory/src/index.ts`
- Create `packages/adapter-operations-memory/test/memory-operations.test.ts`
- Create `packages/exchange-conformance/src/operations-profile.ts`
- Modify `packages/exchange-conformance/src/index.ts`
- Create `packages/exchange-conformance/test/operations-profile.test.ts`

**Profile cases**

- monotonic idempotent view upsert and same-version conflict;
- tenant/partition isolation and targeted reset;
- deterministic responsibility filters and stable cursor continuation;
- timeline forward ordering and relationship deduplication;
- immutable returned values;
- append-only audit idempotency and immutable first write;
- audit cursor/filter/retention behavior and hard bounds.

**Steps**

1. Write the reusable profile and invoke it against missing Memory stores.
2. Run both focused tests and confirm expected RED imports/behaviors.
3. Implement serialized in-memory mutations with injected clock/ID/cursor
   codec and no wall-clock sleeps.
4. Run focused tests, typecheck and existing projection conformance.
5. Commit `feat: add reference operability stores`.

### Task 3: Rebuildable collaboration projector

**Files**

- Create `packages/operations-runtime/package.json`
- Create `packages/operations-runtime/src/collaboration-projector.ts`
- Create `packages/operations-runtime/src/collaboration-codec.ts`
- Create `packages/operations-runtime/src/index.ts`
- Create `packages/operations-runtime/test/collaboration-projector.test.ts`
- Create `packages/operations-runtime/test/collaboration-recovery.integration.test.ts`

**Behavior**

- Consume one partition journal in position order and convert only committed
  public facts.
- Derive responsibility from decoded Handoff state, timeline from
  `buildProtocolEvent`, and relationships only from thread/parent/child/target
  facts.
- Advance a dedicated checkpoint only after all three stores accept the event.
- Stop and record a bounded poison failure for gaps/decode/store conflicts.
- Rebuild resets only the requested tenant/partition stores and checkpoint and
  produces a result deeply equal to incremental projection.
- Expose checkpoint/journal positions as freshness metadata.

**Steps**

1. Write offer/resolve/accept/status/result/verify/transfer/rebuild tests first.
2. Run the focused tests and verify RED due to missing projector.
3. Implement one bounded batch loop by reusing existing event/state codecs;
   never copy opaque private domain data into views.
4. Run focused tests, all `exchange-runtime` tests and typecheck.
5. Commit `feat: project collaboration visibility`.

### Task 4: Collaboration query service, HTTP resources and SDK

**Files**

- Create `packages/operations-runtime/src/collaboration-query-service.ts`
- Create `packages/operations-runtime/test/collaboration-query-service.test.ts`
- Create `packages/transport-http/src/routes/collaboration-routes.ts`
- Modify `packages/transport-http/src/internal/create-server.ts`
- Modify `packages/transport-http/src/index.ts`
- Create `packages/transport-http/test/collaboration-routes.test.ts`
- Create `packages/sdk-typescript/src/collaboration-client.ts`
- Modify `packages/sdk-typescript/src/client.ts`
- Modify `packages/sdk-typescript/src/protocol-types.ts`
- Modify `packages/sdk-typescript/src/index.ts`
- Create `packages/sdk-typescript/test/collaboration-client.test.ts`

**HTTP/SDK behavior**

- Add bounded `GET /v1/responsibilities`, `/v1/timeline` and
  `/v1/relationships` resources.
- Derive tenant and represented identity from the normal authentication path.
- Authorize stable operation/resource pairs before reading.
- Return page items, opaque next cursor and explicit projection freshness.
- `client.collaboration` validates all inputs and deeply decodes response
  discriminants/bounds; Query retry remains bounded and read-only.

**Steps**

1. Write query service tests for filters, cross-tenant fail-closed behavior and
   freshness.
2. Write HTTP tests for authorization, pagination, bad cursor/limit and safe
   Problem Details; run them and confirm RED.
3. Implement query service and routes; run service/route tests green.
4. Write SDK request/decoder tests and confirm RED.
5. Implement `CollaborationClient`, compose it into `WorkFabricClient`, then run
   SDK, HTTP and typecheck suites.
6. Commit `feat: expose collaboration visibility`.

### Task 5: PostgreSQL collaboration projections and audit foundation

**Files**

- Create `packages/adapter-storage-postgres/migrations/007_operability.sql`
- Create `packages/adapter-storage-postgres/src/postgres-collaboration-store.ts`
- Create `packages/adapter-storage-postgres/src/postgres-audit-store.ts`
- Modify `packages/adapter-storage-postgres/src/index.ts`
- Create `packages/adapter-storage-postgres/test/postgres-operability.test.ts`
- Modify `tools/postgres-smoke.ts`
- Modify `packages/adapter-storage-postgres/README.md`

**Schema/transaction behavior**

- Tenant-owned responsibility, timeline, relationship and audit tables use RLS
  and indexed deterministic sort keys.
- View writes reject stale/same-version-conflicting content and are idempotent
  for exact replay.
- Timeline event identity is unique within tenant/partition and cursor queries
  use index-supported predicates.
- Reset is tenant/partition scoped and transactional.
- Audit is append-only with immutable first write and indexed occurred/audit ID
  pagination; retention deletion is tenant-scoped and bounded.

**Steps**

1. Invoke the operations conformance profile against PostgreSQL and add
   migration/RLS/index tests; confirm RED.
2. Add migration and stores using shared session/transaction helpers.
3. Run focused tests with and without `PG_TEST_URL`, migration dry run,
   `npm run verify:postgres`, and typecheck.
4. Commit `feat: persist operability views in PostgreSQL`.

## Phase 5B — Operational visibility and observability

### Task 6: Structured audit at authenticated boundaries

**Files**

- Create `packages/operations-runtime/src/audit-recorder.ts`
- Create `packages/operations-runtime/test/audit-recorder.test.ts`
- Modify `packages/transport-http/src/internal/create-server.ts`
- Modify `packages/transport-http/src/routes/route-authorization.ts`
- Modify `packages/transport-http/src/routes/command-route.ts`
- Create `packages/transport-http/test/audit.integration.test.ts`

**Behavior**

- Record normalized authorization decision and final operation outcome with
  request/trace correlation and safe represented identity references.
- Never record authentication evidence, authorization headers, bodies,
  exception messages or response content.
- Use deterministic request+operation audit identity for retry idempotency.
- Buffer durably before asynchronous export; audit export failure is visible in
  health but never rolls back an already committed domain command.
- Denied requests and failed recovery actions are auditable without revealing
  whether an unauthorized resource exists.

**Steps**

1. Write recorder sanitization/idempotency/failure tests and HTTP integration
   tests; verify RED.
2. Implement injected audit recorder and hooks at shared authorization and
   command outcome boundaries.
3. Run all transport, operations runtime and typecheck tests.
4. Commit `feat: record bounded operation audit`.

### Task 7: Delivery, projection and Connector operational queries

**Files**

- Create `packages/operations-spi/src/operations.ts`
- Modify `packages/operations-spi/src/index.ts`
- Create `packages/operations-runtime/src/operations-query-service.ts`
- Create `packages/operations-runtime/test/operations-query-service.test.ts`
- Modify `packages/connector-runtime/src/reconciliation.ts`
- Create `packages/adapter-operations-memory/src/memory-discrepancy-store.ts`
- Modify `packages/adapter-operations-memory/src/index.ts`
- Create `packages/transport-http/src/routes/operations-routes.ts`
- Modify `packages/transport-http/src/internal/create-server.ts`
- Create `packages/transport-http/test/operations-routes.test.ts`
- Modify `packages/sdk-typescript/src/operations-client.ts`
- Modify `packages/sdk-typescript/src/protocol-types.ts`
- Modify `packages/sdk-typescript/test/query-operations-client.test.ts`

**Behavior**

- Expose sanitized projection status/failure, delivery position/attempt/dead
  letter, Connector ingress lifecycle and reconciliation discrepancy pages.
- Never return dead-letter payloads, ingress envelopes, claim/fencing tokens,
  credential refs or unbounded failure detail.
- Add list/get/acknowledgement semantics to the discrepancy store while keeping
  reconciliation comparison-only.
- Preserve existing `/v1/admin` route compatibility as aliases over the new
  operations query service.

**Steps**

1. Write operations contracts and service tests for redaction, bounds, tenant
   mismatch and page stability; confirm RED.
2. Implement minimal service/adapters and run focused tests.
3. Write HTTP route tests and implement authenticated resources.
4. Write SDK decoder/request tests and expand `OperationsClient`.
5. Run connector, transport, SDK and typecheck suites.
6. Commit `feat: expose operational connection state`.

### Task 8: Idempotent operational recovery requests

**Files**

- Create `packages/operations-spi/src/recovery.ts`
- Modify `packages/operations-spi/src/index.ts`
- Create `packages/operations-runtime/src/recovery-service.ts`
- Create `packages/operations-runtime/src/recovery-worker.ts`
- Create `packages/operations-runtime/test/recovery-service.test.ts`
- Create `packages/operations-runtime/test/recovery-worker.test.ts`
- Create `packages/adapter-operations-memory/src/memory-recovery-store.ts`
- Modify `packages/adapter-operations-memory/src/index.ts`
- Modify `packages/adapter-storage-postgres/migrations/007_operability.sql`
- Create `packages/adapter-storage-postgres/src/postgres-recovery-store.ts`
- Modify `packages/adapter-storage-postgres/src/index.ts`
- Create `packages/transport-http/src/routes/recovery-routes.ts`
- Create `packages/transport-http/test/recovery-routes.test.ts`
- Modify `packages/sdk-typescript/src/operations-client.ts`

**Behavior**

- Accept one explicit connector requeue, delivery replay, projection rebuild or
  discrepancy acknowledgement request with idempotency key, expected version
  and bounded reason.
- Return accepted/replayed/conflict/not-found without domain-state mutation.
- Worker claims fenced requests and invokes only the owning store's public
  recovery operation; stale workers cannot complete.
- Audit accepted, denied, conflicted and completed outcomes.
- Projection rebuild requests pause only the requested projector/partition and
  preserve the journal.

**Steps**

1. Write lifecycle, fencing, idempotency, authorization and audit tests first.
2. Run focused tests and verify RED.
3. Implement SPI, Memory/PostgreSQL stores, service and worker.
4. Add HTTP/SDK action tests and implementation.
5. Run operations conformance, PostgreSQL, Connector, transport, SDK and
   typecheck suites.
6. Commit `feat: add audited operational recovery`.

### Task 9: OpenTelemetry-compatible metrics and tracing

**Files**

- Create `packages/operations-observability/package.json`
- Create `packages/operations-observability/src/semantic-observer.ts`
- Create `packages/operations-observability/src/otel-observer.ts`
- Create `packages/operations-observability/src/index.ts`
- Create `packages/operations-observability/test/semantic-observer.test.ts`
- Modify `packages/transport-http/src/internal/create-server.ts`
- Modify `packages/operations-runtime/src/collaboration-projector.ts`
- Modify `packages/connector-runtime/src/connector-worker.ts`
- Modify `packages/exchange-runtime/src/subscription/signal-dispatcher.ts`
- Create `packages/operations-observability/test/instrumentation.integration.test.ts`

**Behavior**

- Provide no-op and OpenTelemetry observers through the same semantic port.
- Emit request/query/command latency, projector lag/batches, delivery outcome,
  ingress outcome, recovery outcome and worker lease loss.
- Reject high-cardinality/content-bearing metric attributes at the adapter
  boundary.
- Trace stable operation/category/outcome and safe correlation only.
- Bound exporter queue/batch behavior through deployment configuration.

**Steps**

1. Write allowed/forbidden attribute and span/metric semantic tests; confirm
   RED.
2. Implement no-op/OTel observers and instrumentation hooks.
3. Run focused integration, worker/runtime/transport tests and typecheck.
4. Commit `feat: instrument Work Fabric operations`.

## Phase 5C — Local persistence, service and Console

### Task 10: SQLite common layer, migrations and Exchange persistence

**Files**

- Create `packages/adapter-storage-sqlite/package.json`
- Create `packages/adapter-storage-sqlite/src/sqlite-session.ts`
- Create `packages/adapter-storage-sqlite/src/migrations.ts`
- Create `packages/adapter-storage-sqlite/src/sqlite-exchange-persistence.ts`
- Create `packages/adapter-storage-sqlite/src/index.ts`
- Create `packages/adapter-storage-sqlite/migrations/001_exchange.sql`
- Create `packages/adapter-storage-sqlite/test/sqlite-exchange.test.ts`
- Create `tools/sqlite-migrate.ts`
- Modify `package.json`

**Behavior**

- Use a caller-owned SQLite database/file with foreign keys, busy timeout,
  explicit transactions and WAL for local file mode.
- Apply checksummed ordered migrations under an exclusive migration lock.
- Scope every store instance to one trusted tenant and include tenant in all
  keys/predicates; do not rely on PostgreSQL RLS semantics.
- Implement Journal, snapshot, idempotency, outbox, projection checkpoint,
  subscription, delivery and dead-letter ports atomically.
- Advertise local-file durability, single-process writer and no clustered
  claims in the manifest.

**Steps**

1. Invoke existing persistence/reference profiles against `:memory:` and a
   temporary file; confirm RED.
2. Add migration/session layer and minimal Exchange implementation in profile
   order, running each failing case to green.
3. Add close/reopen restart, rollback and tenant-isolation tests.
4. Run SQLite tests, full Exchange conformance and typecheck.
5. Commit `feat: add SQLite Exchange persistence`.

### Task 11: Complete SQLite Context, Endpoint, Connector and operations stores

**Files**

- Create `packages/adapter-storage-sqlite/migrations/002_supporting_stores.sql`
- Create `packages/adapter-storage-sqlite/src/sqlite-context-store.ts`
- Create `packages/adapter-storage-sqlite/src/sqlite-endpoint-store.ts`
- Create `packages/adapter-storage-sqlite/src/sqlite-connector-ingress-store.ts`
- Create `packages/adapter-storage-sqlite/src/sqlite-operations-store.ts`
- Modify `packages/adapter-storage-sqlite/src/index.ts`
- Create `packages/adapter-storage-sqlite/test/sqlite-supporting-stores.test.ts`

**Behavior**

- Pass Context, Endpoint Directory/Inbox, Connector ingress and operations
  conformance profiles with the same bounds and defensive copies.
- Use transactional CAS/fencing suitable for one process and monotonic tokens
  across restart.
- Persist no credential or content beyond the existing technology-neutral
  contracts.
- One SQLite profile composition uses only SQLite stores for durable facts.

**Steps**

1. Instantiate every existing/new conformance profile against missing SQLite
   stores and verify RED.
2. Implement migrations and stores profile-by-profile.
3. Add one cross-store restart integration test covering Handoff, Endpoint,
   Connector, projection and audit facts.
4. Run all SQLite profiles, Exchange verification and typecheck.
5. Commit `feat: complete SQLite local persistence`.

### Task 12: Node service composition and runnable lifecycle demo

**Files**

- Create `packages/service-node/package.json`
- Create `packages/service-node/src/config.ts`
- Create `packages/service-node/src/compose.ts`
- Create `packages/service-node/src/main.ts`
- Create `packages/service-node/src/index.ts`
- Create `packages/service-node/test/config.test.ts`
- Create `packages/service-node/test/memory-composition.integration.test.ts`
- Create `packages/service-node/test/sqlite-restart.integration.test.ts`
- Create `examples/customer-project-lifecycle/package.json`
- Create `examples/customer-project-lifecycle/src/seed.ts`
- Create `examples/customer-project-lifecycle/README.md`

**Behavior**

- Validate bounded environment/file configuration for memory-demo,
  sqlite-local and PostgreSQL profiles.
- Compose API, projectors, delivery, Endpoint, Connector, audit and recovery
  workers without adding logic to the composition root.
- Support independent API/projector/delivery/connector roles, readiness and
  graceful shutdown.
- Seed the previously documented customer-intent-through-operations example
  only through public HTTP/SDK commands.
- Never ship default production credentials or an allow-all production policy.

**Steps**

1. Write invalid config/profile and minimal memory composition tests; verify
   RED.
2. Implement configuration and memory profile composition.
3. Write SQLite restart test and implement local composition.
4. Add PostgreSQL composition validation and migration wiring without requiring
   a live DB in unit tests.
5. Run service integration, SQLite/PostgreSQL targeted and typecheck suites.
6. Commit `feat: add runnable Node service composition`.

### Task 13: Read-mostly Console shell and collaboration views

**Files**

- Create `packages/console-web/package.json`
- Create `packages/console-web/index.html`
- Create `packages/console-web/src/config.ts`
- Create `packages/console-web/src/client.ts`
- Create `packages/console-web/src/router.ts`
- Create `packages/console-web/src/app.ts`
- Create `packages/console-web/src/styles.css`
- Create `packages/console-web/src/views/responsibilities.ts`
- Create `packages/console-web/src/views/handoff-detail.ts`
- Create `packages/console-web/test/console.test.ts`
- Modify `package.json`

**Behavior**

- Import only the public TypeScript SDK for Work Fabric data/actions.
- Render responsibility filters/page state and Handoff timeline/relationships.
- Preserve URL navigation and presentation preferences only; no protocol cache
  or direct storage access.
- Provide keyboard navigation, semantic structure, visible focus, reduced
  motion, loading/empty/error/stale states and responsive layout.
- Runtime configuration supplies origin/auth integration without embedding
  tokens in built assets.

**Steps**

1. Write import-boundary, configuration and DOM behavior tests; confirm RED.
2. Implement a minimal framework-light TypeScript shell and SDK injection.
3. Add responsibility and detail views with deterministic test fixtures.
4. Run Console tests, production build, dependency-boundary test and typecheck.
5. Commit `feat: add collaboration Console`.

### Task 14: Console operations, recovery and live refresh

**Files**

- Create `packages/console-web/src/views/operations.ts`
- Create `packages/console-web/src/views/connectors.ts`
- Create `packages/console-web/src/live-refresh.ts`
- Modify `packages/console-web/src/app.ts`
- Modify `packages/console-web/src/styles.css`
- Create `packages/console-web/test/operations-console.test.ts`
- Create `packages/console-web/test/live-refresh.test.ts`

**Behavior**

- Display projection, delivery, Connector, discrepancy and audit views with
  explicit freshness and safe detail.
- Recovery forms require reason, expected version and confirmation, then call
  SDK operations; authority denial remains a normal visible outcome.
- Existing authenticated SSE invalidates affected queries; it never auto-Acks
  or becomes a second state store.
- Polling fallback has bounded interval, jitter, abort and one in-flight request.

**Steps**

1. Write operation view, recovery safety and SSE/poll fallback tests; verify
   RED.
2. Implement views/actions only through injected `WorkFabricClient`.
3. Implement live invalidation and bounded fallback.
4. Run Console tests/build plus HTTP/SDK integration.
5. Commit `feat: complete operability Console`.

### Task 15: End-to-end proof, benchmark harness and security gates

**Files**

- Create `packages/service-node/test/phase-5-roundtrip.integration.test.ts`
- Create `tools/benchmark-operability.ts`
- Create `tools/check-sensitive-observability.ts`
- Create `tools/check-console-boundaries.ts`
- Modify `package.json`
- Create `docs/performance-baseline.md`

**Proof**

- Run Offer/Accept/Status/Result/Verify through real HTTP and SDK, project and
  query responsibility/timeline/relationships, then rebuild identically.
- Create sanitized delivery and Connector failures, query them, authorize one
  recovery and prove the audit trail; deny another with zero state change.
- Load the Console build against the same HTTP service and prove all data calls
  use documented SDK routes.
- Scan source/fixtures/output for credentials, content-bearing telemetry and
  forbidden Console imports.
- Benchmark projection catch-up and read APIs with generated bounded data and
  record environment, samples and percentiles.

**Steps**

1. Write the black-box integration and boundary gate tests; confirm RED.
2. Add only missing composition/test seams required by the proof.
3. Implement benchmark and safety tools with smoke-testable small modes.
4. Run roundtrip, Console build, safety gates and benchmark smoke.
5. Commit `test: prove Phase 5 operability`.

### Task 16: Documentation, roadmap and final verification

**Files**

- Modify `README.md`
- Modify `docs/architecture.md`
- Modify `docs/roadmap.md`
- Create `docs/operations.md`
- Create `docs/sqlite-deployment.md`
- Create `docs/console.md`
- Modify `docs/postgresql-deployment.md`
- Modify `examples/feishu-connector/README.md`

**Documentation**

- Mark 5A/5B/5C complete only after their gates pass.
- Explain responsibility/timeline/relationship projection freshness and rebuild.
- Document audit retention, telemetry safety, recovery runbooks and Authority
  actions.
- Document memory-demo, sqlite-local and PostgreSQL profiles without overstated
  durability/performance claims.
- Show how to run the lifecycle seed, Node service and optional Console.
- Reaffirm that execution, scheduling and Agent reasoning remain external.

**Verification**

1. Run focused package tests for every Phase 5 package.
2. Run `npm run verify:exchange`.
3. Run `npm run verify:postgres` (live cases skip only when `PG_TEST_URL` is
   absent) and all SQLite restart/conformance tests.
4. Run Console production build and boundary/security scripts.
5. Run `npm run verify` and require typecheck, all tests and WFPP 120/120.
6. Inspect `git diff --check`, dependency directions, migration order, test
   skip reasons and repository status.
7. Commit `docs: complete Phase 5 operability`.

## Completion checklist

- [ ] Responsibility, timeline and relationship views rebuild exactly.
- [ ] Human, Agent, Connector, customer service and Console share HTTP/SDK
      contracts and Authority semantics.
- [ ] Delivery, projection, Connector, discrepancy and audit state are visible
      without secret/content leakage.
- [ ] Recovery is explicit, fenced/idempotent, expected-version checked and
      audited; it never edits Handoff state directly.
- [ ] Metrics/traces have bounded semantic attributes.
- [ ] Memory, SQLite and PostgreSQL pass applicable conformance profiles.
- [ ] SQLite restart preserves every durable local-profile store.
- [ ] Console imports only the SDK and is never required for handoff execution.
- [ ] Node composition and customer lifecycle example run through public APIs.
- [ ] Benchmark evidence is reproducible and claims remain scoped.
- [ ] Full verification and WFPP conformance pass from a clean checkout.
