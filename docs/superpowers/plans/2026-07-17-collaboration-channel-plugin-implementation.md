# Collaboration Channel Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` and implement one checked increment at a time.
> Every behavior change starts with a failing test and every increment ends in
> an independent commit.

**Goal:** Add a source-neutral global configuration service and a generic,
multi-instance collaboration-channel plugin runtime, then deliver the first
Feishu plugin so an authorized `@bot` message enters Work Fabric as exactly one
Intake Handoff and committed Handoff events return to the originating chat.

**Architecture:** `ConfigurationProvider` supplies an immutable versioned
snapshot; trusted `PluginFactory` implementations create isolated plugin
instances; existing Connector ingress/worker contracts remain the durable
inbound seam; canonical Subscriptions and Signal Dispatcher remain the durable
outbound seam; `ChannelRouteStore` persists only scoped external routing facts.
Core never interprets chat, chooses a participant, invokes an Agent, or executes
work.

**Tech stack:** Node.js >=22.20.0, TypeScript 7, Vitest 4, Fastify, `yaml@2.9.0`,
SQLite, PostgreSQL, existing Work Fabric Connector/Exchange/SDK/runtime packages,
and Feishu OpenAPI boundaries.

## Global Constraints

- `exchange-core`, `exchange-spi`, `protocol-runtime`, and WFPP schemas never
  import YAML, plugin, channel, or Feishu packages.
- The plugin performs connection, durable handoff, state transfer, routing, and
  notification only. It performs no NLP, planning, model/tool invocation,
  participant ranking, requirement creation, or task execution.
- Inbound callback acceptance is separate from asynchronous Handoff creation;
  outbound API acceptance is separate from Handoff state.
- All writes use existing authenticated public commands and canonical
  Subscription state. No direct Core mutation or notification truth store.
- Configuration sources, secret resolution, plugin types, channel routes, and
  storage technologies are hidden behind technology-neutral interfaces.
- Enabled instances are isolated by tenant and instance ID. Disabled instances
  resolve no secrets, allocate no clients, register no route, and start no work.
- Configuration values, credentials, chat IDs, external user IDs, message
  bodies, and Context content never enter logs, errors, metrics, health payloads,
  Console diagnostics, Protocol Events, or route records beyond explicitly
  declared bounded routing fields.
- Every file, document, depth, alias, array, string, batch, lease, retry,
  concurrency, shutdown, and response size is positively bounded.
- Local workers are mechanical pumps only. Cluster deployments continue to use
  existing partition ownership, lease, fencing, and signal-delivery machinery.

---

## Task 1: Source-neutral configuration contracts and immutable runtime

**Files**

- Create `packages/configuration-spi/package.json`
- Create `packages/configuration-spi/src/index.ts`
- Create `packages/configuration-spi/test/contracts.test.ts`
- Create `packages/configuration-runtime/package.json`
- Create `packages/configuration-runtime/src/configuration-service.ts`
- Create `packages/configuration-runtime/src/secret-resolver.ts`
- Create `packages/configuration-runtime/src/errors.ts`
- Create `packages/configuration-runtime/src/index.ts`
- Create `packages/configuration-runtime/test/configuration-service.test.ts`
- Create `packages/configuration-runtime/test/secret-resolver.test.ts`

**Produces**

```ts
export interface ConfigurationDocument {
  readonly revision: string;
  readonly value: unknown;
}

export interface ConfigurationProvider {
  load(): Promise<ConfigurationDocument>;
}

export interface SecretResolver {
  resolve(reference: SecretReference): Promise<string>;
}
```

`ConfigurationService.load()` validates `api_version`, delegates the `service`
and enabled plugin payloads to registered validators, resolves only
schema-declared secret paths, deep-clones/deep-freezes the result, and exposes
`revision` plus `loaded_at`. Its diagnostics expose field paths and stable error
codes only.

- [ ] Write contract tests proving a fake in-memory/database Provider produces
  the same snapshot, snapshots are immutable, one provider load occurs, an
  invalid enabled plugin rejects atomically, and disabled plugins are inert.
- [ ] Write secret tests for exact `${NAME}` references, no mixed interpolation,
  missing environment values, development-only literal values, declared-path
  traversal, and value-free errors.
- [ ] Run `npm test -- packages/configuration-spi packages/configuration-runtime`
  and confirm the missing packages are RED.
- [ ] Implement minimal contracts, bounded structural validation, immutable
  snapshot creation, `EnvironmentSecretResolver`, and redacted typed errors.
- [ ] Run focused tests, `npm run typecheck`, and a repository scan proving no
  Core/protocol package imports configuration packages.
- [ ] Commit `feat(config): define provider-backed configuration runtime`.

## Task 2: Strict YAML configuration Provider

**Files**

- Create `packages/adapter-configuration-yaml/package.json`
- Create `packages/adapter-configuration-yaml/src/yaml-configuration-provider.ts`
- Create `packages/adapter-configuration-yaml/src/index.ts`
- Create `packages/adapter-configuration-yaml/test/yaml-configuration-provider.test.ts`
- Modify `package-lock.json`

**Consumes:** `ConfigurationProvider` from `configuration-spi`.

**Behavior**

- Parse one YAML/JSON-compatible document with `yaml@2.9.0`.
- Reject oversized files before parse; duplicate keys, custom tags, multiple
  documents, non-finite numbers, excessive nesting, aliases, and non-JSON value
  types after parse.
- Calculate a stable revision from file bytes and expose only a safe normalized
  file path in source errors.
- Perform no environment lookup and no schema-specific secret handling.

- [ ] Write tests for valid YAML, valid JSON compatibility, file-size boundary,
  duplicate key, multiple document, alias, custom tag, depth, non-finite scalar,
  and safe diagnostic behavior.
- [ ] Run the focused test and confirm the missing Provider is RED.
- [ ] Add the exact `yaml@2.9.0` dependency and implement bounded parsing plus
  JSON-tree validation.
- [ ] Run focused tests, `npm run typecheck`, and dependency audit.
- [ ] Commit `feat(config): add strict YAML configuration provider`.

## Task 3: Generic trusted plugin lifecycle and signal router

**Files**

- Create `packages/plugin-spi/package.json`
- Create `packages/plugin-spi/src/index.ts`
- Create `packages/plugin-spi/test/contracts.test.ts`
- Create `packages/plugin-runtime/package.json`
- Create `packages/plugin-runtime/src/plugin-registry.ts`
- Create `packages/plugin-runtime/src/plugin-host.ts`
- Create `packages/plugin-runtime/src/channel-signal-router.ts`
- Create `packages/plugin-runtime/src/errors.ts`
- Create `packages/plugin-runtime/src/index.ts`
- Create `packages/plugin-runtime/test/plugin-registry.test.ts`
- Create `packages/plugin-runtime/test/plugin-host.test.ts`
- Create `packages/plugin-runtime/test/channel-signal-router.test.ts`

**Produces**

```ts
export interface PluginFactory {
  readonly type: string;
  validate(config: unknown): PluginValidationResult;
  create(context: PluginContext,
    instance: PluginInstanceConfiguration): Promise<PluginInstance>;
}

export interface PluginInstance {
  prepare(): Promise<void>;
  start(): Promise<void>;
  health(): Promise<PluginHealth>;
  stop(): Promise<void>;
}
```

`ChannelSignalRouter` is one `SignalAdapter` registered under a stable adapter
ID. It routes only by the explicit destination plugin instance; it does not
inspect event content to choose a channel.

- [ ] Test duplicate factory/instance rejection, unknown enabled type failure,
  unknown disabled type inertness, stable instance order, prepare/start order,
  reverse rollback, reverse shutdown, bounded health, multi-instance isolation,
  missing destination retryability, and one-instance failure isolation.
- [ ] Run the focused tests and observe RED.
- [ ] Implement registry, host state machine, lifecycle rollback, immutable
  contexts, and explicit instance-addressed Signal routing.
- [ ] Run focused tests, typecheck, and package boundary tests.
- [ ] Commit `feat(plugins): add trusted multi-instance plugin runtime`.

## Task 4: Durable external-conversation route port and adapters

**Files**

- Create `packages/channel-spi/package.json`
- Create `packages/channel-spi/src/channel-route-store.ts`
- Create `packages/channel-spi/src/index.ts`
- Create `packages/channel-spi/test/contracts.test.ts`
- Create `packages/exchange-conformance/src/channel-route-store-profile.ts`
- Modify `packages/exchange-conformance/src/index.ts`
- Create `packages/exchange-conformance/test/channel-route-store-profile.test.ts`
- Create `packages/adapter-storage-memory/src/memory-channel-route-store.ts`
- Modify `packages/adapter-storage-memory/src/index.ts`
- Create `packages/adapter-storage-memory/test/memory-channel-route-store.test.ts`
- Create `packages/adapter-storage-sqlite/src/sqlite-channel-route-store.ts`
- Modify `packages/adapter-storage-sqlite/src/index.ts`
- Modify `packages/adapter-storage-sqlite/src/migrations.ts`
- Create `packages/adapter-storage-sqlite/test/sqlite-channel-route-store.test.ts`
- Create `packages/adapter-storage-postgres/src/postgres-channel-route-store.ts`
- Modify `packages/adapter-storage-postgres/src/index.ts`
- Create `packages/adapter-storage-postgres/migrations/009_channel_routes.sql`
- Create `packages/adapter-storage-postgres/test/postgres-channel-route-store.test.ts`

**Contract**

`ChannelRouteStore.put()` is idempotent for the same scoped binding, rejects a
conflicting binding, and uses expected-version CAS for updates. `get()` is
scoped by tenant + plugin instance + Handoff. Stored values contain only
conversation/message routing identifiers and timestamps; no body, Context,
credential, token, or Agent state.

- [ ] Write one reusable profile covering exact idempotency, conflict, CAS,
  defensive cloning, tenant/instance isolation, restart persistence, bounded
  page order, and forbidden extra fields.
- [ ] Instantiate the profile for Memory, SQLite, and PostgreSQL; confirm all
  missing implementations are RED.
- [ ] Implement Memory serialization, SQLite indexed migration/adapter, and
  PostgreSQL RLS/indexed migration/adapter without database types in the SPI.
- [ ] Run focused conformance, SQLite restart, PostgreSQL integration, migration
  smoke, typecheck, and `npm run verify:postgres`.
- [ ] Commit `feat(channels): persist scoped conversation routes`.

## Task 5: Crash-safe Connector command receipts and Handoff Offer support

**Files**

- Modify `packages/connector-spi/src/mapping.ts`
- Modify `packages/connector-spi/test/contracts.test.ts`
- Modify `packages/connector-runtime/src/connector-worker.ts`
- Modify `packages/connector-runtime/test/connector-worker.test.ts`
- Modify `packages/sdk-typescript/src/connector-command-sink.ts`
- Modify `packages/sdk-typescript/test/connector-command-sink.test.ts`

**Produces**

```ts
export interface ConnectorAcceptedResource {
  readonly resource_type: "handoff";
  readonly resource_id: string;
  readonly resource_version: number;
}

export type ConnectorCommandResult =
  | { readonly kind: "accepted"; readonly receipt_id: string;
      readonly event_ids: readonly string[];
      readonly resource?: ConnectorAcceptedResource }
  | ConnectorCommandFailure;

export interface ConnectorAcceptedReceiptHandler {
  record(input: ConnectorAcceptedReceipt): Promise<ConnectorCommandResult>;
}
```

The SDK sink maps `handoff.offer` and returns the HTTP operation resource. The
worker renews fencing, executes the public command, invokes the receipt handler,
then completes ingress. A retry after any crash repeats the stable idempotency
key and safely resumes route/subscription provisioning.

- [ ] Extend contract tests without breaking existing accepted results.
- [ ] Write worker tests for receipt success, retryable/permanent receipt
  failure, crash/replay after command acceptance, fencing before the receipt,
  and non-Handoff commands without a receipt resource.
- [ ] Write SDK tests proving `handoff.offer` request mapping, accepted resource
  decoding, idempotency preservation, and bounded invalid-resource rejection.
- [ ] Run focused tests and capture RED before implementation.
- [ ] Implement the optional receipt seam and Offer mapping without embedding a
  channel or Feishu type in Connector SPI/runtime.
- [ ] Run Connector, SDK, HTTP roundtrip, typecheck, and compatibility tests.
- [ ] Commit `feat(connectors): expose crash-safe accepted command receipts`.

## Task 6: Feishu mention normalization and deterministic Intake mapping

**Files**

- Modify `packages/connector-feishu/src/ingress-normalizer.ts`
- Modify `packages/connector-feishu/test/ingress-normalizer.test.ts`
- Modify `packages/connector-feishu/src/event-mapper.ts`
- Modify `packages/connector-feishu/test/event-mapper.test.ts`
- Create `packages/plugin-channel-feishu/package.json`
- Create `packages/plugin-channel-feishu/src/config.ts`
- Create `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Create `packages/plugin-channel-feishu/src/intake-receipt-handler.ts`
- Create `packages/plugin-channel-feishu/src/subscription-factory.ts`
- Create `packages/plugin-channel-feishu/src/index.ts`
- Create `packages/plugin-channel-feishu/test/config.test.ts`
- Create `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`
- Create `packages/plugin-channel-feishu/test/intake-receipt-handler.test.ts`

**Behavior**

- Preserve bounded mention identifiers plus `root_id`/`parent_id` during
  normalization.
- Only `im.message.receive_v1` text with an explicit configured bot mention is
  eligible; ordinary text and unsupported types return `ignored`.
- Resolve sender through configured identity mapping; unmapped senders return a
  stable permanent rejection and never acquire authority.
- Map eligible input to one `handoff.offer`: mapped initiator, fixed configured
  Agent target, mention-stripped bounded intent, immutable Feishu reference,
  bounded route-safe context, and a digest idempotency identity.
- Receipt handling writes the route first, then idempotently activates a
  deterministic per-Handoff Subscription owned by the mapped initiator.

- [ ] Write strict config tests for unknown keys, all bounds, multi-instance
  connector equality, tenant match, transport, credentials, identities, worker,
  inbound target, outbound channels, static subscriptions, and disabled mode.
- [ ] Write mapping tests for mention/no mention, bot mismatch, unsupported type,
  unmapped user, empty intent, reference/context/correlation correctness, and
  deterministic replay.
- [ ] Write receipt tests for route-before-subscription ordering, replay,
  conflicting route, participant ownership, exact Handoff filter, and failure
  classification.
- [ ] Run focused tests and confirm RED.
- [ ] Implement only deterministic mapping/provisioning; do not add an intent
  classifier, Agent client, target selector, requirement API, or task runner.
- [ ] Run focused tests, Feishu connector compatibility, typecheck, and boundary
  import scans.
- [ ] Commit `feat(feishu): map explicit mentions to Intake handoffs`.

## Task 7: Feishu plugin factory, webhook source, and outbound adapter

**Files**

- Create `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Create `packages/plugin-channel-feishu/src/feishu-plugin-instance.ts`
- Create `packages/plugin-channel-feishu/src/route-aware-signal-adapter.ts`
- Create `packages/plugin-channel-feishu/src/health.ts`
- Modify `packages/plugin-channel-feishu/src/index.ts`
- Create `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`
- Create `packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts`
- Create `packages/plugin-channel-feishu/test/multi-instance.integration.test.ts`
- Modify `packages/transport-http/src/internal/create-server.ts`
- Create `packages/transport-http/src/routes/plugin-webhook-route.ts`
- Modify `packages/transport-http/src/index.ts`
- Create `packages/transport-http/test/plugin-webhook-route.test.ts`

**Behavior**

The factory composes existing Feishu credentials, token provider, OpenAPI
client, webhook codec, normalizer, mapper, Connector worker, signal renderer,
and route store. HTTP selects a pre-registered instance by explicit route ID;
the route only verifies/normalizes/durably accepts and returns. Outbound
delivery resolves either the original Handoff route or one configured static
channel and reuses stable send UUIDs derived from event + destination.

- [ ] Test disabled instance side-effect freedom, secret resolution at creation,
  prepare/start/stop, health degradation, webhook signature/encryption/tenant
  mismatch, duplicate acceptance, and bounded callback response.
- [ ] Test original-chat and static-channel routing, text/card rendering, missing
  route retryability, 429/5xx/network retryability, credential rejection health,
  stable UUID replay, and no secret in diagnostics.
- [ ] Test two instances do not share token caches, identities, credentials,
  connector ingress, routes, workers, or health state.
- [ ] Run focused tests and observe RED.
- [ ] Implement the trusted factory/instance, generic HTTP plugin route seam,
  route-aware adapter, bounded health, and lifecycle cleanup.
- [ ] Run focused tests, existing Feishu roundtrip, transport tests, typecheck,
  and production build.
- [ ] Commit `feat(feishu): add collaboration channel plugin runtime`.

## Task 8: Local mechanical pump and service composition

**Files**

- Create `packages/plugin-runtime/src/local-mechanical-pump.ts`
- Modify `packages/plugin-runtime/src/index.ts`
- Create `packages/plugin-runtime/test/local-mechanical-pump.test.ts`
- Modify `packages/service-node/src/config.ts`
- Modify `packages/service-node/src/compose.ts`
- Modify `packages/service-node/src/index.ts`
- Modify `packages/service-node/src/main.ts`
- Modify `packages/service-node/package.json`
- Modify `packages/service-node/test/config.test.ts`
- Create `packages/service-node/test/plugin-composition.integration.test.ts`

**Behavior**

- `main.ts` loads `WORK_FABRIC_CONFIG` through the YAML Provider and
  Configuration Service; JSON stays valid as YAML compatibility.
- `service-node` registers the trusted Feishu factory, selects route storage
  from the active storage composition, and contributes plugin health without
  leaking identifiers.
- Startup is: snapshot -> create -> prepare -> HTTP listen -> plugin/pump start.
  Shutdown reverses intake/workers -> HTTP -> prepared resources -> storage.
- For Memory/SQLite only, the pump coalesces wakeups and runs bounded Connector,
  Handoff projection, collaboration projection, and signal turns with one
  active turn per work key. PostgreSQL cluster composition uses the existing
  worker/signal dependencies and never starts the local pump.

- [ ] Test YAML service envelope compatibility, source revision, strict plugin
  validation, startup rollback, readiness, shutdown order, role/profile gating,
  and existing direct `parseServiceConfig()` compatibility where retained.
- [ ] Test pump bounds, no overlapping key, wakeup coalescing, fairness,
  transient turn failure isolation, drain timeout, and no timers after stop.
- [ ] Run focused tests and capture RED.
- [ ] Implement composition-only wiring; expose no Feishu branch in Core or
  protocol packages and no scheduling/selection logic in the pump.
- [ ] Run service integration, local SQLite restart, cluster regression,
  typecheck, and build.
- [ ] Commit `feat(service): compose configured collaboration channel plugins`.

## Task 9: Full callback-to-notification acceptance and failure tests

**Files**

- Create `packages/service-node/test/feishu-channel.e2e.test.ts`
- Create `packages/service-node/test/feishu-channel-restart.integration.test.ts`
- Create `packages/service-node/test/feishu-channel-boundary.test.ts`
- Create `packages/service-node/test/fixtures/fake-feishu-api.ts`
- Create `packages/service-node/test/fixtures/feishu-channel-config.ts`

**Acceptance flow**

```text
signed Feishu @bot callback
  -> durable duplicate-safe ingress
  -> external-user identity resolution
  -> public SDK handoff.offer
  -> durable route
  -> canonical per-Handoff Subscription
  -> external Agent accept/status/result/verify via public API
  -> Signal Dispatcher
  -> original Feishu chat notification
```

- [ ] Write one fake-Feishu E2E test with no Console and no direct database
  mutation, asserting exact initiator/target/intent/reference/context and exactly
  one Handoff/route/subscription/message under duplicate callbacks.
- [ ] Add crash injection after Offer, route write, and Subscription upsert;
  assert replay produces no duplicate resource or binding.
- [ ] Add SQLite process-composition restart proving ingress, route,
  Subscription, projection, delivery position, and stable message UUID survive.
- [ ] Add static Subscription audience/filter tests, multi-instance tenant
  isolation, plugin-down Core liveness, retry/dead-letter, and no-secret scans.
- [ ] Add dependency-boundary tests proving Core/protocol isolation and a
  source scan proving no plugin performs model, target-selection, or execution
  calls.
- [ ] Run focused E2E/restart/boundary suites, then `npm run verify` and
  `npm run verify:postgres` where PostgreSQL is available.
- [ ] Commit `test(feishu): prove collaboration channel end to end`.

## Task 10: Runnable configuration, operator guide, and final verification

**Files**

- Create `examples/config/service-feishu.yaml`
- Modify `examples/config/README.md`
- Modify `packages/service-node/README.md`
- Create `docs/guides/feishu-collaboration-channel.md`
- Modify `docs/architecture.md`
- Modify `docs/roadmap.md`
- Modify `README.md`

**Documentation outcome**

- Explain app creation, webhook callback URL, required Feishu permissions,
  environment variables, identity/authority records, plugin enable/disable,
  Memory/SQLite/PostgreSQL operation, multiple channel instances, health,
  retries, and shutdown.
- Show how an external intake Agent accepts the Handoff and creates a requirement
  in its own system. State explicitly that Work Fabric does not understand the
  request or execute that work.
- Document future WeCom/Slack implementations as new trusted channel factories,
  not changes to WFPP/Core.

- [ ] Write documentation and a complete runnable YAML with no real credential
  or weak literal secret.
- [ ] Validate the YAML through the production Provider and configuration
  service in a test/CLI smoke run.
- [ ] Run `rg -n "TODO|TBD|FIXME|placeholder"` over all new docs/config/code and
  resolve every project-owned hit.
- [ ] Run `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`, `npm run verify:protocol`, and storage/production
  verification commands defined by the repository.
- [ ] Inspect `git diff --check`, dependency direction, secret redaction, open
  handles, worker shutdown, and final diff against the approved design.
- [ ] Commit `docs(feishu): document runnable collaboration channel`.

## Completion Criteria

- One authorized Feishu `@bot` text creates exactly one Intake Handoff targeted
  at the configured external Agent; ordinary chat remains inert.
- Agent-originated public Handoff state changes are delivered through canonical
  Subscriptions to the originating Feishu conversation and optional static
  channels.
- Memory, SQLite, and PostgreSQL route adapters pass one contract; SQLite
  restart is proven; clustered PostgreSQL keeps existing ownership semantics.
- Multiple Feishu instances are isolated and a later collaboration channel can
  be added by registering a factory without changing Core/WFPP.
- Configuration consumers do not know whether data came from YAML, a fake
  database Provider, or a future remote source.
- No implementation component interprets work, chooses the best participant,
  invokes a model/Agent, creates requirements, or executes tasks.
- Full repository verification passes with no credential or private message
  content in facts, routes, diagnostics, metrics, health, or Console.
