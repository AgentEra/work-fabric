# Long-lived Local Debug Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, development-only `collaboration-channel.debug` plugin that injects protocol-valid messages through the real Work Fabric ingress and Handoff path, captures routed Result events, and provides deterministic local and CI end-to-end testing.

**Architecture:** The Debug Channel is a standard `channel` Citizen outside Exchange Core. A loopback-only HTTP transport persists a submission, accepts one Connector Ingress envelope, maps it through the normal Identity/Admission/Authority command path, records the Handoff route, and captures the resulting canonical Signal event in a debug-only store. Memory and SQLite implement one narrow storage port; service-node only composes these implementations and local tools only consume HTTP contracts.

**Tech Stack:** TypeScript 7, Node.js 22 `node:http` and `node:sqlite`, Vitest 4, existing Work Fabric Plugin/Connector/Channel/Exchange SPIs, YAML Configuration Provider, Agently Python Worker, deterministic local OpenAI-compatible model fixture.

## Global Constraints

- The plugin type is exactly `collaboration-channel.debug` and the Citizen kind is `channel`.
- Debug HTTP listens only on `127.0.0.0/8` or `::1`; `localhost`, wildcard and non-loopback hosts fail closed.
- An enabled Debug Channel requires `service.development_mode: true` and a non-empty resolved Bearer token.
- Core, protocol schemas, Agent Runtime and existing Channels must not depend on Debug Channel packages.
- The HTTP caller supplies only `participant_ref`; trusted configuration owns identity mode, subject, Actor, Endpoint and Admission policy.
- Supported input is the existing WFPP `ContentPart` union: `text`, `data` and `resource`. Invalid content creates no ingress.
- The Channel never understands intent, selects a receiver, accepts work, calls a model, invokes a capability or authors a semantic reply.
- Submission idempotency is scoped by tenant, plugin instance, conversation and idempotency key.
- Capture idempotency is scoped by tenant, plugin instance, event ID and destination ID.
- `memory-demo` may lose records on restart; `sqlite-local` must persist them and must not fall back to memory.
- Logs, metrics, health and error details must not contain content, typed data values, resource credentials, tokens, prompts or Agent output.
- Every query has a hard limit and deterministic cursor/order; request size, part count, text bytes and JSON depth are bounded.
- Implementation is TDD: every production increment starts with a focused failing test, passes it, and commits an independently reviewable change.

---

## File and Package Map

### New packages

- `packages/debug-channel-spi/`: canonical debug submission/capture/store contracts, validation and store contract tests.
- `packages/adapter-debug-channel-memory/`: isolated deterministic memory store.
- `packages/adapter-debug-channel-sqlite/`: durable SQLite store and migration using the deployment-owned SQLite session.
- `packages/plugin-channel-debug/`: configuration, message normalization, participant resolution, ingress mapping, receipt routing, Signal capture, HTTP transport and plugin lifecycle.

### Existing packages and composition

- `packages/service-node/src/compose.ts`: inject development mode, debug stores, Handoff snapshots and both plugin factories.
- `packages/service-node/src/configuration-loader.ts`: validate the debug plugin and resolve only its declared token path.
- `packages/service-node/test/`: composition, configuration, lifecycle and process-boundary integration tests.
- `packages/plugin-runtime/`: no API change unless a focused test proves lifecycle semantics are missing.

### Local operator surface

- `tools/local-debug-common.ts`: environment/config and state paths.
- `tools/local-debug-stack.ts`: start and stop the composed local processes.
- `tools/local-debug-status.ts`: PID-independent real health checks.
- `tools/local-debug-send.ts`: authenticated HTTP submit/query client.
- `tools/local-debug-e2e.ts`: deterministic complete collaboration scenario.
- `examples/config/local-debug-assistant.bundle.yaml`: no literal secrets.
- `examples/debug-channel/requests/`: plain, Markdown, data and resource examples.

### Documentation

- `docs/architecture/network-citizens.md`
- `docs/configuration.md` or the repository's canonical configuration reference.
- `docs/guides/local-debug-channel.md`
- `docs/roadmap.md`
- `README.md`

---

### Task 1: Define the Debug Channel SPI and contract suite

**Files:**
- Create: `packages/debug-channel-spi/package.json`
- Create: `packages/debug-channel-spi/src/contracts.ts`
- Create: `packages/debug-channel-spi/src/validation.ts`
- Create: `packages/debug-channel-spi/src/index.ts`
- Create: `packages/debug-channel-spi/test/contracts.test.ts`
- Create: `packages/debug-channel-spi/test/store-contract.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `CapabilityManifest`, `ExchangeAdapter`, `JsonObject`,
  `JsonValue`, `ProtocolEvent` and the existing WFPP content-part schema.
- Produces:

```ts
export interface DebugSubmission {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly submission_id: string;
  readonly conversation_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly ingress_id?: string;
  readonly handoff_id?: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
}

export interface DebugCapture {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly capture_id: string;
  readonly conversation_id: string;
  readonly event_id: string;
  readonly destination_id: string;
  readonly event: ProtocolEvent;
  readonly captured_at: string;
  readonly expires_at: string;
}

export interface DebugChannelStore extends ExchangeAdapter {
  createSubmission(input: CreateDebugSubmission): Promise<
    | { readonly kind: "created"; readonly submission: DebugSubmission }
    | { readonly kind: "existing"; readonly submission: DebugSubmission }
    | { readonly kind: "conflict"; readonly submission: DebugSubmission }
  >;
  linkIngress(input: LinkDebugIngress): Promise<DebugSubmission>;
  linkHandoff(input: LinkDebugHandoff): Promise<DebugSubmission>;
  getSubmission(scope: DebugSubmissionScope): Promise<DebugSubmission | null>;
  appendCapture(input: AppendDebugCapture): Promise<
    { readonly kind: "created" | "existing"; readonly capture: DebugCapture }
  >;
  getCapture(scope: DebugCaptureScope): Promise<DebugCapture | null>;
  listCaptures(query: ListDebugCaptures): Promise<DebugCapturePage>;
  pruneExpired(input: PruneExpiredDebugRecords): Promise<{
    readonly submissions: number;
    readonly captures: number;
  }>;
}
```

- [x] **Step 1: Write failing validation and store-contract tests**

Create table-driven tests that reject unknown fields, empty or overlong IDs,
invalid timestamps, non-JSON event payloads, cross-scope returns and limits
outside `1..100`. Define `runDebugChannelStoreContract(createStore)` to prove
identical-create, conflicting-create, one-way Ingress and Handoff linking,
idempotent capture, deterministic pagination, payload isolation and bounded
pruning.

```ts
it("returns conflict when one idempotency identity is reused with another digest", async () => {
  const store = await fixture.createStore();
  expect((await store.createSubmission(submission("digest-a"))).kind).toBe("created");
  expect((await store.createSubmission(submission("digest-b"))).kind).toBe("conflict");
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/debug-channel-spi/test
```

Expected: FAIL because the package and exported contracts do not exist.

- [x] **Step 3: Implement immutable contracts and strict validators**

Implement exact-field validation, bounded identifiers, ISO timestamp checks,
safe JSON cloning, deterministic manifest creation and typed store errors:

```ts
export class DebugChannelStoreError extends Error {
  constructor(readonly code:
    | "idempotency_conflict"
    | "ingress_conflict"
    | "handoff_conflict"
    | "capture_conflict"
    | "invalid_cursor") {
    super(code);
    this.name = "DebugChannelStoreError";
  }
}
```

The SPI contains no Node, SQLite, HTTP, YAML or plugin-runtime imports.

- [x] **Step 4: Run tests and typecheck**

Run:

```bash
npx vitest run packages/debug-channel-spi/test
npm run typecheck
```

Expected: all focused tests PASS and TypeScript exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/debug-channel-spi package-lock.json
git commit -m "feat(debug): define channel diagnostic contracts"
```

---

### Task 2: Implement memory and SQLite debug stores

**Files:**
- Create: `packages/adapter-debug-channel-memory/package.json`
- Create: `packages/adapter-debug-channel-memory/src/memory-debug-channel-store.ts`
- Create: `packages/adapter-debug-channel-memory/src/index.ts`
- Create: `packages/adapter-debug-channel-memory/test/memory-debug-channel-store.test.ts`
- Create: `packages/adapter-debug-channel-sqlite/package.json`
- Create: `packages/adapter-debug-channel-sqlite/migrations/001_debug_channel.sql`
- Create: `packages/adapter-debug-channel-sqlite/src/migrations.ts`
- Create: `packages/adapter-debug-channel-sqlite/src/sqlite-debug-channel-store.ts`
- Create: `packages/adapter-debug-channel-sqlite/src/index.ts`
- Create: `packages/adapter-debug-channel-sqlite/test/sqlite-debug-channel-store.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `DebugChannelStore` from Task 1 and `SqliteSession` from `@work-fabric/adapter-storage-sqlite`.
- Produces: `MemoryDebugChannelStore`, `SqliteDebugChannelStore` and `migrateDebugChannelSqlite(session)`.

- [x] **Step 1: Bind both adapters to the shared contract suite**

```ts
runDebugChannelStoreContract({
  async createStore() {
    return new MemoryDebugChannelStore();
  },
});
```

The SQLite fixture creates a temporary `SqliteSession`, runs
`migrateDebugChannelSqlite`, closes it after each test, reopens the same file
for the restart case, and proves records survive.

- [x] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npx vitest run packages/adapter-debug-channel-memory/test packages/adapter-debug-channel-sqlite/test
```

Expected: FAIL because the adapters and migration do not exist.

- [x] **Step 3: Implement the memory adapter**

Use maps keyed by NUL-separated tenant/plugin/id scopes, `structuredClone` on
every boundary, canonical request digest comparison and deterministic sorting
by `(captured_at, capture_id)`. `linkIngress` and `linkHandoff` are idempotent
for the same ID and throw their scoped conflict error for a different ID.

- [x] **Step 4: Implement the SQLite migration and adapter**

Create normalized submission and capture tables with:

```sql
UNIQUE (tenant_id, plugin_instance_id, conversation_id, idempotency_key)
UNIQUE (tenant_id, plugin_instance_id, event_id, destination_id)
```

Persist canonical request/event JSON plus indexed scope and timestamps. Use
transactions for create-or-read, Ingress linking and Handoff linking. Validate
decoded JSON before returning it. Pruning deletes at most `limit` captures
then submissions whose expiry is at or before the supplied timestamp and
returns exact counts.

- [x] **Step 5: Run contract, restart and migration checksum tests**

Run:

```bash
npx vitest run packages/adapter-debug-channel-memory/test packages/adapter-debug-channel-sqlite/test
npm run typecheck
```

Expected: all focused tests PASS; reopening SQLite returns the same submission
and capture; rerunning migration applies zero changes.

- [x] **Step 6: Commit**

```bash
git add packages/adapter-debug-channel-memory packages/adapter-debug-channel-sqlite package-lock.json
git commit -m "feat(debug): persist local channel diagnostics"
```

---

### Task 3: Validate Debug Channel configuration and normalize input

**Files:**
- Create: `packages/plugin-channel-debug/package.json`
- Create: `packages/plugin-channel-debug/src/config.ts`
- Create: `packages/plugin-channel-debug/src/content.ts`
- Create: `packages/plugin-channel-debug/src/participant-resolver.ts`
- Create: `packages/plugin-channel-debug/src/index.ts`
- Create: `packages/plugin-channel-debug/test/config.test.ts`
- Create: `packages/plugin-channel-debug/test/content.test.ts`
- Create: `packages/plugin-channel-debug/test/participant-resolver.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `CollaborationAdmissionService`, WFPP content schemas, existing JSON types and configuration snapshots.
- Produces:

```ts
export interface DebugPluginConfig {
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly credentials: { readonly bearer_token: string };
  readonly intake_target: { readonly actor_id: string; readonly endpoint_id: string };
  readonly participants: Readonly<Record<string, DebugParticipantConfig>>;
  readonly limits: DebugHttpLimits;
  readonly retention: { readonly max_age_days: number; readonly cleanup_batch_size: number };
}

export function validateDebugPluginConfig(value: unknown): DebugPluginConfig;
export function debugSecretPaths(prefix: string, config: DebugPluginConfig): readonly string[];
export function normalizeDebugMessage(value: unknown, limits: DebugHttpLimits): DebugMessage;
```

- [x] **Step 1: Write strict config and content tests**

Cover exact fields, `connector_id === instance_id`, literal loopback IP
validation, port range `1..65535`, token presence, static/admission participant
discriminators, duplicate external subjects, valid mixed content, UTF-8 byte
limits, JSON depth and forbidden prototype keys.

```ts
expect(() => validateDebugPluginConfig({
  ...validConfig(),
  listen: { host: "localhost", port: 8791 },
})).toThrow("listen.host must be a loopback IP address");
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/config.test.ts packages/plugin-channel-debug/test/content.test.ts packages/plugin-channel-debug/test/participant-resolver.test.ts
```

Expected: FAIL because the validator and resolvers do not exist.

- [x] **Step 3: Implement config and content normalization**

Validate `text`, `data` and `resource` parts against the existing protocol
schema validator or an equivalent strict local validator that uses the exact
WFPP contract. Canonicalize the request with the repository canonical JSON
utility and compute SHA-256 for idempotency comparison. Do not coerce unknown
media types or data schemas.

- [x] **Step 4: Implement the two participant paths**

`StaticDebugParticipantResolver` returns only the trusted configured tuple.
`AdmissionDebugParticipantResolver` calls:

```ts
admission.admit(participant.policy_id, {
  tenant_id,
  connector_id,
  source_system: "workfabric-debug",
  external_tenant_id,
  external_subject_type: participant.external_subject_type,
  external_subject_id: participant.external_subject_id,
  ingress_id: claim.ingress_id,
  idempotency_key,
});
```

Validate policy/scope/binding/grant exactly as the Feishu resolver does. Deny,
temporary failure and malformed grants remain distinct outcomes.

- [x] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/config.test.ts packages/plugin-channel-debug/test/content.test.ts packages/plugin-channel-debug/test/participant-resolver.test.ts
npm run typecheck
```

Expected: all focused tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/plugin-channel-debug package-lock.json
git commit -m "feat(debug): validate channel fixtures and content"
```

---

### Task 4: Map debug ingress through the real Handoff command path

**Files:**
- Create: `packages/plugin-channel-debug/src/ingress-normalizer.ts`
- Create: `packages/plugin-channel-debug/src/event-mapper.ts`
- Create: `packages/plugin-channel-debug/test/ingress-normalizer.test.ts`
- Create: `packages/plugin-channel-debug/test/event-mapper.test.ts`
- Modify: `packages/plugin-channel-debug/src/index.ts`

**Interfaces:**
- Consumes: `ConnectorIngressStore`, `ConnectorEventMapper`,
  `ConnectorCommandDescriptor`, the participant resolvers from Task 3 and the
  configured assistant intake target.
- Produces:

```ts
export function debugMessageIngress(input: DebugMessageIngressInput): ConnectorIngressEnvelope;

export class DebugEventMapper implements ConnectorEventMapper {
  readonly manifest: CapabilityManifest;
  map(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome>;
}
```

- [x] **Step 1: Write failing normalization and mapping tests**

Prove deterministic `source_system: "workfabric-debug"`, event type
`debug.message.receive_v1`, dedupe identity, preserved mixed content, target
Actor/Endpoint, stable `handoff.offer` idempotency key, Authority scope and
static/admission authentication behavior. Prove malformed payload,
unconfigured participant and denied Admission never produce a command.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/ingress-normalizer.test.ts packages/plugin-channel-debug/test/event-mapper.test.ts
```

Expected: FAIL because the normalizer and mapper do not exist.

- [x] **Step 3: Implement the ingress envelope**

The HTTP transport generates a bounded opaque `submission_id`; the envelope
uses it as `external_event_id` and includes only:

```ts
{
  submission_id,
  conversation_id,
  participant_ref,
  content
}
```

No token, raw Authority claim or resolved Actor is stored in the payload.

- [x] **Step 4: Implement `DebugEventMapper`**

Resolve the configured participant, construct exactly one `handoff.offer`
command compatible with the existing command sink, target the configured
decision body and attach a representation grant only for Admission mode.
Return stable permanent/retryable reason codes owned by the mapper.

- [x] **Step 5: Run focused and Connector Worker integration tests**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/ingress-normalizer.test.ts packages/plugin-channel-debug/test/event-mapper.test.ts packages/connector-runtime/test/connector-worker.test.ts
npm run typecheck
```

Expected: all tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/plugin-channel-debug
git commit -m "feat(debug): map local messages into handoffs"
```

---

### Task 5: Record routes and capture outbound Signal events

**Files:**
- Create: `packages/plugin-channel-debug/src/intake-receipt-handler.ts`
- Create: `packages/plugin-channel-debug/src/signal-adapter.ts`
- Create: `packages/plugin-channel-debug/test/intake-receipt-handler.test.ts`
- Create: `packages/plugin-channel-debug/test/signal-adapter.test.ts`
- Modify: `packages/plugin-channel-debug/src/index.ts`

**Interfaces:**
- Consumes: `ChannelRouteStore`, `SubscriptionStore`, `DebugChannelStore`,
  `ConnectorAcceptedReceiptHandler` and `SignalAdapter`.
- Produces: `DebugIntakeReceiptHandler` and `DebugRouteAwareSignalAdapter`.

- [x] **Step 1: Write failing route and capture tests**

Prove route-before-subscription ordering, Handoff-to-conversation isolation,
submission Handoff linking, one subscription for
`workfabric.handoff.result_returned.v1`, missing-route failure, exact canonical
event preservation and duplicate Signal delivery returning the same capture.

```ts
expect(await adapter.deliver(event, destination)).toEqual({ kind: "accepted" });
expect((await store.listCaptures(query)).items).toHaveLength(1);
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/intake-receipt-handler.test.ts packages/plugin-channel-debug/test/signal-adapter.test.ts
```

Expected: FAIL because receipt and Signal adapters do not exist.

- [x] **Step 3: Implement receipt routing**

Follow the Feishu receipt handler's ordering and idempotency semantics, but
read `conversation_id` and `submission_id` from the debug ingress payload.
Persist the `ChannelRoute`, link the submission to the accepted Handoff, then
put the filtered runtime subscription. Wake the Handoff projection after the
route is durable.

- [x] **Step 4: Implement canonical capture**

Resolve the route by tenant/plugin/Handoff, reject destination or event scope
mismatch, derive a stable capture ID from event and destination identity, and
append the unmodified event. Map store availability to retryable failure and
invalid/cross-scope data to permanent failure without logging content.

- [x] **Step 5: Run tests and typecheck**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/intake-receipt-handler.test.ts packages/plugin-channel-debug/test/signal-adapter.test.ts
npm run typecheck
```

Expected: all focused tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/plugin-channel-debug
git commit -m "feat(debug): route and capture collaboration results"
```

---

### Task 6: Build the authenticated loopback HTTP transport

**Files:**
- Create: `packages/plugin-channel-debug/src/http-errors.ts`
- Create: `packages/plugin-channel-debug/src/http-server.ts`
- Create: `packages/plugin-channel-debug/src/status-source.ts`
- Create: `packages/plugin-channel-debug/test/http-server.test.ts`
- Modify: `packages/plugin-channel-debug/src/index.ts`

**Interfaces:**
- Consumes: `ConnectorIngressStore`, `DebugChannelStore`, a narrow
  `DebugHandoffSnapshotSource`, clock, `DebugIdSource`, cursor codec and
  validated config.
- Produces:

```ts
export interface DebugHandoffSnapshotSource {
  load(tenantId: string, handoffId: string): Promise<{
    readonly version: number;
    readonly lifecycle_state: string;
  } | null>;
}

export interface DebugIdSource {
  requestId(): string;
  submissionId(): string;
}

export class DebugChannelHttpServer {
  start(): Promise<{ readonly host: string; readonly port: number }>;
  health(): { readonly state: "healthy" | "degraded"; readonly code: string };
  stop(): Promise<void>;
}
```

- [x] **Step 1: Write failing HTTP contract tests**

Use a real ephemeral loopback port. Cover health, missing/wrong token,
constant-time credential path, submit `202`, identical replay, conflict `409`,
invalid request `400`, unknown participant `403`, body limit `413`, submission
query, capture pagination, capture lookup, method `405`, unknown path `404`,
JSON content type and no content in error bodies/log probes.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/http-server.test.ts
```

Expected: FAIL because the HTTP server does not exist.

- [x] **Step 3: Implement request parsing and authentication**

Use `node:http`, read no more than `max_request_bytes`, require
`application/json`, compare SHA-256 token digests with `timingSafeEqual`, set
bounded request timeouts and produce stable JSON errors:

```json
{
  "error": {
    "code": "invalid_request",
    "request_id": "debug_request_..."
  }
}
```

Do not echo input, token or validation details.

- [x] **Step 4: Implement submit and query handlers**

Create the submission before accepting ingress, use the submission ID as the
external event ID, persist the resulting ingress ID, and return only stable
correlation/status facts. Query ingress and Handoff state from owning stores;
do not create a parallel success state.

- [x] **Step 5: Implement deterministic pagination and graceful stop**

Inject `OpaqueCursorCodec` from `@work-fabric/operations-spi`, created by
service-node from `service.cursor_secret`. Encode the tenant, plugin instance,
conversation and last `(captured_at, capture_id)` tuple; reject a cursor whose
scope differs from the request. Stop accepting new requests, drain active
requests within a fixed timeout, then close the listener.

- [x] **Step 6: Run tests and typecheck**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/http-server.test.ts
npm run typecheck
```

Expected: all focused tests PASS.

- [x] **Step 7: Commit**

```bash
git add packages/plugin-channel-debug
git commit -m "feat(debug): expose loopback diagnostic API"
```

---

### Task 7: Implement plugin lifecycle and Service composition

**Files:**
- Create: `packages/plugin-channel-debug/src/debug-plugin-factory.ts`
- Create: `packages/plugin-channel-debug/test/debug-plugin-factory.test.ts`
- Modify: `packages/plugin-channel-debug/src/index.ts`
- Modify: `packages/service-node/package.json`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/src/configuration-loader.ts`
- Modify: `packages/service-node/test/plugin-composition.integration.test.ts`
- Modify: `packages/service-node/test/global-configuration.test.ts`
- Modify: `packages/service-node/test/main-lifecycle.integration.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: all plugin components from Tasks 3–6 and service locator
  capabilities `workfabric.development_mode`, `debug.channel_store`,
  `debug.handoff_snapshots`, `connector.ingress`, `connector.command_sink`,
  `channel.routes`, `exchange.subscriptions`, `channel.signal_registry`,
  `collaboration.admission`, `runtime.clock`, `runtime.debug_ids`,
  `runtime.debug_cursor` and `runtime.handoff_wakeup`.
- Produces: `DebugPluginFactory implements PluginFactory`.

- [x] **Step 1: Write failing plugin lifecycle tests**

Cover validation, production-mode refusal, connector/instance mismatch,
prepare-without-listen, start binding, worker health, port conflict,
registration rollback, stop idempotency, adapter unregistration and resource
cleanup after partial startup failure.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test/debug-plugin-factory.test.ts packages/service-node/test/plugin-composition.integration.test.ts packages/service-node/test/global-configuration.test.ts
```

Expected: FAIL because the factory is not registered or composed.

- [x] **Step 3: Implement `DebugPluginFactory`**

Build the mapper, receipt handler, Connector Worker, route-aware Signal
Adapter and HTTP server only from injected capabilities. `prepare` registers
the Signal Adapter; `start` starts worker scheduling and HTTP; `stop` drains
HTTP, waits for the active worker turn and unregisters deterministically.

- [x] **Step 4: Compose memory and SQLite stores**

For `memory-demo`, inject `MemoryDebugChannelStore`. For `sqlite-local`, run
`migrateDebugChannelSqlite` on the same owned `SqliteSession` and inject
`SqliteDebugChannelStore`. Add `workfabric.development_mode` and a narrow
Handoff snapshot source. Do not expose Debug HTTP routes on the primary server.

- [x] **Step 5: Register configuration and secret paths**

Register both Feishu and Debug plugin validators. Collect only:

```text
plugins.instances.<enabled-debug-instance>.config.credentials.bearer_token
```

through the existing Configuration Service and Environment Secret Resolver.
Disabled instances do not require their environment secret.

- [x] **Step 6: Run lifecycle, configuration and composition tests**

Run:

```bash
npx vitest run packages/plugin-channel-debug/test packages/service-node/test/plugin-composition.integration.test.ts packages/service-node/test/global-configuration.test.ts packages/service-node/test/main-lifecycle.integration.test.ts
npm run typecheck
npm run check:plugin-boundaries
npm run check:sensitive-observability
```

Expected: all tests and boundary checks PASS with zero violations.

- [x] **Step 7: Commit**

```bash
git add packages/plugin-channel-debug packages/service-node package-lock.json
git commit -m "feat(debug): compose development channel plugin"
```

---

### Task 8: Add long-lived local operator tools and examples

**Files:**
- Create: `tools/local-debug-common.ts`
- Create: `tools/local-debug-stack.ts`
- Create: `tools/local-debug-status.ts`
- Create: `tools/local-debug-send.ts`
- Create: `tools/local-debug-stack.test.ts`
- Create: `tools/local-debug-send.test.ts`
- Create: `examples/config/local-debug-assistant.bundle.yaml`
- Create: `examples/debug-channel/requests/plain.json`
- Create: `examples/debug-channel/requests/markdown.json`
- Create: `examples/debug-channel/requests/data.json`
- Create: `examples/debug-channel/requests/resource.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: the versioned Debug HTTP API and existing local Agent Runtime
  startup entry points.
- Produces scripts `local:debug:start`, `local:debug:status`,
`local:debug:send`, `local:debug:stop`, `local:debug:e2e`.
Both start and stop use `tools/local-debug-stack.ts`; the stop script passes
the explicit `--stop` operation.

- [x] **Step 1: Write failing tool tests**

Test environment-file loading, exact config path handling, secret redaction,
PID record format, child discovery, health-based status, shutdown escalation,
JSON-file send, polling timeout and HTTP failure exit codes. Use fake child
processes and ephemeral HTTP servers; never contact a real model.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run tools/local-debug-stack.test.ts tools/local-debug-send.test.ts
```

Expected: FAIL because tools and scripts do not exist.

- [x] **Step 3: Implement common configuration and lifecycle**

Reuse the safe `.env` parsing model from `local-feishu-common.ts`, but use
debug-specific state files and ports. Record process group plus discovered
real child PIDs. Status must combine liveness with `/health/ready`, Debug
`/health` and Agent Runtime health rather than trusting an exited npm wrapper.

- [x] **Step 4: Implement the HTTP client**

Require `--file`, `--conversation` and token from environment, submit once,
print IDs and optionally poll `--wait-ms` for Handoff/capture facts. Output
contains no token and does not print request content unless `--show-content`
is explicitly supplied.

- [x] **Step 5: Add safe bundle and request examples**

The bundle uses `${WORK_FABRIC_DEBUG_TOKEN}` and existing model/token
references; it contains no secret values. Include static test identity,
Authority rules, assistant endpoint and debug plugin settings. Example
resource URLs contain no credentials.

- [x] **Step 6: Run tool tests and a dry local start/status/stop**

Run:

```bash
npx vitest run tools/local-debug-stack.test.ts tools/local-debug-send.test.ts
npm run local:debug:start -- --dry-run
npm run local:debug:status -- --state-file /private/tmp/nonexistent-debug-state.json
npm run typecheck
```

Expected: tests PASS; dry run prints only component names and bounded paths;
missing status exits nonzero with `not_running`.

- [x] **Step 7: Commit**

```bash
git add tools examples/config/local-debug-assistant.bundle.yaml examples/debug-channel package.json
git commit -m "feat(debug): add local channel tooling"
```

---

### Task 9: Run one deterministic complete Agent collaboration E2E

**Files:**
- Create: `packages/service-node/test/debug-channel.e2e.test.ts`
- Create: `tools/local-debug-e2e.ts`
- Create: `tools/local-debug-e2e.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: real Node service composition, real Debug Channel HTTP, real
  Connector Worker, real SQLite stores, real Daily Assistant Runtime boundary,
  Agently Worker and existing deterministic OpenAI-compatible model fixture.
- Produces: one deterministic release-gate command and a machine-readable
  summary containing only safe identifiers/states.

- [x] **Step 1: Write the failing process-level E2E**

The test submits Markdown plus typed data, waits for exactly one Handoff,
returns one Agent-authored `text/markdown` Result containing:

```md
已完成 EDA 摘要：[查看资料](https://example.com/eda)
```

Then assert one captured canonical Result event, restart the service with the
same SQLite file, query the same IDs, replay the same idempotency key and
assert no second Handoff or capture.

- [x] **Step 2: Run E2E and verify RED**

Run:

```bash
npx vitest run packages/service-node/test/debug-channel.e2e.test.ts tools/local-debug-e2e.test.ts
```

Expected: FAIL until the stack client and correlation polling are complete.

- [x] **Step 3: Implement the deterministic E2E runner**

Use bounded deadlines and exponential polling capped at 250 ms. On failure,
print only component health, submission ID, ingress state, Handoff state,
capture count and stable failure code. Always close Agent, plugin host, HTTP
service, model fixture and SQLite session in reverse ownership order.

- [x] **Step 4: Add negative-path E2E cases**

Prove invalid content creates no ingress, Admission denial creates no Handoff,
missing Authority fails through the command sink, wrong token receives `401`,
and production/non-loopback configurations never listen.

- [x] **Step 5: Run deterministic E2E repeatedly**

Run:

```bash
npx vitest run packages/service-node/test/debug-channel.e2e.test.ts tools/local-debug-e2e.test.ts
npm run local:debug:e2e
npm run local:debug:e2e
```

Expected: all tests PASS twice with different temporary directories and no
port, process or SQLite lock leak.

- [x] **Step 6: Commit**

```bash
git add packages/service-node/test/debug-channel.e2e.test.ts tools/local-debug-e2e.ts tools/local-debug-e2e.test.ts package.json
git commit -m "test(debug): verify complete local collaboration"
```

---

### Task 10: Document operation, architecture and troubleshooting

**Files:**
- Modify: `docs/architecture/network-citizens.md`
- Modify: `docs/architecture.md`
- Create: `docs/guides/local-debug-channel.md`
- Modify: `docs/roadmap.md`
- Modify: `README.md`
- Create: `tools/local-debug-documentation.test.ts`

**Interfaces:**
- Consumes: final commands, configuration and error codes from Tasks 1–9.
- Produces: canonical long-lived local usage and troubleshooting guidance.

- [x] **Step 1: Write documentation acceptance assertions**

Extend the appropriate documentation test or add
`tools/local-debug-documentation.test.ts` to assert the guide contains the
five commands, loopback/development warning, content-part examples, static and
Admission identity paths, SQLite restart behavior and the seven-layer
troubleshooting table.

- [x] **Step 2: Run documentation test and verify RED**

Run:

```bash
npx vitest run tools/local-debug-documentation.test.ts
```

Expected: FAIL until documentation is complete.

- [x] **Step 3: Update architecture and Citizen rules**

Document that Debug Channel is a development-only `channel` Citizen, not an
observer, decision body or capability provider. Reaffirm that it does not
change Core and that canonical captures are diagnostic copies, not
authoritative collaboration state.

- [x] **Step 4: Write setup and troubleshooting guide**

Document token generation, environment/config selection, start, health,
plain/Markdown/data/resource send, result query, stop, retention and cleanup.
Use a table with distinct ownership:

```text
HTTP -> Ingress -> Identity/Admission -> Authority -> Handoff -> Agent -> Signal/Capture
```

For each layer give the observable safe state and owning module; do not
recommend patching another layer to compensate.

- [x] **Step 5: Update roadmap and README**

Mark the long-lived local debug channel complete only after Task 9 passes.
Link to the guide and show the shortest safe first-run sequence.

- [x] **Step 6: Run documentation tests**

Run:

```bash
npx vitest run tools/local-debug-documentation.test.ts
git diff --check
```

Expected: PASS and no whitespace errors.

- [x] **Step 7: Commit**

```bash
git add docs README.md tools/local-debug-documentation.test.ts
git commit -m "docs(debug): guide long-lived local testing"
```

---

### Task 11: Full regression, boundary review and final local simulation

**Files:**
- Modify only files required to fix regressions caused by Tasks 1–10.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: verified branch state and a concise E2E evidence record.

- [x] **Step 1: Run focused package and E2E suites**

```bash
npx vitest run packages/debug-channel-spi/test packages/adapter-debug-channel-memory/test packages/adapter-debug-channel-sqlite/test packages/plugin-channel-debug/test packages/service-node/test/debug-channel.e2e.test.ts tools/local-debug-stack.test.ts tools/local-debug-send.test.ts tools/local-debug-e2e.test.ts tools/local-debug-documentation.test.ts
```

Expected: zero failures.

- [x] **Step 2: Run project-wide verification**

```bash
npm run typecheck
npm test
npm run conformance
npm run check:plugin-boundaries
npm run check:admission-boundaries
npm run check:sensitive-observability
npm run verify:agent-runtime
git diff --check
```

Expected: all commands PASS; environment-gated PostgreSQL/NATS/live-channel
tests may remain explicitly skipped, never silently converted to passes.

- [x] **Step 3: Start the local stack and submit all example formats**

Use a fresh temporary SQLite file and token:

```bash
npm run local:debug:start
npm run local:debug:send -- --conversation plain --file examples/debug-channel/requests/plain.json --wait-ms 30000
npm run local:debug:send -- --conversation markdown --file examples/debug-channel/requests/markdown.json --wait-ms 30000
npm run local:debug:send -- --conversation data --file examples/debug-channel/requests/data.json --wait-ms 30000
npm run local:debug:send -- --conversation resource --file examples/debug-channel/requests/resource.json --wait-ms 30000
npm run local:debug:status
npm run local:debug:stop
```

Expected: every supported target input has one correlated outcome; unsupported
target input reports the owning failure; status is healthy while running and
all ports/processes are released after stop.

- [x] **Step 4: Inspect repository state and security output**

```bash
git status --short
git log --oneline --decorate -12
git diff --check
```

Confirm no `.env`, SQLite database, PID/state file, model response, debug
capture or secret is tracked.

- [x] **Step 5: Commit only necessary regression fixes**

If a regression is found, return to the owning task, add a reproducing focused
test, implement the smallest correction, rerun that task's gate and commit the
exact test and implementation files using that task's commit convention.
After returning here, rerun Steps 1–4. If no correction is required, do not
create an empty or catch-all commit.

- [x] **Step 6: Record final evidence**

Report:

- focused and full test counts;
- conformance case count;
- boundary-check violation counts;
- E2E submission, ingress, Handoff and capture states using safe identifiers;
- branch name and final commit;
- exact operator commands for the user's next local run.
