# Feishu Connector Phase 4B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` and implement one checked increment at a time.
> Every behavior change starts with a failing test and every increment ends in
> an independent commit.

**Goal:** Connect Feishu humans, messages, interactive acknowledgements, and
document references to Work Fabric through a reusable durable Connector seam,
without moving execution, scheduling, content authority, or Agent reasoning
inside Work Fabric.

**Architecture:** A generic Connector SPI and worker runtime durably accept,
deduplicate, lease, map, retry, and inspect external events. Memory and
PostgreSQL stores share one conformance profile. A Feishu-only package verifies
callbacks, normalizes message/card/document inputs, resolves configured
identities, and implements the existing outbound `SignalAdapter`. HTTP and the
optional official Node SDK long connection are thin event sources over the same
durable ingress acceptor. All Work Fabric changes go through an injected public
command sink implemented at composition time with the TypeScript SDK.

**Tech stack:** Node.js >=22.20.0, TypeScript 7, Vitest 4, Fastify, PostgreSQL,
Web Crypto/Node Crypto, existing Work Fabric HTTP/SDK/runtime packages, and an
optional Feishu Node SDK boundary.

## Global constraints

- No Feishu import or type appears in `exchange-core`, `protocol-runtime`, or
  `exchange-spi`.
- Connector receipt, mapping completion, outbound API acceptance, and Handoff
  acknowledgement remain separate facts.
- Event sources only verify, normalize, and durably accept; they never execute
  public commands inline.
- Core facts contain references and bounded metadata, not Feishu credentials,
  tokens, raw documents, or arbitrary message bodies.
- Callback identities are resolved to existing Work Fabric identities. No
  trusted Actor is auto-created from external claims.
- Chat messages are inert unless an injected mapping policy explicitly
  recognizes them. Generated card actions are explicit and version checked.
- Every queue, body, batch, lease, retry, retention, request, response, and
  content size is positively bounded.
- No global ordering, global lock, database-specific SPI, or distributed
  transaction is introduced.
- Connector workers may scale independently by tenant/connector/partition.
- Public writes use stable connector-derived idempotency identities and the
  same SDK authorization rules as humans, Agents, UI, and other services.

## Task 1: Stable generic Connector SPI

**Files**

- Create `packages/connector-spi/package.json`
- Create `packages/connector-spi/src/ingress.ts`
- Create `packages/connector-spi/src/mapping.ts`
- Create `packages/connector-spi/src/resource.ts`
- Create `packages/connector-spi/src/index.ts`
- Create `packages/connector-spi/test/contracts.test.ts`

**Contract**

- `ConnectorIngressStore.accept()` atomically returns `accepted | duplicate`.
- `claim()` returns fenced leases ordered by eligibility without promising
  business ordering.
- `complete()`, `retry()`, and `deadLetter()` require the current claim token
  and fencing token.
- `requeue()` is explicit and carries a bounded audit reason.
- `ConnectorEventMapper` returns `ignored | reference_observed | command |
  reconciliation_observation | rejected`.
- `ConnectorCommandSink` accepts only a bounded public operation descriptor and
  stable idempotency identity.
- `ConnectorIdentityResolver` and `ConnectorResourceResolver` are
  transport-neutral and tenant scoped.

- [ ] Write compile-time/runtime tests for manifest profiles, exact lifecycle
  unions, readonly tenant scope, and absence of concrete technology fields.
- [ ] Run `npm test -- packages/connector-spi/test/contracts.test.ts`; confirm
  the missing package/import is RED.
- [ ] Implement the minimal ports and scalar validation helpers. Reuse
  `JsonObject` and `ExchangeAdapter` from `exchange-spi` without changing it.
- [ ] Run the focused test and `npm run typecheck`.
- [ ] Commit `feat: define generic Connector contracts`.

## Task 2: Memory ingress store and reusable conformance

**Files**

- Create `packages/adapter-connector-memory/package.json`
- Create `packages/adapter-connector-memory/src/memory-connector-ingress-store.ts`
- Create `packages/adapter-connector-memory/src/index.ts`
- Create `packages/adapter-connector-memory/test/memory-connector-ingress-store.test.ts`
- Create `packages/exchange-conformance/src/connector-ingress-profile.ts`
- Modify `packages/exchange-conformance/src/index.ts`
- Create `packages/exchange-conformance/test/connector-ingress-profile.test.ts`

**Profile cases**

- atomic duplicate acceptance in one tenant and independence across tenants;
- deterministic eligible claims with batch bounds;
- one active claim, monotonically increasing fencing token, lease recovery;
- stale token rejection for complete/retry/dead-letter;
- retry waits until `available_at`;
- permanent dead letter and explicit audited requeue;
- completed records are not reclaimed;
- tenant-filtered read visibility and bounded pagination;
- defensive cloning of payloads and returned records.

- [ ] Write the profile and Memory invocation first.
- [ ] Run the two focused tests and confirm missing implementation failures.
- [ ] Implement the in-memory store using a serialized mutation section and
  injected clock/ID factory; do not use wall-clock sleeps in tests.
- [ ] Run the profile, package test, and typecheck.
- [ ] Commit `feat: add reference Connector ingress store`.

## Task 3: Connector mapping worker

**Files**

- Create `packages/connector-runtime/package.json`
- Create `packages/connector-runtime/src/connector-worker.ts`
- Create `packages/connector-runtime/src/errors.ts`
- Create `packages/connector-runtime/src/index.ts`
- Create `packages/connector-runtime/test/connector-worker.test.ts`

**Worker semantics**

- claim one bounded batch for one trusted tenant/connector scope;
- heartbeat or finish inside the configured lease;
- call the mapper once per claim;
- complete `ignored` and successful outcomes;
- pass `command` only to the injected `ConnectorCommandSink`;
- classify typed mapping/sink errors as retryable or permanent;
- calculate retry time from injected policy and bounded attempt number;
- redact exception text to a stable code and bounded safe detail;
- abort after fencing loss without another side effect;
- expose counts without content-bearing metric labels.

- [ ] Write tests for all five mapper outcomes, sink replay, backoff, terminal
  attempt, mapper exception, and stale claim.
- [ ] Run the focused test and observe RED.
- [ ] Implement one `runBatch()` unit with injected store, mapper, sink, clock,
  retry policy, and metrics observer.
- [ ] Run focused tests, typecheck, and the Connector conformance profile.
- [ ] Commit `feat: add durable Connector mapping worker`.

## Task 4: PostgreSQL Connector ingress adapter

**Files**

- Create `packages/adapter-storage-postgres/migrations/005_connector_ingress.sql`
- Create `packages/adapter-storage-postgres/src/postgres-connector-ingress-store.ts`
- Modify `packages/adapter-storage-postgres/src/index.ts`
- Create `packages/adapter-storage-postgres/test/postgres-connector-ingress-store.test.ts`
- Modify `packages/adapter-storage-postgres/README.md`
- Modify `tools/postgres-smoke.ts`

**Schema and transactions**

- `wf_connector_ingress` contains tenant/connector/source scope, immutable
  dedupe identity, bounded payload, lifecycle, scheduling, lease/fencing,
  attempt, safe error, retention, and timestamps.
- Unique key is tenant + connector + source system + dedupe key.
- Eligible-claim index begins with tenant/connector/state/available time.
- Claim uses `FOR UPDATE SKIP LOCKED`, increments fencing atomically, and
  returns the committed token.
- Every mutation includes tenant, claim token, and fencing predicate.
- RLS uses the same tenant session mechanism as existing production tables.

- [ ] Instantiate the shared profile against PostgreSQL and add SQL/RLS tests.
- [ ] Run the focused PostgreSQL tests to capture RED.
- [ ] Add migration and store implementation using shared Postgres transaction
  helpers; never expose a pool/client in the SPI.
- [ ] Run focused tests, `npm run verify:postgres`, and migration smoke.
- [ ] Commit `feat: persist durable Connector ingress in PostgreSQL`.

## Task 5: Feishu credential and webhook codec boundary

**Files**

- Create `packages/connector-feishu/package.json`
- Create `packages/connector-feishu/src/config.ts`
- Create `packages/connector-feishu/src/credentials.ts`
- Create `packages/connector-feishu/src/webhook-codec.ts`
- Create `packages/connector-feishu/src/ingress-normalizer.ts`
- Create `packages/connector-feishu/src/index.ts`
- Create `packages/connector-feishu/test/webhook-codec.test.ts`
- Create `packages/connector-feishu/test/ingress-normalizer.test.ts`
- Add sanitized official Feishu fixtures under
  `packages/connector-feishu/test/fixtures/`

**Codec requirements**

- preserve exact raw body for signature calculation;
- validate signature, timestamp skew, encrypt key mode, decryption padding, and
  verification token in constant-time where applicable;
- handle URL verification challenges without creating ingress records;
- normalize schema 2.0 message/card envelopes to the generic ingress type;
- use message ID for received-message dedupe and action/event identity for card
  callbacks;
- reject unknown/oversized/deep/secret-shaped data with safe typed errors;
- expose no decrypted payload or credentials in errors.

- [ ] Write official-fixture vector tests, tamper tests, skew/replay tests,
  challenge tests, duplicate-key tests, and serialization bounds.
- [ ] Run focused tests and observe RED.
- [ ] Implement configuration validation, credential-provider interface, codec,
  and normalizer using Node crypto primitives behind pure functions.
- [ ] Run focused tests and typecheck.
- [ ] Commit `feat: verify and normalize Feishu callbacks`.

## Task 6: Feishu identity, action, and document mapping

**Files**

- Create `packages/connector-feishu/src/identity-mapper.ts`
- Create `packages/connector-feishu/src/action-token.ts`
- Create `packages/connector-feishu/src/event-mapper.ts`
- Create `packages/connector-feishu/src/document-reference.ts`
- Create `packages/connector-feishu/src/resource-resolver.ts`
- Modify `packages/connector-feishu/src/index.ts`
- Create `packages/connector-feishu/test/event-mapper.test.ts`
- Create `packages/connector-feishu/test/document-reference.test.ts`
- Create `packages/connector-feishu/test/resource-resolver.test.ts`
- Create `packages/sdk-typescript/src/connector-command-sink.ts`
- Modify `packages/sdk-typescript/src/index.ts`
- Create `packages/sdk-typescript/test/connector-command-sink.test.ts`

**Mapping rules**

- unknown external identity is rejected, never provisioned;
- arbitrary chat maps to `ignored` unless a configured policy recognizes it;
- generated action tokens are opaque, authenticated, scoped, expiring, and
  single-purpose;
- token resolution supplies the authoritative handoff/action/expected-version
  tuple and mapped Actor/Endpoint/Delegation;
- SDK sink turns the generic descriptor into an existing public client call;
- document reference is `feishu://docx/{id}?revision={revision}` and stores only
  bounded metadata;
- wiki references resolve to backing Docx identity before canonicalization;
- raw content fetch enforces media/byte/time limits and returns content to the
  caller without writing Core facts.

- [ ] Write mapper/token/document/resource and SDK sink tests first.
- [ ] Run focused tests and observe RED.
- [ ] Implement minimal mapping strategies and injected Feishu document client.
- [ ] Run focused tests, SDK tests, and typecheck.
- [ ] Commit `feat: map Feishu participants and resources`.

## Task 7: Feishu OpenAPI and outbound SignalAdapter

**Files**

- Create `packages/connector-feishu/src/token-provider.ts`
- Create `packages/connector-feishu/src/open-api-client.ts`
- Create `packages/connector-feishu/src/event-renderer.ts`
- Create `packages/connector-feishu/src/signal-adapter.ts`
- Modify `packages/connector-feishu/src/index.ts`
- Create `packages/connector-feishu/test/token-provider.test.ts`
- Create `packages/connector-feishu/test/open-api-client.test.ts`
- Create `packages/connector-feishu/test/signal-adapter.test.ts`

**Delivery rules**

- validate destination without accepting secrets or tokens;
- map bounded public events to text/card, with no internal/private fields;
- generate deterministic Feishu `uuid` within the documented length;
- cache tenant token with expiry skew and single-flight refresh;
- retry once after an expired-token response, preserving the same UUID;
- classify network/timeout/429/5xx as retryable and invalid recipient,
  unsupported rendering, or confirmed permission denial as permanent;
- return a valid Feishu message identifier before reporting accepted;
- sanitize API bodies and headers from errors/logs.

- [ ] Write renderer, UUID, token concurrency, refresh, timeout, classification,
  and `SignalAdapter` profile tests.
- [ ] Run focused tests and observe RED.
- [ ] Implement with injected `fetch`, clock, credential provider, and token
  cache. Do not import the SDK into Exchange Runtime.
- [ ] Run focused tests, signal profile, typecheck, and delivery runtime tests.
- [ ] Commit `feat: deliver Work Fabric events through Feishu`.

## Task 8: HTTP webhook and optional long-connection event sources

**Files**

- Create `packages/transport-http/src/routes/feishu-webhook-route.ts`
- Modify `packages/transport-http/src/config.ts`
- Modify `packages/transport-http/src/create-http-service.ts`
- Modify `packages/transport-http/src/index.ts`
- Create `packages/transport-http/test/feishu-webhook-route.test.ts`
- Create `packages/connector-feishu/src/long-connection-source.ts`
- Create `packages/connector-feishu/test/long-connection-source.test.ts`

**Binding rules**

- route scope is bound from trusted deployment config;
- raw-body/body/decompression bounds run before parsing;
- challenge response bypasses ingress;
- event response is success only after durable `accept()`;
- duplicate response is also success with no new worker action;
- store failure returns a retryable status inside a bounded timeout;
- route never waits for mapper, SDK, or Feishu outbound API;
- long connection implements a narrow injected SDK facade and invokes the same
  codec/normalizer/acceptor; it contains no event mapping switch.

- [ ] Write Fastify injection tests that prove durable acceptance ordering,
  challenge handling, security rejection, duplicate behavior, and latency
  independence; write fake-SDK long-connection tests.
- [ ] Run focused tests and observe RED.
- [ ] Implement optional route/source composition with no mandatory production
  credential in the default HTTP service.
- [ ] Run focused transport/connector tests and typecheck.
- [ ] Commit `feat: expose Feishu Connector event sources`.

## Task 9: Reconciliation, end-to-end proof, docs, and final gates

**Files**

- Create `packages/connector-runtime/src/reconciliation.ts`
- Create `packages/connector-runtime/test/reconciliation.test.ts`
- Create `packages/connector-feishu/test/feishu-roundtrip.integration.test.ts`
- Create `examples/feishu-connector/README.md`
- Create `examples/feishu-connector/config.example.json`
- Modify `README.md`
- Modify `docs/architecture.md`
- Create `docs/roadmap.md`
- Create `docs/feishu-customer-lifecycle-example.md`
- Modify `docs/superpowers/specs/2026-07-15-exchange-production-expansion-design.md`

**End-to-end proof**

1. signed received-message/card callback is durably accepted once;
2. worker resolves an existing human identity and submits one explicit SDK
   operation with connector-derived idempotency;
3. Exchange commits and the existing subscription dispatcher invokes the
   Feishu SignalAdapter;
4. card acknowledgement maps back to one version-checked command;
5. document reference retains revision metadata while raw content and secrets
   remain outside Exchange facts;
6. injected drift creates a visible discrepancy observation and never mutates
   either system silently.

- [ ] Write the integration test and reconciliation tests first.
- [ ] Run focused tests and observe RED.
- [ ] Implement comparison-only reconciliation and finish the fake-Feishu
  roundtrip harness.
- [ ] Update architecture, roadmap status, setup/secret/permission/retention
  guidance, and the customer lifecycle example.
- [ ] Run `git diff --check`.
- [ ] Run `npm run typecheck`.
- [ ] Run all Connector, HTTP, SDK, runtime, Memory, and PostgreSQL focused
  tests.
- [ ] Run `npm run verify:exchange` and require WFPP conformance 120/120.
- [ ] Run dependency guards and search tracked code/log fixtures for secret
  names or real credentials.
- [ ] Review the branch against the design's acceptance and non-goals, then
  commit `docs: complete Phase 4B Feishu Connector`.

## Completion rule

Do not mark Phase 4B complete merely because the happy path works. Completion
requires the shared Memory/PostgreSQL profile, fenced recovery, verified and
bounded ingress, SDK-only public writes, existing SignalDispatcher outbound
delivery, identity/action authority checks, reference-only document handling,
inspectable failure state, full verification, and an architecture review that
confirms Work Fabric remains a connection and handoff fabric rather than an
automation brain.
