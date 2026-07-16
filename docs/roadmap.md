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
| 6 | High-throughput Signal and clustered partition execution | Planned |
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

## Phase 6 intent

Phase 6 may add broker-backed Signal acceleration, horizontally coordinated
partition ownership, load shedding and production concurrency baselines. It
must preserve partition ordering, explicit Ack, fenced ownership, the public
WFPP/SDK contracts and the execution boundary. Scale work is not permission to
rank targets or decide/perform participant work.
