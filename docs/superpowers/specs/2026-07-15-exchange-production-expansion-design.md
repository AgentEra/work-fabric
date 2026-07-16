# Work Fabric Production Expansion Design

## 1. Goal and completion boundary

This design extends the completed WFPP v1 and Exchange Core Phase 1 reference
implementation into a production-capable, modular Work Fabric deployment. The
expanded system remains a collaboration interconnect: it coordinates
participation, responsibility handoff, context exchange, status, result
references, acknowledgement, retry and audit while external participants keep
their own execution environments.

The scope includes all Work Fabric-owned and integration-boundary modules needed
for a first production deployment:

- a PostgreSQL production Adapter;
- a modular service host with Command API, SSE, Webhook and health endpoints;
- OIDC/JWT authentication mapped through the existing identity and authority
  SPI;
- durable outbox, projection, delivery, retry, expiry and reconciliation
  workers;
- endpoint registration, capability discovery and lease management;
- a local Agent Endpoint Gateway and generic external Connector SPI;
- Feishu message/document integration and reference examples;
- structured audit, metrics, tracing hooks, migrations, deployment examples,
  performance baselines and failure-injection conformance.

The following remain independent later modules and are not hidden inside Core:

- Kafka/NATS transport acceleration;
- A2A and MCP protocol Bindings beyond the Gateway seam;
- Federation and cross-Exchange transactions;
- a full web Console/UI;
- Agent reasoning, Codex execution, Feishu business workflows or any other
  participant's internal work.

### 1.1 Implementation status (2026-07-16)

Delivery increments 1-5 are implemented through Phase 4B: PostgreSQL
foundation, target resolution, HTTP/SSE, unified TypeScript SDK, worker runtime
foundations, Endpoint/Agent boundary, generic Connector contracts, durable
Memory/PostgreSQL Connector ingress, and the Feishu Connector round trip.

The next active increment is operations and scale. OIDC production composition,
complete observability/performance baselines, optional broker acceleration,
A2A/MCP, federation, and Console remain incomplete unless documented by a
later phase. Completing Feishu connectivity does not imply those capabilities
or any external execution runtime are production-ready.

## 2. Architectural decisions

### 2.1 Deployment topology

The first production topology is a modular monolith. HTTP ingress, protocol
validation, application dispatch, outbox publication, projections, delivery
workers and connector workers can run in one deployable process, but each is a
separate package/module with a technology-neutral port. The process may later
be split into API, Core, Projection, Delivery and Connector services without
changing WFPP or the Exchange SPI.

The default runtime is Node.js/TypeScript, matching the Phase 1 packages. No
Core or SPI package may import PostgreSQL, HTTP frameworks, Feishu SDKs,
brokers, OIDC libraries or Agent Runtime implementations.

### 2.2 Persistence and tenancy

PostgreSQL is the first production Adapter and the source of durable facts.
All tenant-owned rows carry `tenant_id`; tenant-aware repositories require the
tenant context at their boundary. Row-Level Security (RLS) is enabled for
authoritative tables and is tested independently from application filtering.

The Adapter owns migrations, transactions, connection health, retry-safe
serialization and statement timeouts. It implements the existing
`ExchangePersistence`, `ProjectionCheckpointStore`, `DeliveryStateStore`,
`SubscriptionStore`, `ContextRepository` and new lease/outbox ports without
changing their domain meaning.

Authoritative records are append-only or first-write/idempotent where their
existing SPI requires it. Projections, delivery attempts, checkpoints and
leases are rebuildable or recoverable. Large Context and Artifact bodies stay
outside the relational transaction; PostgreSQL stores immutable references,
metadata, digests, access scope and optional bounded snapshots.

### 2.3 Event and worker model

Every committed Exchange transaction produces durable outbox facts in the same
database transaction. An Outbox Worker leases unpublished rows, publishes them
through a `SignalAdapter` or Connector, records an attempt, and advances the
outbox cursor only after the Adapter's acknowledged semantic boundary. A crash
may duplicate delivery, never silently skip an event.

Projection, delivery, expiry and reconciliation workers use leases with owner,
heartbeat, expiry and fencing token semantics. Work is partitioned by
`tenant_id + partition_id`; no worker assumes global event order.

### 2.4 Service and protocol boundaries

The service host has four transport-neutral responsibilities:

1. authenticate a request and resolve `Principal`/`Actor`/`Endpoint`/
   `Delegation`;
2. validate the WFPP Envelope and mapped Payload Schema;
3. invoke the public Exchange Application or Runtime service;
4. encode the protocol result, error, cursor or stream frame.

HTTP, SSE and Webhook are bindings over this boundary. They do not reproduce
state-machine rules. HTTP idempotency uses the existing command identity and
payload digest; transport retries never create a second authoritative event.

### 2.5 Participants and connectors

Endpoint Registry stores endpoint identity, capabilities, protocol versions,
delivery destinations and current lease. Discovery is declarative and
capability-based; it does not execute or rank Agent plans. A local Agent
Gateway translates endpoint messages to the public protocol and can use HTTP,
SSE, Webhook or local IPC without changing Core.

The Feishu Connector maps messages, cards, approvals and document references to
Work References, Handoffs, Status Reports and Results. It never stores Feishu
credentials in Core and never makes Feishu content the authoritative Handoff
state. Generic Connector ports support CRM, Git, issue trackers, knowledge
bases and deployment systems through the same reference/status/result model.

Codex and a local Agent Runtime are external participant implementations. The
Gateway may deliver them a Handoff and receive a Result, but no Work Fabric
worker invokes Codex or performs the Agent's professional work.

### 2.6 Target Resolution boundary

Capability-targeted Handoffs use the two-stage Target Binding defined in
[Work Fabric Target Resolution Design](2026-07-15-target-resolution-design.md).
Exchange records the unresolved requirement, accepts an explicit resolution
from an external human, rule service or Agent Brain, validates the proposed
Actor/Endpoint through a technology-neutral eligibility port, and only then
offers the Handoff for dispatch. Matching, ranking, recommendation and
execution scheduling remain outside Exchange Core.

## 3. Logical module layout

```text
packages/
  exchange-spi/                 stable ports and semantic records
  exchange-core/                authoritative Handoff decisions/application
  exchange-runtime/             projections, subscriptions, delivery
  protocol-runtime/             WFPP schema and command validation
  adapter-storage-memory/       reference adapter and profiles
  adapter-storage-postgres/     production PostgreSQL adapter
  adapter-context-postgres/     metadata/snapshot Context adapter
  adapter-identity-oidc/        JWT/OIDC Principal resolver
  adapter-signal-webhook/       outbound Webhook binding
  transport-http/               HTTP Command, SSE, Webhook ingress/egress
  endpoint-directory/           registry, capability discovery and leases
  agent-gateway/                local Agent Endpoint protocol bridge
  connector-feishu/             Feishu document/message binding
  connector-generic/            external WorkReference/status/result ports
  exchange-workers/             outbox, projection, delivery, expiry, reconcile
  exchange-observability/       audit, metrics, traces, health/readiness
  exchange-conformance/         reusable profiles and reference suites
```

Each package has a public index, explicit workspace dependencies, contract
tests and no dependency from Core/SPI to an Adapter or binding.

## 4. Data model and durable contracts

### 4.1 PostgreSQL table families

The first migration set defines these logical table families. Exact physical
names may vary by Adapter version, but the keys and invariants are stable:

- `wf_command_record`: tenant, idempotency key, payload digest, outcome,
  receipt and committed event references;
- `wf_handoff_stream` / `wf_handoff_event`: append-only authoritative stream
  and immutable event payloads;
- `wf_partition_cursor`: journal partition metadata and retention watermark;
- `wf_outbox`: event/partition position, publish state, lease/fencing data and
  attempt history;
- `wf_projection_checkpoint` / `wf_projection_failure`: rebuild position and
  poison-event audit;
- `wf_subscription` / `wf_delivery_position` / `wf_pending_delivery`:
  durable subscription identity, per-partition cursor and Pull state;
- `wf_delivery_attempt` / `wf_dead_letter`: stable compound identities and
  first-write/idempotent semantics;
- `wf_context_bundle` / `wf_context_item`: scoped references, digest, version,
  visibility, expiry and bounded snapshots;
- `wf_endpoint` / `wf_capability` / `wf_endpoint_lease`: registration and
  liveness state;
- `wf_worker_lease`: owner, fencing token, heartbeat and expiry;
- `wf_audit_record`: append-only security and responsibility audit facts.

### 4.2 Transaction boundaries

The Adapter must provide these semantic transactions:

- command idempotency check + Handoff stream append + outbox insert;
- multi-stream Transfer version checks + all stream appends + outbox insert;
- Cursor Ack settlement + delivery position/dead-letter/active pointer;
- projection checkpoint CAS after successful read-model application;
- lease acquisition/renewal with fencing token;
- endpoint registration version update and lease replacement.

No transport response, external HTTP call or Connector side effect is part of
an authoritative database transaction. External side effects use durable
attempt records and at-least-once recovery.

## 5. Worker responsibilities

### Outbox Worker

Claims unpublished partition rows, emits public Protocol Events, records the
attempt and releases or advances the row. It uses stable Event IDs and honors
subscription isolation. A failed destination is retried independently.

### Projection Worker

Reads a contiguous journal range, validates/replays each event, applies a
projection transaction, and advances its checkpoint with CAS. Poison events
remain visible in `ProjectionFailureStore`; unrelated partitions continue.

### Delivery Worker

Runs Push subscriptions using the existing `SignalDispatcher`, per-subscription
positions, exact retry schedule and dead-letter semantics. It is safe to stop
between send, attempt recording and position advancement.

### Expiry and Reconciliation Worker

Expiry emits deterministic `handoff.expire` commands only after deadline policy
checks. Reconciliation compares external Connector receipts/status with Work
Fabric facts and creates an auditable discrepancy or follow-up Handoff; it
never mutates external truth silently.

## 6. Service API surface

The first public service surface consists of:

- `POST /v1/exchanges/{exchange_id}/commands` for WFPP Command Envelopes;
- `GET /v1/subscriptions/{subscription_id}/pull` for Cursor Pull;
- `POST /v1/subscriptions/{subscription_id}/ack` for Delivery Ack;
- `GET /v1/subscriptions/{subscription_id}/stream` for SSE;
- Webhook delivery with signed CloudEvent/Protocol Event payloads;
- `GET /health/live`, `GET /health/ready`, and metrics/tracing hooks;
- endpoint registration, lease renewal and capability discovery routes.

All endpoints return stable protocol errors, correlation/causation metadata and
safe retry guidance. Authentication and authorization are evaluated before
command execution or event exposure. SSE/Webhook never imply Handoff
Responsibility Accepted; only the corresponding protocol command does.

## 7. Security and governance

- OIDC JWT signature, issuer, audience, expiry and key rotation are validated
  by the identity Adapter.
- Tenant context is derived from trusted claims and checked against the command,
  subscription and resource; clients cannot select an arbitrary tenant.
- RLS, authority policy, endpoint capability and delegation scope are separate
  checks; passing one never implies the others.
- Webhook secrets and Connector credentials live in an external secret store;
  only opaque credential references enter configuration.
- Audit records include principal, actor, endpoint, delegation, request,
  decision, causation, outcome and relevant resource/event IDs without storing
  secret tokens or full sensitive Context bodies.
- Public Protocol Events exclude internal domain data, storage cursors,
  visibility lists and credential material.

## 8. Operations and performance

The production baseline includes migrations, readiness checks, pool limits,
statement timeouts, lease recovery, structured logs, metrics, traces and
failure-injection tests. Performance tests measure command commit latency,
partition append/read throughput, projection lag, delivery lag, retry recovery,
and Connector reconciliation delay by tenant/partition.

No universal throughput number is promised before representative benchmarks;
the first baseline records environment, dataset, concurrency, p50/p95/p99,
error rate, lag and recovery time. Optimizations must preserve the same SPI and
Conformance semantics.

## 9. Delivery order

The implementation is split into independently verifiable plans. Status at the
Phase 4B boundary is:

1. **Complete** — Persistence foundation: PostgreSQL schema, transaction adapter, RLS,
   Context metadata and migration/conformance suite.
2. **Partially complete** — Service boundary: Target Resolution protocol/Core extension, OIDC/JWT
   resolution, HTTP Command API, Cursor Pull/Ack, SSE/Webhook binding, stable
   error and health surfaces, and TypeScript SDK. Production OIDC composition
   remains outstanding.
3. **Complete for current reference/production adapter scope** — Worker runtime: Outbox, Projection, Delivery, Expiry and Reconciliation
   workers with leases, fencing and crash recovery.
4. **Complete** — Endpoint and Agent boundary: registry, capability discovery, endpoint lease,
   Local Agent Gateway and SDK contract.
5. **Feishu complete; additional connectors planned** — External connectors:
   generic ingress/mapping/resource/reconciliation contracts, Feishu first,
   then Git/issue/knowledge/deployment examples.
6. **Next** — Operations and scale: observability, migrations tooling, performance
   baselines, optional broker Adapter conformance and deployment samples.
7. **Planned** — Later independent modules: A2A/MCP bindings, Federation and Console/UI.

Every step ends with focused TDD, reusable Conformance, full verification and
an independent review. No step may add a concrete technology dependency to
Core or SPI.

## 10. Acceptance criteria

The expansion is complete when:

- PostgreSQL passes every existing Persistence, Subscription, Projection and
  Context Profile, including RLS tenant-isolation tests;
- a fresh deployment can authenticate an OIDC principal, accept a valid Command
  Envelope, commit one Handoff and expose its Protocol Event over SSE and
  Webhook with stable Event ID;
- restart/crash tests prove outbox, projection, delivery, leases and Context
  recovery without skipped events or duplicate authoritative transitions;
- endpoint registration and capability discovery provide authorized facts that
  an external Resolver uses to bind a Handoff to a local Agent Gateway, while
  execution remains external;
- Feishu message/document examples round-trip WorkReference, Handoff, Status,
  Result and human acknowledgement without storing Feishu as authoritative
  Handoff state;
- reconciliation turns external discrepancy into visible audit/follow-up facts;
- health, audit, metrics, traces, migrations and performance reports are
  reproducible;
- Core/SPI dependency guards remain clean and all public protocol/conformance
  tests pass.

## 11. Explicit non-goals

This design does not turn Work Fabric into a workflow engine, Agent brain,
general-purpose project-management system, Feishu replacement, message broker,
federated transaction coordinator or UI product. Those systems may participate
through the protocol and Connector/Binding seams, but their internal execution
remains outside the Exchange boundary.
