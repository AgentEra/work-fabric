# Work Fabric Endpoint and Local Agent Boundary Design

## 1. Goal and phase boundary

Phase 4A adds the first production-shaped participation boundary for native
Agent endpoints. It lets an authorized administrator provision an Endpoint,
lets an external local Agent Runtime establish and renew a fenced session,
exposes authorized Endpoint and Capability facts to external Resolvers, uses
those facts to validate an explicit Target Resolution, and gives the Runtime a
durable SDK-based path to receive Handoff notifications and submit its own
Accept, Status, Result, or Decline decisions.

The phase remains inside Work Fabric's approved product boundary:

- Work Fabric owns Endpoint facts, leases, capability declarations, inbox
  routing facts, protocol delivery, acknowledgement, and auditability.
- The Agent Runtime owns reasoning, planning, model and tool selection, Codex
  invocation, professional work, and the decision whether to accept a Handoff.
- A Human, rule service, or Agent Brain Resolver owns candidate comparison and
  explicit target choice.
- The Gateway transports facts and explicit decisions. It does not execute a
  handler, call a model, select a target, automatically accept responsibility,
  or automatically acknowledge a Delivery.

Phase 4A does not include Feishu. Phase 4B will implement the Feishu Connector
against the same SDK, Endpoint, Handoff, Subscription, and Work Reference
contracts after 4A is complete.

## 2. Chosen approach

Use a **Directory-first, SDK-based Gateway**.

The alternatives are rejected:

1. A static-config Gateway would demonstrate one Runtime quickly, but it would
   duplicate capability, identity, lease, and eligibility rules when the
   Directory is later introduced.
2. Embedding an Agent Runtime or handler inside the Exchange process would make
   local invocation easy, but it would turn the connection layer into an
   execution host and violate the project's central boundary.

The selected topology is:

```text
Administrator
    |
    | provision / disable
    v
Endpoint Directory <------ authorized facts ------ External Resolver
    ^                                                  |
    | session / heartbeat                              | resolveTarget
    |                                                  v
Local Agent Gateway ---- HTTP + TypeScript SDK ---- Work Fabric Exchange
    ^                                                  |
    | incoming Handoff Delivery                        | Durable Subscription
    | explicit Agent decision                          v
External Local Agent Runtime <---------------- Endpoint Inbox Partitions
```

Node.js and TypeScript are the complete reference runtime. The public contracts
remain transport-neutral; Phase 4A binds them through the existing HTTP service
and TypeScript SDK. Local IPC remains a future Binding and is not silently
implemented as an in-process callback.

## 3. Logical modules and dependency direction

```text
packages/
  exchange-spi/                 Endpoint, lease and inbox storage ports
  endpoint-directory/           validation, session and discovery services
  adapter-endpoint-memory/      executable reference stores
  adapter-storage-postgres/     durable Endpoint/session/inbox records
  exchange-runtime/             Endpoint inbox projection
  transport-http/               authorized Endpoint and session routes
  sdk-typescript/               endpoints logical client
  agent-gateway/                external Runtime connection/session library
  exchange-conformance/         reusable Directory and Gateway profiles
```

Dependency direction is one-way:

```text
protocol schemas
      |
exchange-spi
      |
endpoint-directory / exchange-runtime
      |
memory or PostgreSQL adapters
      |
HTTP binding
      |
TypeScript SDK
      |
Local Agent Gateway
      |
external Agent Runtime
```

`exchange-core` and `exchange-spi` do not import HTTP, PostgreSQL, the SDK, the
Gateway, an Agent Runtime, or a model/tool library. `agent-gateway` imports only
the public SDK and its own bounded connection utilities. It does not import an
Exchange Decider, persistence Adapter, Fastify, or Agent execution framework.

## 4. Public resource model

### 4.1 Provisioned Endpoint

An administrator provisions an `EndpointRegistration` with:

- `endpoint_id` and immutable owning `ActorRef`;
- endpoint type and display name;
- allowed WFPP protocol versions;
- allowed Binding types and public Binding URIs;
- the capability IDs this Endpoint may declare at runtime;
- bounded Endpoint limits;
- `enabled` or `disabled` administrative state;
- a positive `registration_version` for optimistic concurrency;
- bounded extensions without credential material.

Provisioning does not make the Endpoint available. It only establishes which
Actor it may represent and the maximum facts it may declare. The request never
contains a bearer token, refresh token, client secret, private key, executable
tool definition, prompt, or model configuration.

The existing canonical `EndpointDescriptor`, `CapabilityDescriptor`, and
`BindingDescriptor` remain the public projection vocabulary. A projected
Endpoint Descriptor combines provisioned identity/binding facts with the
current active session's capabilities, availability, and lease timestamps.

### 4.2 Runtime session

An authenticated Runtime opens one session for a provisioned Endpoint by
submitting:

- a caller-generated `client_session_id` used for idempotent replay;
- one supported protocol version;
- current Capability Descriptors, restricted to provisioned capability IDs;
- `available`, `busy`, `draining`, or `unavailable` availability;
- a requested lease duration within the service's configured bounds;
- the expected `registration_version`.

The service returns:

- server-generated `session_id`;
- monotonically increasing positive `fencing_token` for that Endpoint;
- `expires_at`, `renew_after`, and accepted lease duration;
- canonical projected Endpoint Descriptor.

There is one authoritative active session per Endpoint. A new session
atomically fences the previous session. Replaying the same
`client_session_id` and identical request returns the original session;
reusing it with different content is a conflict.

### 4.3 Heartbeat and close

A heartbeat includes `session_id`, `fencing_token`, a monotonically increasing
`heartbeat_sequence`, current availability, and current Capability
Descriptors. It renews only the matching unfenced active session. Replaying an
identical sequence is idempotent; a stale sequence, token, registration
version, or session returns conflict and never changes availability.

Graceful close uses the same fencing token and final sequence. It changes the
session to `closed` and the Endpoint projection to unavailable. Process crash
requires no worker for correctness: reads compare `expires_at` with the
injected clock, so an expired session immediately disappears from eligible and
available views. A later reaper may compact expired session projections but is
not the source of truth.

## 5. Authorization and trust

Provisioning, session management, facts discovery, inbox access, and target
eligibility use distinct Authority actions:

```text
workfabric.endpoint.provision.v1
workfabric.endpoint.disable.v1
workfabric.endpoint.session.open.v1
workfabric.endpoint.session.heartbeat.v1
workfabric.endpoint.session.close.v1
workfabric.endpoint.read.v1
workfabric.endpoint.discover.v1
workfabric.endpoint.inbox.read.v1
```

An administrator provisions the Actor binding. A Runtime Principal may open or
renew a session only when Identity and Authority prove it may represent the
provisioned Actor through that Endpoint. Header or payload claims alone never
grant this right.

Discovery is tenant-scoped, authorized, bounded, and secret-free. It returns
facts, not authorization decisions. Disabled, expired, or unauthorized
Endpoints are omitted rather than revealed through different error text.

Session IDs and fencing tokens are protocol control data. The SDK and Gateway
must not include them in logs or generic errors. Tokens are not credentials,
but treating them as bounded sensitive control data prevents stale-session
leakage.

## 6. Capability discovery and eligibility

Discovery accepts structured filters only:

- capability ID;
- optional version constraint;
- required input and output media types;
- optional availability set;
- opaque page cursor and positive bounded limit.

Results use a deterministic opaque pagination order and contain no score,
rank, recommendation, cost estimate, load prediction, or selected target. The
Directory may filter impossible candidates, but it cannot choose among valid
candidates.

The Directory-backed `TargetEligibilityVerifier` evaluates the one explicit
Actor or Endpoint submitted by an external Resolver. It checks:

1. tenant and Exchange scope;
2. provisioned and enabled state;
3. active, unfenced, unexpired session;
4. `available` runtime state;
5. matching capability ID;
6. semantic-version constraint;
7. required input/output media type inclusion;
8. optional requirement constraints through a technology-neutral
   `CapabilityConstraintEvaluator`.

An Endpoint target validates that Endpoint. An Actor target is eligible when
at least one active Endpoint bound to that Actor satisfies the requirement;
the verifier does not select or persist one of those Endpoints.

Unknown constraint semantics fail closed. If a requirement contains non-empty
constraints and no compatible evaluator is configured, the verifier returns
`unavailable`; it does not ignore the constraint or guess.

Directory/storage failure returns `unavailable`. A known mismatch returns
`ineligible`. Reasons are bounded machine-oriented codes and never contain
Endpoint secrets, internal exception text, or candidate lists.

## 7. Endpoint inbox and multi-partition delivery

Existing durable Subscription positions remain `Subscription × Partition` and
there is no global Event order. A local Agent cannot safely discover new work
by guessing partition IDs, so Phase 4A adds an `EndpointInboxProjection`.

The projection consumes committed Handoff Events and stores only routing facts:

- tenant, Endpoint/Actor audience, partition ID, Handoff ID;
- latest Handoff resource version and lifecycle state;
- last relevant Event ID and observed position;
- whether the routing fact is currently active.

It does not copy Context, result bodies, prompts, or private execution state.
It is rebuildable from the Journal and never becomes an authoritative
Assignment or Handoff state.

The SDK exposes a bounded, authorized query for active inbox partitions. The
Gateway periodically refreshes that list and opens one existing durable SSE
stream per partition, subject to a configured maximum. Each stream retains its
own opaque cursor and Ack position. No cross-partition ordering is promised.

At startup the Gateway creates or verifies one configured public WFPP
Subscription owned by the provisioned Agent Actor and Endpoint. The
Subscription uses SSE mode and an empty semantic filter; the existing default
delivery policy still restricts every Event by tenant and the Event Record's
participant audience. If an existing Subscription has different ownership,
Endpoint, mode, or filter, startup fails instead of overwriting it. The Gateway
does not maintain a private notification table or bypass the durable Delivery
ledger.

When a new routing fact appears, the partition query makes it visible. The
Gateway does not infer priority or decide which Handoff should execute first;
it multiplexes received Deliveries into a bounded `AsyncIterable` in arrival
order. Backpressure stops additional reads rather than auto-Acking or dropping
Deliveries.

## 8. HTTP and TypeScript SDK surface

The HTTP binding adds:

```text
PUT    /v1/admin/endpoints/{endpoint_id}
GET    /v1/endpoints/{endpoint_id}
GET    /v1/endpoints?capability_id=...&cursor=...&limit=...
POST   /v1/endpoints/{endpoint_id}/sessions
POST   /v1/endpoints/{endpoint_id}/sessions/{session_id}/heartbeat
POST   /v1/endpoints/{endpoint_id}/sessions/{session_id}/close
GET    /v1/endpoints/{endpoint_id}/inbox/partitions?cursor=...&limit=...
```

Routes perform authentication, representation validation, Authority checks,
Schema validation, bounded encoding, and service invocation. They do not
query concrete PostgreSQL clients, evaluate Handoff transitions, choose a
target, open Agent tools, or invoke the Gateway.

The TypeScript SDK adds `client.endpoints`:

```ts
client.endpoints.provision(registration, options)
client.endpoints.get(endpointId, options)
client.endpoints.discover(input, options)
client.endpoints.openSession(endpointId, input, options)
client.endpoints.heartbeat(endpointId, sessionId, input, options)
client.endpoints.closeSession(endpointId, sessionId, input, options)
client.endpoints.listInboxPartitions(endpointId, input, options)
```

Every ID and query value is structurally encoded. Provision, open, heartbeat,
and close are not automatically retried by the SDK. Each write carries its own
idempotency or sequence contract so the Gateway can explicitly replay the same
logical request after an ambiguous network failure.

Problem Details, request IDs, manual redirect rejection, authentication
refresh, timeout, Abort, and safe error behavior reuse the Phase 3C transport.

## 9. Local Agent Gateway API

`@work-fabric/agent-gateway` is a client-side connection library, not a server
or Runtime framework. Its main abstraction is an `AgentEndpointSession`:

```ts
const session = await gateway.start({ signal });

for await (const incoming of session.incoming()) {
  // External Runtime decides what to do.
  await persistLocally(incoming.delivery);
  await incoming.acknowledgeSignal("acknowledged");

  const decision = await externalAgentBrain.decide(incoming.handoff);
  if (decision.kind === "accept") {
    await session.handoffs.accept(
      { handoff_id: incoming.handoff.handoff_id },
      decision.commandOptions,
    );
  }
}
```

The example intentionally places `externalAgentBrain` outside the Gateway.
The package itself exposes no `handler`, `execute`, `runTask`, `model`, `tool`,
or `codex` callback.

The Gateway owns only connection mechanics:

- open and explicitly replay a Runtime session request;
- renew the lease on the server-provided schedule;
- stop on a fencing conflict instead of silently stealing the session;
- refresh authorized inbox partitions;
- maintain bounded per-partition SSE streams;
- expose received Delivery plus the current Handoff read model;
- expose explicit Signal Ack and the unchanged Handoff SDK client;
- close streams and mark the Endpoint draining/closed on graceful shutdown.

Signal acknowledgement and responsibility acceptance are separate operations.
Acknowledging a Delivery means the Runtime durably received the notification;
it does not accept the Handoff. Accepting a Handoff changes responsibility but
does not implicitly acknowledge any Event Delivery. The Gateway never couples
the two.

## 10. State, concurrency, and persistence

The stable storage ports cover:

- provisioned Endpoint registration with expected-version update;
- idempotent open-session record keyed by Endpoint and client session ID;
- active session compare-and-swap using fencing token and heartbeat sequence;
- immutable session attempt/history records;
- active Endpoint and capability query by tenant;
- rebuildable Endpoint inbox routing facts and page cursor.

The Memory Adapter is the executable reference. PostgreSQL adds tenant-owned
tables, RLS, unique idempotency keys, expected-version conditions, monotonic
fencing tokens, lease expiry indexes, capability lookup indexes, and inbox
partition indexes through the existing migration toolchain.

No transaction spans the Directory and Handoff Journal. Target eligibility is
a read-side precondition evaluated immediately before the existing Handoff
decision. Existing optimistic concurrency still decides whether the explicit
resolution commits. A session expiring after validation does not rewrite an
already committed Target Binding; loss of availability becomes transparent
through lease/inbox facts and a later explicit re-Handoff or human action.

## 11. Failure behavior

| Failure | Required behavior |
|---|---|
| Duplicate provision/open/heartbeat | Return the original result only when the semantic request is identical |
| Stale registration version | Conflict; no mutation |
| Stale session or fencing token | Conflict; stop that Gateway session |
| Lease expiry | Immediately unavailable to discovery and eligibility |
| Directory unavailable during resolution | Fail closed as `unavailable`; no Handoff Event |
| Unknown capability constraint | Fail closed; do not ignore it |
| SSE disconnect | Bounded SDK reconnect with per-partition cursor |
| New inbox partition | Discovered by bounded refresh and streamed independently |
| Gateway buffer full | Apply backpressure; do not Ack, drop, or auto-accept |
| Runtime process crash | Lease expires; unacknowledged Delivery remains replayable |
| Graceful shutdown | Mark draining, close streams, close fenced session |
| Agent declines | Submit standard Decline; never auto-resolve another target |

Failures never include credentials, Context content, Event Delivery bodies,
candidate lists, or raw dependency exceptions in public errors.

## 12. Configuration and bounds

The service configuration includes positive bounded values for:

- minimum/default/maximum Endpoint lease duration;
- renew-ahead fraction or duration;
- maximum capabilities and bindings per Endpoint;
- maximum discovery and inbox page size;
- maximum active inbox partitions per Gateway session;
- Gateway inbox refresh interval;
- Gateway incoming queue capacity;
- heartbeat retry count and bounded backoff for explicit same-request replay;
- graceful close deadline.

Defaults are conservative. Limits are enforced at construction and at public
boundaries. No unbounded candidate list, capability document, stream count, or
Gateway queue is permitted.

## 13. Testing and conformance

Acceptance requires:

- Schema positives and negatives for registrations, sessions, heartbeats,
  projected descriptors, discovery pages, and inbox partition pages;
- reusable Memory and PostgreSQL store profiles for tenant isolation,
  immutability, optimistic concurrency, idempotency, lease expiry, session
  replacement, fencing, heartbeat replay, and pagination;
- Directory service tests with an injected clock and ID generator;
- eligibility tests for Actor and Endpoint targets, version/media matching,
  availability, expiry, unknown constraints, and dependency failure;
- HTTP authorization tests proving administrator, Runtime, Resolver, and
  unrelated principals do not share authority;
- SDK tests for exact routes, encodings, no automatic write retry, Abort, and
  Problem Details;
- inbox projector rebuild, multi-partition, deactivation, and tenant-isolation
  tests;
- Gateway tests for lease renewal, fencing stop, bounded streams, partition
  refresh, backpressure, Delivery replay, explicit Ack, and clean shutdown;
- a real black-box reference flow: provision Endpoint → start local Gateway →
  discover facts → external Resolver selects and resolves → Runtime receives
  Delivery → explicitly Acks → explicitly Accepts → reports Status → returns
  Result;
- negative proof that no Gateway code imports or invokes Agent reasoning,
  models, tools, Codex, an Exchange Decider, or concrete storage;
- full repository verification and WFPP conformance remain green.

The reference Agent is a deterministic test double controlled by the test. It
is not embedded production execution behavior.

## 14. Delivery decomposition

Phase 4A is implemented in independently reviewable increments:

1. protocol resource Schemas and stable SPI;
2. Directory service and Memory Adapter;
3. PostgreSQL persistence and conformance;
4. Directory-backed eligibility verifier;
5. Endpoint inbox projection and partition query;
6. authorized HTTP resource surface;
7. TypeScript SDK `endpoints` client;
8. Local Agent Gateway connection library;
9. real service/Gateway reference flow, documentation, and performance bounds.

Phase 4B starts only after these gates pass. It maps Feishu messages, cards,
human actions, and document references into the same Work Reference, Handoff,
Subscription, and explicit command surfaces; it does not change the 4A
Directory or make Feishu authoritative.

## 15. Completion boundary

Phase 4A is complete when a provisioned local Agent Endpoint can maintain a
fenced lease, appear as an authorized unranked capability fact, be explicitly
selected by an external Resolver, receive its Handoff through durable
multi-partition connection mechanics, and explicitly Ack and participate
through the standard SDK while all execution remains outside Work Fabric.

Completion does not claim automatic scheduling, an Agent brain, Codex
execution, Local IPC, A2A/MCP, Feishu, Webhook Worker, OIDC, Console, global
Event order, or production deployment composition.
