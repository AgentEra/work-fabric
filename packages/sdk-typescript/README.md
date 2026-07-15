# `@work-fabric/sdk-typescript`

Universal TypeScript client for the Work Fabric HTTP binding. Human-facing applications, Agent Runtimes, system connectors, and operations tools use the same client and differ only by authentication, represented Actor/Endpoint, and server-side authority.

The SDK is a connection library. It does not run work, select a target, plan Agent actions, persist a second state model, automatically acknowledge Events, or hide WFPP concurrency and idempotency.

## Install and create a client

The complete supported runtime is Node.js 22+. Browser runtimes need standards-compatible `fetch`, `ReadableStream`, `TextEncoder`, `TextDecoder`, `AbortController`, and `crypto.randomUUID`; inject a `messageIdGenerator` where `crypto.randomUUID` is unavailable.

```bash
npm install @work-fabric/sdk-typescript
```

```ts
import {
  BearerTokenProvider,
  WorkFabricClient,
} from "@work-fabric/sdk-typescript";

const fabric = new WorkFabricClient({
  baseUrl: "https://fabric.example.com",
  tenantId: "tenant_01",
  exchangeId: "exchange_01",
  representation: {
    actorId: "agent_implementation",
    endpointId: "runtime_local",
    delegationId: "delegation_project_01",
  },
  authentication: new BearerTokenProvider(async () => obtainAccessToken()),
});
```

The authentication provider is called for every HTTP attempt and SSE reconnect, allowing an external identity component to refresh short-lived credentials. `withRepresentation` creates an immutable sibling over the same transport configuration:

```ts
const reviewer = fabric.withRepresentation({
  actorId: "human_reviewer",
  endpointId: "console_01",
});
```

Representation headers are claims to be verified by the service; they are not authority by themselves.

## Commands and Handoffs

Send any complete WFPP command without transformation:

```ts
const outcome = await fabric.commands.send(envelope, { signal });
```

Or use typed Handoff methods for `offer`, `resolveTarget`, `reportTargetUnavailable`, `accept`, `decline`, `expire`, `cancel`, `reportStatus`, `returnResult`, `verify`, `close`, `requestRework`, and `transfer`:

```ts
const offered = await fabric.handoffs.offer(offerPayload, {
  idempotencyKey: "project-42-offer-v1",
  correlationId: "project-42",
});

const accepted = await fabric.handoffs.accept(
  { handoff_id: "handoff_42" },
  {
    expectedVersion: 1,
    idempotencyKey: "handoff-42-accept-v1",
  },
);
```

Callers must create and retain every `idempotencyKey`. A logical replay reuses the same key. Existing-Handoff mutations require a positive `expectedVersion`; the SDK never converts a version conflict into a hidden retry. `accepted`, `rejected`, `conflict`, and `temporarily_unavailable` are ordinary `OperationResult.operation_status` values.

For a Capability Target, an external person, rule service, or Agent Brain chooses the target and calls `resolveTarget` with exactly one Actor or Endpoint. The SDK and Work Fabric do not rank or select candidates.

## Query and operations visibility

```ts
const handoff = await fabric.queries.getHandoff("handoff_42");
const events = await fabric.queries.listHandoffEvents("handoff_42", {
  fromVersion: 1,
  limit: 100,
});

const failures = await fabric.operations.listProjectionFailures({
  projectorId: "workfabric.handoff.read-model.v1",
  partitionId: handoff.partition_id,
  limit: 50,
});

const live = await fabric.operations.getLiveness();
const ready = await fabric.operations.getReadiness();
const health = await fabric.operations.getHealth();
```

Public liveness and readiness omit representation headers. Protected operations use the same authentication, representation, and authority path as participant calls. Query inputs are validated and encoded before I/O; the SDK has no database or admin back channel.

## Durable Pull and explicit Ack

```ts
const result = await fabric.subscriptions.pull("subscription_agent", {
  partitionId: handoff.partition_id,
  cursor: null,
  limit: 50,
});

if (result.kind === "delivery") {
  await processOutsideWorkFabric(result.delivery);
  await fabric.subscriptions.acknowledgeDelivery(
    result.delivery,
    "acknowledged",
  );
}
```

`put`, `pull`, and `acknowledge` use canonical public Subscription and Delivery documents. Pull and Ack are never automatically retried. `acknowledgeDelivery` copies the delivery, subscription, cursor, and last Event identifiers, but the caller must explicitly choose `acknowledged`, `retry`, or `rejected`.

## Authenticated SSE

```ts
const controller = new AbortController();

for await (const delivery of fabric.subscriptions.stream(
  "subscription_agent_sse",
  { partitionId: handoff.partition_id },
  { signal: controller.signal },
)) {
  await processOutsideWorkFabric(delivery);
  await fabric.subscriptions.acknowledgeDelivery(delivery, "acknowledged");
}
```

Streaming uses authenticated Fetch, not native `EventSource`, so Authorization and representation headers work consistently. It reconnects with bounded backoff and `Last-Event-ID`, validates bounded SSE frames, and updates its resume cursor before yielding. It deliberately does not Ack, deduplicate, run handlers, or suppress a repeated unacknowledged Delivery. Aborting ends Fetch, reads, and reconnect waits cleanly.

## Errors, timeouts, and retry policy

- `WorkFabricHttpError` exposes bounded `status`, `code`, `requestId`, and RFC 9457 `problem` fields.
- `WorkFabricTransportError` identifies network, timeout, Abort, redirect, invalid response, stream protocol, and reconnect exhaustion failures.
- Error messages never copy credentials, request bodies, Context, or Event Delivery content.
- Commands, Subscription writes, Pull, and Ack are not retried.
- GET queries retry only network failure, HTTP `429`, and HTTP `503`, with bounded exponential backoff and bounded `Retry-After`.
- SSE uses its own bounded reconnect policy and refreshes authentication per connection.

Every operation accepts an `AbortSignal`. Redirects are manual and rejected, including final-Origin changes. A custom Fetch implementation, clock, message-ID generator, timeout, query retry policy, and stream reconnect policy can be supplied through `WorkFabricClient` options for hosts and deterministic tests.
