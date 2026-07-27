# Work Fabric roadmap

This roadmap tracks architectural capability, not product marketing. A phase
is complete only when its public contracts, reference behavior, failure paths,
and repository verification are implemented.

| Phase | Scope | Status |
|---|---|---|
| 1 | WFPP v1, Exchange Core, Memory reference | Complete |
| 2 | PostgreSQL production adapter foundation | Complete |
| 3A | External target-resolution protocol and Core | Complete |
| 3B | HTTP service binding, Pull/Ack, authenticated SSE | Complete |
| 3C | Unified TypeScript SDK | Complete |
| 4A | Endpoint Directory, Inbox, external Agent Gateway | Complete |
| 4B | Generic Connector seam and Feishu Connector | Complete |
| 5 | Operations, observability, read projections, read-mostly Console | Complete |
| 6A | Clustered partition ownership and database-backed recovery | Complete |
| 6B | Broker-backed Signal/wakeup acceleration | Complete |
| 7 | Cross-Exchange federation profile | Complete |
| 8 | Provider-backed configuration and collaboration-channel plugin runtime | Complete |
| 9 | Source-neutral Collaboration Admission and participant representation | Complete |
| 10 | Network Citizen catalog, leased declarations and runtime foundation | Complete |
| 11 | Agent capability invocation and Feishu Capability/Context Provider | Complete |

## Phase 11 completion boundary

Phase 11 adds a technology-neutral, persisted Agent capability-invocation
loop. A capability-aware Driver may request at most four sequential calls.
The Runtime discovers a dynamically registered Citizen, freezes the complete
Contract and schema digests, obtains a down-scoped grant, creates an auxiliary
Handoff using standard `external_resolution`, waits through the public query
surface, validates the typed Provider Result, and returns inert facts to the
next Agent turn. Protocol v1 one-shot Drivers remain unchanged.

The reference Feishu deployment contributes two independent Citizens:
`capability-provider` for one-target text send and bounded simple Docx
create/read/update/append/delete, and `context-provider` for authorized bounded
document context. OpenAPI access, credentials, retries, stable error mapping,
idempotency, document ownership, revisions and Memory/SQLite state close
inside the Provider. Destructive delete additionally consumes a durable,
single-use confirmation proof bound to tenant, Human Actor, operation,
document and normalized input.

The Provider returns typed facts only. The original Agent keeps responsibility
for the original Handoff and alone authors the final user-facing Result; the
Channel only transports that Result. No transfer, target ranking, workflow
automation, model/tool execution, vendor credential, or Feishu SDK enters
Exchange Core, Catalog or Agent Host.

## Phase 10 completion boundary

Phase 10 adds the technology-neutral Network Citizen model for modules that
enter the collaboration network. Actor type (`human`, `agent`, `system`) and
Citizen kind are orthogonal. Every Citizen registration has exactly one kind:
`decision-body`, `capability-provider`, `channel`, `context-provider`,
`governance-provider` or `observer`; one process may host several independently
authorized registrations.

Configuration provisions trusted identity bindings, declaration namespaces,
risk ceilings and administrative state. A leased, single-active Runtime session
is the source of current descriptor, declarations and availability. Registration
revision, monotonic fencing, heartbeat sequence, declaration CAS and immutable
Schema URI/digest binding reject stale writers and silent contract drift.

The Directory exposes separately authorized Citizen list, descriptor,
declaration summary and full Contract levels. Memory and SQLite Stores share
the same SPI; SQLite restart recovery is verified through the real service-node
HTTP surface. External storage profiles inject `NetworkCitizenStore` rather
than coupling the module name or contract to PostgreSQL. The unified TypeScript
SDK exposes the same administration, session and discovery resources, and the
optional leased Runtime base owns heartbeat and declaration lifecycle only.

Phase 10 does not make databases, YAML, HTTP, SDKs, Brokers or caches into
Citizens. A declaration is not invocation Authority. Catalog discovery does
not rank, recommend, select, Claim, Accept, reason or execute work. Each module
must close its own responsibility and exchange only protocol facts through
stable Contracts or narrow SPIs. See
[Network Citizen architecture and integration](architecture/network-citizens.md).

The Agent-side technology-neutral `CapabilityInvocationPort` and first
independent Feishu Capability/Context Provider are complete in Phase 11.

## Phase 9 completion boundary

Phase 9 adds a source-neutral Collaboration Admission SPI/runtime between
trusted Connector ingress and protocol Identity/Authority. Tenant-scoped
policies use fixed deny-before-allow precedence, optional verified internal
membership, stable per-subject Actor/Endpoint bindings, bounded decision
receipts and short-lived single-subject representation grants. Memory, SQLite
and PostgreSQL adapters share the same conformance profiles; the Feishu Contact
adapter supplies evidence without owning policy.

The verified path is `transport trust -> durable ingress -> Admission ->
representation grant -> public TypeScript SDK -> HTTP Identity -> Authority ->
Exchange Core -> Handoff`. Exact deny, unknown/guest evidence and directory
outage create no Handoff; retryable outage recovery, duplicate ingress and both
Feishu transports preserve the same authoritative semantics. A synthetic
non-Feishu system participant reuses the same Admission runtime.

Phase 9 does not classify group membership, message text or prompts, reason for
Agents, select targets, approve business work, execute automation, or become a
general firewall. Those remain external IAM, channel, Agent and connected-work
system responsibilities.

## Phase 8 completion boundary

Phase 8 adds a source-neutral immutable Configuration Provider, a strict YAML
adapter, declared environment secret resolution, trusted multi-instance plugin
lifecycle, durable channel routes for Memory/SQLite/PostgreSQL, and the built-in
Feishu collaboration-channel plugin. One explicit `@bot` message becomes one
Intake Handoff through the public TypeScript SDK, and the canonical
Agent-authored Result returns to the original conversation through Subscription
and Signal delivery. Other lifecycle and Status events remain observable
Fabric facts and do not become assistant chat replies.

The local Node long-connection transport is complete: an `api` or `all` service
can connect outbound to an enterprise custom-app bot with the official SDK and
receive `im.message.receive_v1` through the same durable ingress without a
public IP, domain, or tunnel. The existing Webhook transport remains supported;
card actions remain Webhook-only.

The phase does not add intent inference, Agent reasoning, target ranking,
workflow automation, requirement-system writes, model/tool invocation or task
execution. Those remain responsibilities of the configured external Agent and
connected work systems.

## Phase 4B completion boundary

Phase 4B adds durable Connector ingress, Memory/PostgreSQL conformance,
fenced mapping workers, comparison-only reconciliation, Feishu webhook and
optional long-connection sources, explicit identity/action mapping, document
references, outbound Signal delivery, and a real HTTP/SDK round-trip proof.

It does not add an automation engine, Agent Brain, target-ranking algorithm,
Feishu content mirror, or execution runtime. Human work, Agent reasoning,
Codex coding, and external-system business logic remain outside Work Fabric.

## Phase 5 completion boundary

Phase 5 makes the collaboration network operable without changing its
authority model:

- structured audit, metrics, tracing, readiness, and bounded diagnostics;
- query projections for responsibility, timeline, delivery, dead letter,
  Connector ingress, and reconciliation visibility;
- operational actions expressed through existing authenticated APIs;
- a replaceable read-mostly Console using the same TypeScript SDK as humans,
  Agents, Connectors, and other services;
- deployment composition and performance baselines before scale claims.

The Console is not required for execution or handoff. It does not own state,
call storage directly, or receive a privileged domain bypass.

Completion evidence includes exact collaboration projection rebuilds; bounded
Memory, SQLite and PostgreSQL stores; shared HTTP/SDK query and recovery
contracts; append-only audit; low-cardinality semantic telemetry; restart-safe
SQLite local composition; a real HTTP/SDK lifecycle and authorization proof;
static dependency/sensitive-data gates; and a reproducible generated-data
performance baseline.

Phase 5 does not add target selection, scheduling intelligence, workflow
automation, Agent reasoning, model/tool execution, business-content storage or
an operator bypass. Worker roles run explicit mechanical turns selected by the
deployment; they are not an internal brain.

## Phase 6A completion boundary

Phase 6A adds a technology-neutral cluster SPI, tenant-fair bounded queues,
fenced partition leases, bounded Worker Hosts, PostgreSQL readiness discovery,
explicit API/worker/all roles and safe aggregate operations visibility.
Database polling is authoritative; metadata wakeups may be lost or duplicated.
Two-host fault injection proves polling recovery, duplicate coalescing and stale
owner rejection through the real HTTP/SDK Handoff lifecycle.

The four work kinds are mechanical owners only: Outbox wakeup, Handoff
projection, collaboration projection and Signal delivery. Phase 6A does not
select targets, schedule workflows, execute participant work, run models/tools
or add an Agent Brain. SQLite remains an explicit single-process profile and
rejects clustered ownership.

See [Clustered partition runtime](cluster-runtime.md) and the reproducible
[Phase 6A performance baseline](performance-cluster-baseline.md).

## Phase 6B completion boundary

Phase 6B adds a production NATS JetStream Adapter for strict 4,096-byte
metadata Wakeups, HMAC-isolated Tenant subjects, bounded explicit settlement,
declarative non-destructive topology management, official-server integration
proof and a reproducible performance baseline. The Phase 6A catalog and
persisted positions remain authoritative, and database polling remains active
during health, outage and recovery.

No public WFPP, HTTP or SDK contract changed. NATS dependencies are confined
to the technology-specific Adapter and deployment tools. Phase 6B does not
rank targets, schedule workflows, reason for Agents, call models/tools or
perform participant work. See [NATS Wakeup deployment](nats-wakeup-deployment.md)
and the [performance baseline](performance-nats-wakeup-baseline.md).

## Phase 7 completion boundary

Phase 7 adds the signed `workfabric.federation.v1` request/receipt profile for
an explicitly selected Source and Target Exchange. It includes closed JSON
Schemas, deterministic canonical digests, fixed-size Ed25519 signatures,
audience/TTL checks, explicit peer/key trust, replay-safe byte-identical
Receipts, stable rejection data and a technology-neutral Bridge/Transport seam.

The reference implementation includes bounded Memory replay behavior, a Node
Ed25519 Adapter, a reusable conformance profile, tamper/expiry/key-rotation and
retry/reconciliation tests, static dependency/telemetry gates, and a real
two-Exchange HTTP/TypeScript SDK proof. Each Exchange owns only its local
Handoff and applies a signed remote Receipt through a deployment-owned,
idempotent Bridge; no remote statement overwrites local state.

Phase 7 does not add peer discovery/ranking, target selection, cross-Exchange
queries, state replication, global ordering, two-phase commit, workflow
scheduling, Agent reasoning, model/tool calls or participant execution. HTTP
Federation transport, durable production Replay Stores and managed key custody
remain replaceable deployment Adapters. See [Cross-Exchange Federation](federation.md).
