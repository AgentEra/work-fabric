# Operations and collaboration visibility

Phase 5 makes the connection fabric observable and recoverable without moving
participant work into Work Fabric. All reads and recovery intents use the same
authenticated HTTP and TypeScript SDK path as Human, Agent, Connector and
customer-service clients. There is no database, Console or administrator
backdoor.

## Collaboration projections

`workfabric.collaboration.visibility.v1` derives three rebuildable views from
committed Handoff events and the Handoff read model:

- responsibility: current lifecycle, responsible participant, target, due
  dates and safe external work reference;
- timeline: public event identity, subject, source, Actor/Endpoint, causation
  and a bounded change summary;
- relationships: thread membership, parent/child, responsibility and target
  edges explicitly present in protocol facts.

Every page includes `projected_position`, `journal_position` and
`observed_at`. Consumers must display lag; a stale projection is not presented
as current. Rebuild clears only the tenant/partition projection, resets its
checkpoint and replays the immutable journal. It never changes a Handoff.

SDK methods are under `client.collaboration`; HTTP resources are
`/v1/responsibilities`, `/v1/timeline` and `/v1/relationships`.

## Operational views

`client.operations` and `/v1/operations/*` expose bounded, tenant-scoped facts:

| View | Content boundary |
|---|---|
| Projection status/failures | positions, lag, event ID and safe reason code |
| Delivery state/attempts/dead letters | positions, attempts, outcome and event identity; no event payload |
| Connector ingress | queue identity, state, attempt, timestamps and normalized error code; no callback body |
| Discrepancy | expected/observed state, version and acknowledgement facts; no external content |
| Audit | principal/representation, operation, resource, decision, outcome and safe reason code |

Cursors are opaque, signed and bound to the query/filter context. Page,
diagnostic and cursor sizes are bounded. Adapter identity mismatches fail
closed. PostgreSQL and SQLite operational-history adapters push the cursor
keyset and `limit + 1` into indexed storage queries; the service does not load
an identity's complete failure, attempt or dead-letter history to make one
page. Journal high-water reads use adapter-native indexed aggregation. Memory
adapters retain the technology-neutral scan fallback for bounded tests and
demonstrations only.

## Audit retention

Audit records are immutable and append-only until an explicit retention job
calls `pruneBefore(tenantId, occurredBefore, limit)`. Select the retention
period per tenant and compliance policy, export required records before
pruning, and use small repeated batches. PostgreSQL pruning uses tenant-scoped,
ordered, `SKIP LOCKED` batches. SQLite/local pruning remains single-process.

Audit never stores authorization headers, credentials, command bodies, Context
content or result text. Denied requests are records too; a denial must not
mutate the target resource.

## Recovery runbook

Recovery is explicit intent followed by a separately owned worker action:

1. Inspect the relevant projection, delivery, Connector or discrepancy fact.
2. Capture the current target version/position.
3. Submit one narrowly authorized recovery with a unique idempotency key,
   expected version, bounded reason code and explicit confirmation.
4. Observe the recovery record and audit trail.
5. Let an externally managed worker claim the request with a fenced lease and
   call only the matching recovery action port.
6. Re-inspect the read model; do not edit Handoff state or database rows.

Supported intents are Connector requeue, Delivery replay, projection rebuild
and discrepancy acknowledgement. Authority actions are target-specific, for
example `workfabric.operations.recovery.projection-rebuild.request.v1` on one
partition. Request idempotency prevents duplicate intent; expected-version and
worker fencing prevent stale action. Failure becomes a bounded recovery
outcome and audit record rather than fabricated success.

## Metrics, tracing and health

The semantic observer accepts only a fixed operation, outcome and category,
plus duration, count and an optional sanitized correlation ID. Metrics contain
only the three low-cardinality semantic labels. Correlation is trace-only.
Tenant, Actor, Handoff, event, resource, payload, content and credentials are
not metric labels or trace attributes.

- `/health/live` reports process liveness and shutdown state.
- `/health/ready` reports readiness without dependency detail.
- protected `/v1/admin/health` reports bounded dependency IDs, health and
  latency without raw errors.

Use `npm run check:sensitive-observability` as a release gate.

## Worker and ownership boundary

API, projector, delivery and Connector roles are deployment processes, not an
internal scheduler. `service-node` composes API, public Pull/Ack/SSE delivery,
Endpoint, projection, audit, operations and recovery request surfaces. A
projector turn is explicitly invoked for a selected partition. Connector,
outbound delivery and recovery workers keep their existing technology-neutral
ports and may be deployed independently with their external adapters.

Work Fabric does not decide which partition should run next, select a target,
reason about work, call a model, invoke Codex or perform the customer task.
