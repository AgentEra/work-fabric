# Work Fabric Collaboration Channel Plugin Design

**Status:** Approved for implementation planning  
**Date:** 2026-07-17

## 1. Purpose

Work Fabric needs a deployable collaboration-channel plugin boundary. Feishu is
the first plugin, but the architecture must also admit WeCom, Slack, email and
other channels without changing WFPP, Exchange Core, Agent Gateway or Console.

The first Feishu plugin supports both directions:

- an explicit `@bot` text message is durably accepted and converted into one
  Intake Handoff for a configured external Agent;
- committed Handoff events are delivered as Feishu messages or read-only cards
  to the originating conversation or to configured static channels.

The plugin connects collaboration. It does not interpret natural language,
create a requirement inside Core, select an Agent, invoke a model or execute
work. The configured intake Agent remains responsible for understanding
"create a requirement", asking follow-up questions and calling the external
requirements system.

## 2. Scope

This implementation includes:

- a technology-neutral global configuration Provider and immutable
  configuration service;
- a YAML-backed Provider and environment-backed secret resolver;
- a generic, multi-instance plugin registry and lifecycle runtime;
- a collaboration-channel plugin contract built on existing Connector and
  Signal contracts;
- a Feishu plugin that composes the existing webhook, ingress, mapper, OpenAPI,
  token and SignalAdapter components;
- deterministic `@bot` Intake Handoff mapping;
- durable external-conversation routing for outbound Handoff notifications;
- bounded local mechanical workers for Memory and SQLite service profiles;
- canonical Subscription-based outbound delivery;
- configuration, plugin, persistence, integration and restart tests;
- deployment documentation and one complete YAML example.

This implementation does not include:

- an Agent Brain, NLP intent classifier or requirement-system implementation;
- implicit workflow design or target ranking;
- runtime loading of arbitrary JavaScript paths from configuration;
- live configuration reload;
- multi-turn conversational inference from Feishu reply chains;
- arbitrary chat-to-command conversion;
- a new notification truth store or a channel-specific Handoff state machine.

## 3. Chosen approach

Use an in-process generic plugin runtime. The deployment composition root
registers trusted `PluginFactory` implementations, while YAML enables one or
more instances by stable type name.

Rejected alternatives:

1. Feishu-specific branches in `service-node` are initially smaller but couple
   every future channel to the service configuration and composition code.
2. A remote plugin sidecar provides stronger process isolation but introduces
   discovery, IPC, version negotiation and distributed lifecycle complexity
   before those capabilities are needed.

The in-process runtime preserves simple deployment and direct-call performance
while keeping source, plugin and channel boundaries replaceable.

## 4. Architecture

```text
ConfigurationProvider
        |
ConfigurationService ---- SecretResolver
        |
PluginRegistry ---- PluginFactory ---- PluginInstance
        |
ChannelSignalRouter
        +---- FeishuPluginInstance
        +---- future WeComPluginInstance

Feishu webhook
  -> verify / normalize
  -> durable ConnectorIngressStore
  -> ConnectorWorker
  -> Feishu IntakeMessagePolicy
  -> ConnectorSdkCommandSink
  -> public WorkFabric API

Work Fabric ProtocolEvent
  -> Durable Subscription
  -> SignalDispatcher
  -> ChannelSignalRouter
  -> FeishuSignalAdapter
  -> Feishu OpenAPI
```

Existing `connector-spi`, `connector-runtime`, `exchange-spi` and
`exchange-runtime` contracts remain the canonical ingress and signal seams.
The plugin runtime composes them; it does not replace them.

### 4.1 Proposed package responsibilities

- `configuration-spi`: source-neutral configuration document and Provider
  contracts.
- `configuration-runtime`: snapshot validation, typed access, redacted
  diagnostics and secret-reference coordination.
- `adapter-configuration-yaml`: strict YAML/JSON-compatible file Provider.
- `plugin-spi`: factory, instance, context, health and lifecycle contracts.
- `plugin-runtime`: registry, multi-instance creation, ordered startup,
  rollback, shutdown and channel signal routing.
- `channel-spi`: external-conversation binding and route-store contracts.
- Memory, SQLite and PostgreSQL storage adapters: technology-specific channel
  route persistence behind `ChannelRouteStore`.
- `plugin-channel-feishu`: trusted Feishu factory and composition over the
  existing `connector-feishu` package.
- `service-node`: composition root only; it supplies configuration,
  persistence, HTTP, SDK and mechanical worker dependencies to the registry.

Core and protocol packages must not import any configuration, YAML, plugin or
Feishu implementation package.

## 5. Global configuration

The deployment continues to use `WORK_FABRIC_CONFIG`. The official form is
YAML. JSON remains accepted for one compatibility path because JSON is a YAML
subset, but all examples and new documentation use YAML.

```yaml
api_version: workfabric.config/v1

service:
  storage_profile: sqlite-local
  role: all
  development_mode: false
  tenant_id: tenant-01
  exchange_id: exchange-01
  cursor_secret: ${WORK_FABRIC_CURSOR_SECRET}

  listen:
    host: 127.0.0.1
    port: 8787

  sqlite:
    location: ./var/work-fabric.db
    busy_timeout_ms: 5000

plugins:
  instances:
    feishu-primary:
      type: collaboration-channel.feishu
      enabled: true
      config:
        connector_id: feishu-primary
        external_tenant_id: feishu-tenant-key
        bot_open_id: ou_bot

        credentials:
          app_id: ${FEISHU_APP_ID}
          app_secret: ${FEISHU_APP_SECRET}
          verification_token: ${FEISHU_VERIFICATION_TOKEN}
          encrypt_key: ${FEISHU_ENCRYPT_KEY}
          work_fabric_access_token: ${FEISHU_CONNECTOR_ACCESS_TOKEN}

        inbound:
          enabled: true
          transport: webhook
          route_id: primary
          mention_only: true
          intake_target:
            actor_id: actor-requirement-agent
            endpoint_id: endpoint-requirement-runtime

        outbound:
          enabled: true
          default_render_mode: card
          channels:
            project-notifications:
              receive_id_type: chat_id
              receive_id: oc_project_group
          subscriptions:
            project-events:
              channel_ref: project-notifications
              owner:
                actor_id: actor-project-owner
                actor_type: human
                endpoint_id: endpoint-project-owner
              filter:
                event_types:
                  - workfabric.handoff.result_returned.v1
                  - workfabric.handoff.verified.v1

        identities:
          - external_open_id: ou_user
            actor_id: actor-user
            endpoint_id: endpoint-feishu-user

        worker:
          poll_interval_ms: 1000
          lease_seconds: 30
          batch_limit: 100
          max_attempts: 8
```

The excerpt shows the new configuration envelope and plugin section. Existing
`service.identities`, `service.authority_rules` and storage-specific fields
retain their current exact schemas. The implementation delivers a separate
complete runnable YAML example containing those records and the precise
Authority actions required by the Connector identity, mapped user, intake
Agent and configured Subscription owners.

`plugins.instances` is keyed by plugin instance ID. The `type` selects a
registered factory. Multiple instances of one type are allowed and must not
share credentials, token caches, connector scope, identity mappings, worker
leases, conversation routes or health state.

### 5.1 Provider and snapshot contracts

```ts
export interface ConfigurationDocument {
  readonly revision: string;
  readonly value: unknown;
}

export interface ConfigurationProvider {
  load(): Promise<ConfigurationDocument>;
}
```

`ConfigurationService` loads one document, validates the root version and
service section, delegates plugin-specific validation to registered factories,
and publishes an immutable typed snapshot. Consumers depend on the service,
not on YAML or filesystem APIs.

The snapshot exposes its source revision and load time. Reload and change
subscription may be added later, but the first implementation applies one
snapshot for the process lifetime. Any invalid enabled plugin prevents the
snapshot from becoming active.

A future database or remote Provider implements the same interface. Provider
contract tests must prove that configuration-runtime behavior is independent
of the source.

### 5.2 YAML safety

The YAML Provider enforces:

- a bounded file size and bounded document depth;
- one document only;
- duplicate keys rejected;
- custom tags and executable values rejected;
- aliases bounded or disabled;
- objects, arrays, strings, booleans, finite numbers and null only;
- no environment lookup inside the Provider.

Provider failures contain only the path, safe structural location and stable
error code. Parsed values and source excerpts are not copied into errors.

### 5.3 Secrets

Secret resolution is separate from configuration loading. An exact scalar
`${NAME}` is an environment reference. Mixed interpolation is not supported.
Schema-declared secret fields include the service cursor secret, identity
authentication evidence, PostgreSQL connection string and plugin credentials;
ordinary strings are never treated as secrets by name guessing.

- enabled plugins resolve required references during creation;
- disabled plugins do not resolve secrets or create clients;
- a missing reference rejects startup without printing the variable value;
- literal secrets are accepted only when `service.development_mode` is true;
- redacted diagnostics identify the field but never its value;
- secrets do not enter configuration summaries, health payloads, audit facts,
  metrics, Console, Protocol Events or durable route records.

## 6. Plugin registry and lifecycle

Configuration cannot name a filesystem module or execute untrusted code.
Installation means a package is deployed and its trusted factory is registered
at the composition root.

```ts
export interface PluginFactory {
  readonly type: string;
  validate(config: unknown): PluginValidationResult;
  create(
    context: PluginContext,
    instance: PluginInstanceConfiguration,
  ): Promise<PluginInstance>;
}

export interface PluginInstance {
  prepare(): Promise<void>;
  start(): Promise<void>;
  health(): Promise<PluginHealth>;
  stop(): Promise<void>;
}
```

The registry rejects duplicate factories and duplicate instance IDs. An
enabled unknown type rejects startup. A disabled unknown type remains inert so
operators may stage future configuration without installing or resolving it.

Startup order:

1. load and validate the complete configuration snapshot;
2. create enabled instances in stable instance-ID order;
3. `prepare` storage, webhook routes, subscriptions and signal adapters;
4. start the HTTP service;
5. `start` bounded workers and optional long-lived sources.

Failure rolls back already-prepared or started instances in reverse order.
Shutdown stops intake, drains bounded in-flight work, closes network clients
and releases leases in reverse order.

## 7. Feishu inbound flow

Only `im.message.receive_v1` text messages with an explicit mention of the
configured bot are eligible for Intake mapping. The normalizer preserves a
bounded list of mention identifiers and the message `root_id`/`parent_id` when
present, but the first version does not infer a multi-turn workflow from them.

```text
Feishu callback
  -> trusted route selects plugin instance and tenant scope
  -> raw-body size, signature, verification token and encryption checks
  -> normalize bounded message facts
  -> durable accept keyed by message_id
  -> asynchronous fenced ConnectorWorker claim
  -> verify text + explicit bot mention
  -> resolve external open_id to configured Work Fabric identity
  -> create one Intake Handoff
```

The Intake Handoff uses:

- initiator: the mapped Work Fabric Actor/Endpoint representation;
- target: the configured intake Actor/Endpoint;
- WorkReference: an immutable Feishu message URI;
- intent: the bounded message text after removing only the bot mention token;
- context: bounded route-safe chat, message, sender and occurrence facts;
- correlation: ingress ID, Feishu event ID and message ID;
- idempotency key: a digest of tenant, connector and Feishu message ID.

The plugin authenticates its SDK calls with the configured Connector access
token and represents the identity returned by the existing identity resolver.
The deployment Identity Provider and Authority Policy must explicitly permit
that representation and the required Handoff/Subscription actions; callback
claims alone never grant it.

Arbitrary chat stays inert. Unsupported message types are ignored with a
stable reason. An unmapped user cannot gain authority or create a Handoff; the
plugin may send a bounded generic denial to the same chat without disclosing
identity or policy details.

One eligible message creates one Handoff. Another eligible message creates a
new Handoff even in the same chat. Reply-chain correlation is preserved as an
external fact for later extension but has no first-version command semantics.

### 7.1 Command receipt and crash safety

The existing connector command sink is extended to support `handoff.offer` and
to return the accepted resource ID and version. The worker records the external
conversation route and provisions the per-Handoff canonical Subscription before
marking ingress complete.

```text
durable ingress
  -> offer with stable idempotency key
  -> accepted handoff_id
  -> idempotent route binding write
  -> idempotent Subscription upsert
  -> ingress complete
```

A crash after Offer replays the same logical command and receives the same
resource. Route binding and Subscription writes use CAS/idempotency. Outbound
delivery cannot overtake route creation because the Subscription is made active
only after the route record is durable.

## 8. Channel routing and outbound delivery

`ChannelRouteStore` is a technology-neutral port. A route contains only scoped
routing facts:

```text
tenant_id
plugin_instance_id
handoff_id
external_conversation_id
external_message_id
created_at
updated_at
version
```

It never contains credentials, message bodies, Context content or Agent state.
Memory, SQLite and PostgreSQL adapters implement the same conformance profile.

Each Intake Handoff gets a deterministic durable Subscription owned by the
mapped initiator Actor/Endpoint and filtered to that Handoff's
`workfabric.handoff.result_returned.v1` event. The destination contains only the
channel plugin instance ID and route mode. Existing audience authorization
therefore remains authoritative. The 2026-07-27 Agent-owned reply design
supersedes the original all-event conversation notification behavior.

`ChannelSignalRouter` selects an already-created plugin instance. It does not
inspect event content to choose a channel. The Feishu adapter resolves the
Handoff route and sends the rendered event to the original chat. Missing route
state is retryable; an exhausted delivery enters the existing dead-letter
ledger.

Configured static channels are also represented as canonical Subscriptions.
Their owner representation and event filters are explicit configuration. They
do not bypass participant visibility or create a private notification engine.

The first version renders text or read-only cards. Accept/Decline and other
interactive action callbacks remain part of the existing Feishu Connector
capability but are not enabled by the Intake notification plugin in this cycle.

## 9. Mechanical runtime

Notifications require Connector, projection and signal turns to advance without
manual calls. For `memory-demo` and `sqlite-local`, `service-node` composes a
bounded single-process mechanical pump with an adapter-supplied bounded
partition catalog. It runs:

- Connector ingress batches;
- Handoff projection turns;
- Collaboration projection turns;
- Signal delivery turns.

The pump coalesces wakeups, limits each batch, has at most one active turn per
work key and stops cleanly. It does not select recipients, plan work, interpret
messages, call models or execute participant work.

Clustered PostgreSQL deployments continue using the existing Partition Worker,
lease, fencing and optional broker wakeup architecture. The registered channel
signal router is supplied to the existing Signal Delivery Handler; database
state remains authoritative.

## 10. Failure behavior

| Failure | Required behavior |
|---|---|
| invalid YAML, duplicate key or invalid root version | reject startup |
| enabled plugin invalid or unknown | reject startup and roll back instances |
| disabled plugin | no secret resolution, clients, routes or workers |
| missing or forbidden secret form | reject startup with redacted error |
| Feishu signature, token, encryption or tenant mismatch | reject callback; no ingress |
| duplicate Feishu message | return accepted duplicate; no second Handoff |
| message without configured bot mention | complete ingress as ignored |
| unsupported message type | complete as ignored with stable reason |
| unmapped Feishu user | no Handoff; bounded generic reply allowed |
| Authority denial | dead-letter ingress with stable code |
| SDK timeout or temporary failure | retry ingress with bounded backoff |
| route binding missing | retry delivery, then dead-letter |
| Feishu 429, 5xx or network failure | retry delivery with existing policy |
| Feishu credential rejection | instance health degraded; committed facts remain |
| one instance runtime failure | isolate instance; other instances continue |

Core liveness remains independent of Feishu availability. Enabled plugin health
contributes to readiness and operational diagnostics without exposing secrets,
external user IDs or chat IDs.

## 11. Performance and limits

All user-controlled arrays, strings, bodies, YAML structures, caches, batches,
retries and concurrent workers are explicitly bounded. No unbounded per-chat
task or timer is created. Token caches are per instance with maximum entries.

Inbound callbacks return only after durable ingress acceptance, not after
mapping or Handoff creation. Outbound sends reuse stable Feishu UUIDs derived
from event and destination identity. Channel route lookups are indexed by
tenant, plugin instance and Handoff. Static Subscription and route scans use
keyset or bounded pagination.

## 12. Testing and acceptance

Implementation follows test-first red/green cycles. Acceptance requires:

1. Provider contract tests using YAML and a fake database Provider.
2. YAML file size, depth, duplicate-key, tag and alias rejection tests.
3. secret resolution, missing variable, development literal and redaction tests.
4. immutable snapshot and source-revision tests.
5. registry duplicate, unknown, disabled, multi-instance and rollback tests.
6. Feishu plugin strict configuration and tenant-isolation tests.
7. webhook signature, encryption, duplicate and tenant-mismatch tests.
8. ordinary chat and unsupported message types remain inert.
9. one valid `@bot` message produces exactly one Intake Handoff.
10. the Handoff initiator, target, intent, reference and context are correct.
11. a crash between Offer, route write, Subscription upsert and ingress complete
    replays without duplicate Handoffs or routes.
12. Only the Agent-authored Result routes to the original chat; Accept, Status
    and Verify remain observable Fabric events.
13. static channel Subscriptions honor filters and participant visibility.
14. Feishu 429, transport failure, credential rejection and dead-letter paths.
15. two Feishu instances never share credentials, tokens, identities or routes.
16. Memory, SQLite and PostgreSQL route-store conformance.
17. SQLite restart restores ingress, route, Subscription and delivery position.
18. local mechanical pump bounds, coalescing and graceful shutdown.
19. boundary tests prevent Core/protocol imports of YAML or plugin packages.
20. one fake-Feishu end-to-end test covers callback through Handoff and result
    notification without Console or direct database mutation.
21. `npm run verify`, WFPP conformance and production build checks pass.

## 13. Completion outcome

After this work, an operator can install the built-in Feishu channel factory,
enable one or more instances in the global YAML configuration, configure
environment-backed credentials and identity mappings, and start Work Fabric.
An authorized Feishu user can `@bot` with a request, see one Intake Handoff enter
the network, let an external Agent process it, and receive status and result
notifications in the originating Feishu conversation. Adding WeCom later
requires a new trusted channel plugin implementation and configuration, not a
change to WFPP or Work Fabric Core.
