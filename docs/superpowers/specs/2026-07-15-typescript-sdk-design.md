# Work Fabric TypeScript SDK Design

**Implementation status:** Phase 3C is complete. The package, real HTTP black-box reference flow, runtime-boundary guards, and repository verification implement this design without expanding the Exchange into an execution engine.

## 1. Goal and phase boundary

Phase 3C adds `@work-fabric/sdk-typescript`, a universal Fetch-based client for
the Phase 3B HTTP Service Binding. Node.js 22+ is the primary runtime and full
verification environment. Modern browsers are supported through the same Web
API implementation when `fetch`, `ReadableStream`, `AbortController`, and
`TextDecoder` are available.

The SDK improves type safety, authentication injection, command-envelope
construction, error handling, retry control, and durable subscription
consumption. It does not create a second protocol, state store, workflow
engine, scheduler, Resolver, Agent brain, or execution runtime. Human, Agent,
Connector, Console, and operations clients use the same SDK core; authority is
still decided by the server.

Phase 3C does not include a Console, Feishu Connector, Agent Gateway, Webhook
Worker, OIDC implementation, Endpoint Directory, generated OpenAPI client, or
automatic work execution.

## 2. Chosen architecture

Use one package and one `WorkFabricClient` with focused logical clients:

```text
WorkFabricClient
├── commands       canonical Command transport
├── handoffs       typed convenience command builders
├── queries        participant and partition reads
├── subscriptions  resource, Pull, Ack, and SSE APIs
└── operations     protected health and operational reads
```

The alternatives are rejected as follows:

- An OpenAPI-generated client would map HTTP shapes quickly but would not
  encode WFPP idempotency, explicit Ack, at-least-once SSE, and OperationResult
  semantics clearly enough.
- Separate Node, browser, Agent, and Admin clients would fragment behavior and
  contradict participant equality.
- A stateful SDK cache would duplicate Exchange authority and create stale
  client-side lifecycle decisions.

The package has no runtime dependency on Fastify, Exchange Deciders, storage
Adapters, Node built-ins, or a particular Fetch implementation. It may use
`import type` from existing Work Fabric packages so the existing canonical
types remain the source of truth. Browser-compatible JavaScript must contain
only Web Platform APIs.

## 3. Public client configuration

The primary public shape is:

```ts
export interface AuthenticationProvider {
  getAuthorization(input: {
    readonly method: string;
    readonly url: string;
    readonly signal: AbortSignal;
  }): Promise<string | null>;
}

export interface RepresentationContext {
  readonly actorId: string;
  readonly endpointId: string;
  readonly delegationId?: string;
}

export interface WorkFabricClientOptions {
  readonly baseUrl: string;
  readonly authentication: AuthenticationProvider;
  readonly representation: RepresentationContext;
  readonly tenantId: string;
  readonly exchangeId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: { now(): string };
  readonly messageIdGenerator?: { nextMessageId(): string };
  readonly requestTimeoutMs?: number;
  readonly queryRetry?: Partial<QueryRetryPolicy>;
  readonly streamReconnect?: Partial<StreamReconnectPolicy>;
}
```

`baseUrl` must be an absolute `http:` or `https:` URL with no credentials,
query, or fragment. Plain HTTP is permitted for local and explicitly configured
deployments; the SDK does not silently upgrade or redirect it. A custom Fetch
is the Node extension point for proxies, Undici dispatchers, test doubles, or
special TLS policy.

The SDK supplies a `BearerTokenProvider` for static or asynchronous tokens. It
does not validate JWT claims, persist credentials, or include a localStorage
provider. Authentication is requested for every HTTP attempt so an external
provider can refresh short-lived credentials.

The default representation is applied to Query, Subscription, SSE, and
operations requests. `withRepresentation(context)` returns a new immutable
client sharing transport configuration. This supports a trusted process that
represents multiple Actors without mutating global client state. Command
Envelopes carry the selected Actor, Endpoint, and optional Delegation in their
canonical fields.

## 4. Command and Handoff APIs

`client.commands.send(envelope, options?)` sends one complete canonical
`CommandEnvelope` to `POST /v1/commands` and returns the unchanged
`OperationResult`. It never changes identifiers, timestamps, payload, expected
version, correlation, or causation supplied by the caller.

`client.handoffs` provides typed convenience methods for every interaction in
`protocol/spec/interaction-payloads.json`:

- `offer`
- `resolveTarget`
- `reportTargetUnavailable`
- `accept`
- `decline`
- `expire`
- `cancel`
- `reportStatus`
- `returnResult`
- `verify`
- `close`
- `requestRework`
- `transfer`

Convenience methods construct the same canonical Envelope and delegate to
`commands.send`. Their common options are:

```ts
export interface NewCommandOptions {
  readonly idempotencyKey: string;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface ExistingHandoffCommandOptions extends NewCommandOptions {
  readonly expectedVersion: number;
}
```

`idempotencyKey` is mandatory and never generated by the SDK. A retrying
caller must reuse it. `messageId` may be generated per attempt from the
injected generator, and `sent_at` comes from the injected clock. Existing
Handoff mutations require an explicit positive `expectedVersion`.

Capability Offer keeps the original Capability Requirement unchanged.
`resolveTarget` accepts exactly one explicit Actor or Endpoint target plus
evidence and does not discover, rank, or choose a candidate. Empty evidence is
normalized to an empty array only at this SDK boundary.

Domain rejection, conflict, permission failure, and temporarily unavailable
outcomes remain ordinary `OperationResult` values. Convenience methods do not
throw merely because `operation_status` is not `accepted`.

## 5. Query and operations APIs

The Query surface mirrors the bounded Phase 3B HTTP resources:

```ts
client.queries.getHandoff(handoffId, options?)
client.queries.listHandoffEvents(handoffId, options?)
client.queries.listPartitionHandoffs(partitionId, options?)
client.queries.listPartitionEvents(partitionId, options?)

client.operations.listSubscriptions(options?)
client.operations.listProjectionFailures(input, options?)
client.operations.listDeliveryAttempts(input, options?)
client.operations.getDeliveryPosition(input, options?)
client.operations.getHealth(options?)
client.operations.getLiveness(options?)
client.operations.getReadiness(options?)
```

IDs and query values are encoded with `URL` and `URLSearchParams`; callers
cannot append raw query fragments. Page limits and positions are validated as
safe integers before I/O. Query output is returned as immutable TypeScript
views and is not cached by the SDK.

Participant and operations methods share the same transport and
Authentication Provider. The SDK does not add an Admin token, tenant query
parameter, database access, or privileged back channel.

## 6. Durable Subscription APIs

The Subscription surface is:

```ts
client.subscriptions.get(subscriptionId, options?)
client.subscriptions.put(subscription, options?)
client.subscriptions.pull(subscriptionId, input, options?)
client.subscriptions.acknowledge(input, options?)
client.subscriptions.acknowledgeDelivery(delivery, outcome, options?)
client.subscriptions.stream(subscriptionId, input, options?)
  // AsyncIterable<EventDelivery>
```

`put` uses the public WFPP Subscription representation, not internal
`RuntimeSubscription` fields. Pull returns the server's `idle` or `delivery`
result unchanged. Ack accepts the canonical Delivery Ack. The convenience
`acknowledgeDelivery` copies `delivery_id`, `subscription_id`,
`next_cursor`, and the last Protocol Event ID from one Event Delivery, but the
caller must still choose `acknowledged`, `retry`, or `rejected` explicitly.

SSE uses authenticated Fetch streaming rather than native `EventSource`,
because browsers cannot reliably attach the required Authorization and
representation headers through `EventSource`. The parser accepts SSE line
fragmentation across arbitrary byte chunks, CRLF or LF, comments, and multiple
`data:` lines. It requires event type `workfabric.delivery`, an opaque `id`, and
a canonical Event Delivery containing exactly one Protocol Event. The SSE `id`
must equal `delivery.next_cursor`.

`stream` supports an initial opaque cursor and passes the last received cursor
as `Last-Event-ID` after reconnect. It yields repeated unacknowledged
Deliveries, preserving at-least-once behavior. It never automatically Acks,
deduplicates across reconnects, advances local position, or runs Event handler
code. Abort ends reads, backoff waits, and reconnect attempts promptly.

## 7. Errors, timeouts, redirects, and retries

The SDK exposes two thrown error families:

```ts
class WorkFabricHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly problem: ProblemDetails;
}

class WorkFabricTransportError extends Error {
  readonly code:
    | "network_error"
    | "timeout"
    | "aborted"
    | "redirect_rejected"
    | "invalid_response"
    | "stream_protocol_error"
    | "stream_reconnect_exhausted";
  readonly requestId: string | null;
  readonly cause?: unknown;
}
```

Problem Details from Query, Subscription, and operations endpoints become
`WorkFabricHttpError`. Network failures, local timeout, explicit Abort,
redirect, invalid JSON, structurally invalid success bodies, and malformed SSE
become `WorkFabricTransportError`. Neither error includes Authorization,
request bodies, Context content, or Event Delivery content in its message.

Every request accepts an external `AbortSignal` and uses a positive bounded
timeout. The implementation combines them without depending on
`AbortSignal.any`, so supported browsers do not need a Node-specific API.

Fetch uses `redirect: "manual"`. Any 3xx response, browser opaque redirect, or
success response whose final Origin differs from the configured Origin is
rejected. The SDK does not forward Authorization across a redirect.

Command, Pull, and Ack calls are never automatically retried. Queries may use
a bounded retry policy for network errors, `429`, and `503` only. The default is
two additional attempts with exponential backoff capped at one second and
honors a bounded `Retry-After`. Tests inject a sleeper and random source
internally for determinism; these are not public business concepts.

SSE reconnect has its own bounded policy. The default permits five reconnects,
resets the failure count after a valid Delivery, and uses exponential backoff
capped at five seconds. A clean Abort is not reported as reconnect exhaustion.

## 8. Package and source boundaries

Create:

```text
packages/sdk-typescript/
├── package.json
├── src/
│   ├── index.ts
│   ├── client.ts
│   ├── config.ts
│   ├── authentication.ts
│   ├── errors.ts
│   ├── transport.ts
│   ├── retry.ts
│   ├── protocol-types.ts
│   ├── command-client.ts
│   ├── handoff-client.ts
│   ├── query-client.ts
│   ├── subscription-client.ts
│   ├── operations-client.ts
│   └── sse-parser.ts
└── test/
```

Files remain focused: transport owns HTTP mechanics, command and resource
clients own endpoint mapping, the Handoff client owns convenience Envelope
construction, and the SSE parser owns only byte-to-frame decoding. No client
file imports Fastify, an Adapter, a Decider, a database, or Node built-ins.

The public index exports only stable SDK types and classes. Internal sleeper,
random, response-decoder, and retry helpers stay unexported. Concrete HTTP
server types do not leak through declarations.

## 9. Testing and acceptance

Node.js 22 is the complete test runtime. Phase 3C acceptance requires:

- configuration, immutable representation cloning, authentication refresh,
  timeout, Abort, redirect rejection, and safe error tests;
- deterministic Query retry and strict no-auto-retry tests for Command, Pull,
  and Ack;
- one test per Handoff convenience method proving the exact message type,
  canonical payload, Actor/Endpoint, version, idempotency, correlation, and
  causation fields sent through `commands.send`;
- Query and operations tests proving exact paths, encoded parameters,
  representation headers, bounded inputs, and Problem Details mapping;
- Subscription resource, Pull, Ack, explicit outcome, and Ack replay tests;
- chunk-fragmented SSE parser tests plus authenticated streaming, reconnect,
  `Last-Event-ID`, duplicate-before-Ack, Ack-then-continuation, exhaustion, and
  Abort tests;
- a real Phase 3B server black-box flow using only the public SDK for Direct
  Offer, Capability Offer → Resolve Target → Accept, idempotency, conflict,
  Handoff/Event reads, Subscription Put, Pull/Ack, SSE, and health;
- dependency guards proving SDK runtime source has no Fastify, Adapter,
  database, Exchange Decider, or Node built-in import;
- the existing full repository verification and WFPP 106/106 conformance stay
  green.

The black-box flow must use Human, Agent, Resolver, and operations authority
through the same `WorkFabricClient` implementation. It must not reach into the
server's persistence or Core from client code.

## 10. Roadmap status after completion

When these acceptance conditions pass, documentation marks Phase 3C
TypeScript SDK complete and Phase 4 Feishu plus local Agent Runtime integration
next. It must not claim the Console, Webhook Worker, OIDC Adapter, Agent
Gateway, Endpoint Directory, or production deployment composition is complete.
