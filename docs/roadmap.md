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
| 7 | Cross-Exchange federation profile | Planned |

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
