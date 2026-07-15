# Work Fabric HTTP Service Binding Design

## 1. Goal and status

Phase 3B turns the transport-free Exchange Application and Runtime services
into one independently runnable Node.js HTTP service. It gives humans, Agents,
Console clients, and external systems the same protocol, query, subscription,
and operations surface without moving execution, matching, scheduling, or
domain decisions into the HTTP process.

Phase 3A Target Resolution Protocol/Core is complete. Phase 3B covers the HTTP
service only. Phase 3C TypeScript SDK, outbound Webhook workers, Endpoint
Directory, Agent Gateway, Feishu, and Console remain separate later work.

## 2. Chosen architecture

Create `@work-fabric/transport-http` as a Node.js 22+ TypeScript ESM package.
Fastify is an internal server implementation because it provides mature
routing, lifecycle hooks, bounded payload handling, streaming support, and a
high-performance Node runtime. No public export may expose a Fastify type.

The package is split into small services:

- Command binding maps one canonical HTTP request to `ExchangeApplication`.
- Query binding reads existing public SPI stores and public Runtime views.
- Subscription binding manages authorized subscription resources and delegates
  Pull/Ack/SSE semantics to Runtime services.
- Health binding exposes bounded liveness, readiness, and protected dependency
  diagnostics.
- Node host owns listening, graceful shutdown, connection limits, and signal
  handling but has no domain knowledge.

Routes perform transport mapping only. They never call a decider, evolve a
Handoff, write a database directly, select a target, or infer responsibility.

## 3. Authentication and authority

`HttpRequestAuthenticator` is a public technology-neutral port owned by the
HTTP package. It receives bounded request authentication metadata and returns
the `JsonObject` authentication evidence expected by the configured
`IdentityProvider`. A default Bearer mapper reads `Authorization: Bearer ...`
without parsing or validating JWT claims. Static-token authentication is a
test/development implementation. OIDC/JWT verification remains an independent
Identity Adapter.

The HTTP layer must never log an Authorization value or authentication
evidence. It passes evidence to the same Identity Provider used by Exchange.

Commands carry `actor_id`, `endpoint_id`, and optional `delegation_id` in their
canonical WFPP Envelope. Query and operations requests carry the representation
claim in these headers:

- `X-WF-Actor-ID`
- `X-WF-Endpoint-ID`
- optional `X-WF-Delegation-ID`

Headers are claims, not authority. The Principal must contain the matching
trusted Actor/Endpoint representation, and `AuthorityPolicy` must explicitly
allow the route action and resource. Humans, Agents, Console clients, and
external services use the same endpoints. Participant and Admin/Operations
access differ only by authority action.

The stable authority actions are:

| Route group | Authority action | Resource |
|---|---|---|
| Handoff model and events | `workfabric.query.handoff.read.v1` | Handoff ID |
| Subscription get | `workfabric.subscription.read.v1` | Subscription ID |
| Subscription put | `workfabric.subscription.manage.v1` | Subscription ID |
| Pull | `workfabric.subscription.pull.v1` | Subscription ID |
| Ack | `workfabric.subscription.ack.v1` | Subscription ID |
| SSE | `workfabric.subscription.stream.v1` | Subscription ID |
| Partition models/events | `workfabric.operations.partition.read.v1` | Partition ID |
| Admin subscription list | `workfabric.operations.subscription.list.v1` | authenticated tenant ID |
| Projection failures | `workfabric.operations.projection-failure.list.v1` | Partition ID |
| Delivery state | `workfabric.operations.delivery.read.v1` | Subscription ID |
| Dependency health | `workfabric.operations.health.read.v1` | null |

## 4. Command API

`POST /v1/commands` accepts one complete WFPP `CommandEnvelope` as JSON. The
route authenticates the request, delegates validation, identity, authority,
idempotency, versioning, and state mutation to `ExchangeApplication.handle`,
and returns its standard `OperationResult` unchanged.

HTTP does not create separate Offer, Accept, Resolve, Result, or Verify REST
models. Phase 3C may expose friendly SDK methods, but every method sends the
same canonical command representation.

For Capability-targeted public Offers, service composition requires a
configured `TargetEligibilityVerifier`. Direct Actor/Endpoint deployments do
not require a Resolver. Resolution verification that is missing or unavailable
continues to fail closed according to Phase 3A.

## 5. Query and operations API

Every query calls a bounded `ExchangeQueryService` facade backed by existing
SPI or Runtime services. The facade accepts explicit tenant, cursor, and limit
inputs and returns immutable public views. The reference implementation can
compose the current Journal/read-model/runtime stores; a production
implementation can issue native bounded queries. No route receives a SQL
client or concrete storage Adapter, and the HTTP contract does not depend on
which query implementation is selected.

### Participant and resource views

- `GET /v1/handoffs/{id}` returns the authorized Handoff read model.
- `GET /v1/handoffs/{id}/events?from_version=N&limit=N` returns safe Protocol
  Events, never internal `domain_data` or storage cursor metadata.
- `GET /v1/subscriptions/{id}` returns an authorized subscription.
- `PUT /v1/subscriptions/{id}` validates and creates or replaces an authorized
  subscription resource whose body ID matches the path ID.
- `POST /v1/subscriptions/{id}/pull` returns a bounded event page and next
  opaque cursor.
- `POST /v1/subscriptions/{id}/ack` explicitly acknowledges an opaque cursor.
- `GET /v1/subscriptions/{id}/events` presents the same durable subscription as
  an SSE stream.

### Admin and operations views

- `GET /v1/partitions/{id}/handoffs?limit=N` lists projected Handoffs.
- `GET /v1/partitions/{id}/events?after_position=N&limit=N` lists safe Protocol
  Events in partition order.
- `GET /v1/admin/subscriptions?limit=N` lists active subscriptions only for the
  authenticated Principal tenant.
- `GET /v1/admin/projection-failures?projector_id=...&partition_id=...&limit=N`
  returns bounded failure summaries.
- `GET /v1/admin/delivery-attempts?subscription_id=...&event_id=...&limit=N`
  returns delivery history.
- `GET /v1/admin/delivery-position?subscription_id=...&partition_id=...`
  returns the durable position.
- `GET /v1/admin/health` returns protected dependency status.

All collection endpoints have a fixed default and hard maximum limit. Phase 3B
does not add arbitrary filtering, SQL-like expressions, full-text search, or a
GraphQL surface.

## 6. Cursor Pull, Ack, and SSE

Pull and SSE are two presentations of the same Durable Subscription. Neither
creates a second delivery ledger.

- Pull returns standard Protocol Events plus a signed opaque cursor.
- Ack advances durable delivery position through the existing Runtime service.
- SSE frames contain one Protocol Event as JSON.
- SSE `id` is the opaque delivery cursor; the Protocol Event keeps its own
  stable CloudEvent `id` in the data.
- `Last-Event-ID` resumes from the opaque cursor after reconnect.
- Unacknowledged delivery may repeat, preserving at-least-once semantics.
- Heartbeat comments keep a connection alive but never advance a cursor.
- Disconnect aborts pending reads and releases connection resources.
- Per-connection batch size, polling interval, idle timeout, and concurrent SSE
  connection count are bounded configuration.

WebSocket is not part of Phase 3B. A future WebSocket Binding must reuse the
same protocol and durable position semantics rather than becoming a new state
channel.

## 7. Health and lifecycle

`GET /health/live` is unauthenticated and reveals only whether the process event
loop and router are alive. `GET /health/ready` is unauthenticated and returns a
single ready/not-ready result without dependency names or error text.
`GET /v1/admin/health` is authenticated and authorized, returning bounded
dependency checks with status, observed timestamp, and latency only.

The Node host supports graceful shutdown: stop accepting connections, close or
abort SSE streams, wait for in-flight requests up to a configured deadline,
then close the server. Health becomes not-ready as soon as shutdown starts.

## 8. Response and error contract

Command responses always use `OperationResult`. HTTP status is a transport
summary, while the body remains authoritative:

| Operation result | HTTP status |
|---|---:|
| accepted | 200 |
| rejected / invalid_argument | 400 |
| rejected / unauthenticated | 401 |
| rejected / permission_denied | 403 |
| rejected / not_found | 404 |
| other deterministic rejected outcomes | 422 |
| conflict | 409 |
| temporarily_unavailable | 503 |

Query, subscription-management, health-detail, and transport failures use RFC
9457 Problem Details with a stable Work Fabric error code extension. Problem
responses never contain stack traces, SQL, credentials, Adapter configuration,
internal `domain_data`, candidate scores, or full sensitive Context.

The server rejects unsupported media types, invalid JSON, excessive bodies,
invalid pagination, duplicate singleton headers, invalid opaque cursors, and
requests exceeding configured deadlines before unsafe side effects.

## 9. Operational safety

Configuration sets exact limits for JSON bytes, query page size, request
deadline, header bytes, SSE connections, SSE batch size, polling interval,
heartbeat interval, and graceful shutdown timeout. Defaults are conservative
and validation rejects unsafe or nonsensical values at startup.

Structured request logs contain request ID, tenant after authentication,
verified Actor/Endpoint, route, response status, and duration. They omit tokens,
authentication evidence, request bodies, full Context, and internal errors.
Correlation headers may be returned but do not replace WFPP correlation and
causation fields.

## 10. Testing and acceptance

Fastify injection tests cover every route without opening a port. One black-box
suite runs the Node host on an ephemeral loopback port. Tests prove:

- Bearer evidence and representation claims are authenticated and authorized;
- invalid, unauthorized, conflicting, and unavailable commands map correctly;
- Capability Offer → external Resolve Target → recipient Accept round-trips
  through public HTTP with Requirement and Target Binding still queryable;
- same command idempotency key replays the prior result;
- Handoff and Event queries never expose private Event/storage fields;
- subscription validation, Pull, Ack, SSE reconnect, heartbeat, backpressure,
  and disconnect preserve at-least-once semantics;
- liveness, bounded readiness, protected dependency health, and graceful
  shutdown behave deterministically;
- malformed and excessive input is rejected without domain writes;
- Core and SPI dependency guards continue to reject HTTP/Fastify imports;
- full repository tests and WFPP conformance remain green.

Phase 3B is complete only when the public HTTP reference flow uses no private
Core import or direct Adapter/database access from the route layer. Completion
does not mark Phase 3C SDK or Phase 3 as a whole complete.
