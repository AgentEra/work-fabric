# Work Fabric TypeScript SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3C as a universal Fetch-based TypeScript SDK exposing the Phase 3B Command, Query, Subscription, SSE, and operations surfaces without duplicating Exchange state or execution behavior.

**Architecture:** Add one `@work-fabric/sdk-typescript` workspace package with an immutable `WorkFabricClient` and five logical clients. A single internal transport owns authentication, representation headers, timeout, redirects, Problem Details, safe decoding, and bounded Query retries; command and durable delivery writes remain explicitly non-retrying. SSE uses authenticated Fetch streaming and yields one canonical Event Delivery per frame without automatic Ack.

**Tech Stack:** Node.js 22+, TypeScript 7 ESM, Web Fetch/Streams APIs, Vitest 4, existing WFPP and Phase 3B HTTP reference service.

## Global Constraints

- Node.js 22+ is primary; runtime source also works in modern browsers with Fetch, Streams, AbortController, and TextDecoder.
- No runtime imports from Fastify, Node built-ins, storage Adapters, Exchange Deciders, or concrete server implementations.
- `idempotencyKey` is mandatory for every convenience write and is never generated.
- Command, Pull, and Ack are never automatically retried.
- Query retries are bounded to network failure, HTTP 429, and HTTP 503.
- SSE never auto-Acks or deduplicates across reconnects and preserves at-least-once delivery.
- IDs, limits, Positions, URLs, and response shapes fail closed before unsafe use.
- No Console, Agent Gateway, Resolver implementation, Webhook Worker, OIDC implementation, Endpoint Directory, cache, workflow engine, or scheduler enters this plan.

---

### Task 1: Package, configuration, authentication, and errors

**Files:**
- Create: `packages/sdk-typescript/package.json`
- Create: `packages/sdk-typescript/src/config.ts`
- Create: `packages/sdk-typescript/src/authentication.ts`
- Create: `packages/sdk-typescript/src/errors.ts`
- Create: `packages/sdk-typescript/src/protocol-types.ts`
- Create: `packages/sdk-typescript/src/index.ts`
- Test: `packages/sdk-typescript/test/config-auth-errors.test.ts`

**Interfaces:** Produces `AuthenticationProvider`, `BearerTokenProvider`, `RepresentationContext`, `WorkFabricClientOptions`, normalized internal configuration, `ProblemDetails`, `WorkFabricHttpError`, and `WorkFabricTransportError`.

- [ ] **Step 1: Write failing contract tests**

Test absolute base URL normalization, credential/query/fragment rejection, positive timeouts and retry limits, immutable representation, static and refreshing Bearer providers, safe errors, and public-index dependency guards.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/config-auth-errors.test.ts
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement public primitives**

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

export type TransportErrorCode =
  | "network_error" | "timeout" | "aborted" | "redirect_rejected"
  | "invalid_response" | "stream_protocol_error"
  | "stream_reconnect_exhausted";
```

`BearerTokenProvider` accepts a string or `() => Promise<string>` and returns `Bearer <token>` after bounded validation. Errors never contain tokens, bodies, or response content.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
npx vitest run packages/sdk-typescript/test/config-auth-errors.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-typescript package-lock.json
git commit -m "feat(sdk): add client contracts"
```

---

### Task 2: Fetch transport, Abort composition, and Query retry

**Files:**
- Create: `packages/sdk-typescript/src/abort.ts`
- Create: `packages/sdk-typescript/src/retry.ts`
- Create: `packages/sdk-typescript/src/transport.ts`
- Test: `packages/sdk-typescript/test/transport.test.ts`

**Interfaces:** Produces internal `SdkTransport.request<T>()` and `SdkTransport.openStream()`. A request supplies method, path, query, body, representation, signal, retry mode, and response decoder.

- [ ] **Step 1: Write failing transport tests**

Cover authentication refresh per attempt, JSON and representation headers, URL encoding, external Abort and timeout, invalid JSON, malformed success, RFC 9457 mapping, request ID, manual redirects, Origin mismatch, and secret-free errors.

- [ ] **Step 2: Write failing retry tests**

With fake Fetch and sleeper, prove GET retries network error/429/503 only, honors bounded integer `Retry-After`, caps exponential delay, and never retries POST, deterministic 4xx, redirect, invalid response, or Abort.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/transport.test.ts
```

- [ ] **Step 4: Implement transport and retry**

Use `redirect: "manual"`, a request-local AbortController, explicit timer cleanup, and strict JSON-object decoding. Acquire authentication inside each attempt. Never include Authorization or bodies in errors.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/sdk-typescript/test/transport.test.ts
npm run typecheck
git add packages/sdk-typescript
git commit -m "feat(sdk): add universal HTTP transport"
```

---

### Task 3: Canonical Command and complete Handoff convenience API

**Files:**
- Create: `packages/sdk-typescript/src/command-client.ts`
- Create: `packages/sdk-typescript/src/handoff-client.ts`
- Test: `packages/sdk-typescript/test/command-handoff-client.test.ts`

**Interfaces:** Produces `CommandClient.send` and all thirteen Handoff methods. Convenience calls consume tenant, exchange, representation, clock, message-ID generator, mandatory idempotency key, and explicit expected version for existing resources.

- [ ] **Step 1: Write failing Command tests**

Assert exact `POST /v1/commands`, unchanged canonical Envelope, all OperationResult statuses returned without throwing, and no automatic network retry.

- [ ] **Step 2: Write failing builder tests**

For `offer`, `resolveTarget`, `reportTargetUnavailable`, `accept`, `decline`, `expire`, `cancel`, `reportStatus`, `returnResult`, `verify`, `close`, `requestRework`, and `transfer`, assert message type, payload, Actor/Endpoint/Delegation, tenant/exchange, time, ID, version, idempotency, correlation, and causation. Invalid IDs/version/key fail before Fetch.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/command-handoff-client.test.ts
```

- [ ] **Step 4: Implement one Envelope builder and thin methods**

Every method delegates to one private builder and `CommandClient.send`. `resolveTarget` defaults evidence to `[]` and never selects a target. Transfer sends only the canonical transfer payload.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/sdk-typescript/test/command-handoff-client.test.ts
npm run typecheck
git add packages/sdk-typescript
git commit -m "feat(sdk): add Handoff command client"
```

---

### Task 4: Query, operations, and immutable root composition

**Files:**
- Create: `packages/sdk-typescript/src/query-client.ts`
- Create: `packages/sdk-typescript/src/operations-client.ts`
- Create: `packages/sdk-typescript/src/client.ts`
- Test: `packages/sdk-typescript/test/query-operations-client.test.ts`
- Test: `packages/sdk-typescript/test/client-composition.test.ts`

**Interfaces:** Produces `QueryClient`, `OperationsClient`, and `WorkFabricClient` with `commands`, `handoffs`, `queries`, and `operations`. Task 5 adds `subscriptions` once its concrete client exists. `withRepresentation` returns an immutable sibling sharing transport configuration.

- [ ] **Step 1: Write failing resource tests**

Assert exact Handoff/Event/Partition/Admin/health paths, encoded IDs and query values, representation headers, safe integer validation, Query retry, and typed Problem failures.

- [ ] **Step 2: Write failing composition tests**

Assert one shared transport, immutable `withRepresentation`, per-call representation override, and Human/Agent/operations equality apart from headers and authority.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/query-operations-client.test.ts packages/sdk-typescript/test/client-composition.test.ts
```

- [ ] **Step 4: Implement clients and composition**

Return fresh readonly views without a cache. Public live/ready calls omit representation headers; protected operations health uses the normal representation chain.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/sdk-typescript/test/query-operations-client.test.ts packages/sdk-typescript/test/client-composition.test.ts
npm run typecheck
git add packages/sdk-typescript
git commit -m "feat(sdk): add Query and operations clients"
```

---

### Task 5: Subscription resources, Pull/Ack, and strict SSE parser

**Files:**
- Create: `packages/sdk-typescript/src/sse-parser.ts`
- Create: `packages/sdk-typescript/src/subscription-client.ts`
- Modify: `packages/sdk-typescript/src/client.ts`
- Test: `packages/sdk-typescript/test/sse-parser.test.ts`
- Test: `packages/sdk-typescript/test/subscription-client.test.ts`

**Interfaces:** Produces Subscription get/put, Pull, canonical Ack, `acknowledgeDelivery`, and the parser used by `stream(): AsyncIterable<EventDelivery>`.

- [ ] **Step 1: Write failing parser tests**

Cover UTF-8 split chunks, CRLF/LF, BOM, comments, heartbeat-only input, multiple data lines, multiple frames, EOF, maximum bytes, required `workfabric.delivery`, opaque ID, exactly one Event, and cursor equality.

- [ ] **Step 2: Write failing Pull/Ack tests**

Assert endpoints, public Subscription shape, Pull defaults, idle/delivery mapping, no retries, canonical Ack, explicit outcome, last Event ID, cursor propagation, and Ack replay.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/sse-parser.test.ts packages/sdk-typescript/test/subscription-client.test.ts
```

- [ ] **Step 4: Implement parser and APIs**

Malformed frames throw `stream_protocol_error` without data. `acknowledgeDelivery` requires Events and builds a complete Ack timestamp with the injected clock.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/sdk-typescript/test/sse-parser.test.ts packages/sdk-typescript/test/subscription-client.test.ts
npm run typecheck
git add packages/sdk-typescript
git commit -m "feat(sdk): add durable Subscription client"
```

---

### Task 6: Authenticated SSE and bounded reconnect

**Files:**
- Modify: `packages/sdk-typescript/src/subscription-client.ts`
- Modify: `packages/sdk-typescript/src/transport.ts`
- Test: `packages/sdk-typescript/test/subscription-stream.test.ts`

**Interfaces:** Completes `stream(subscriptionId, { partitionId, cursor? }, options?)` using Fetch streaming, the parser, and configured reconnect policy.

- [ ] **Step 1: Write failing stream tests**

With scripted ReadableStreams prove Authorization and representation headers, initial/reconnect `Last-Event-ID`, yield, duplicate-before-Ack, no auto-Ack, reconnect delay/reset, malformed frame, exhaustion, and Abort during Fetch/read/backoff.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/subscription-stream.test.ts
```

- [ ] **Step 3: Implement the async generator**

Bound frame memory. Set resume cursor before yield. Reacquire authentication on reconnect. Explicit Abort returns cleanly; exhaustion throws `stream_reconnect_exhausted` without Delivery content.

- [ ] **Step 4: Run, typecheck, and commit**

```bash
npx vitest run packages/sdk-typescript/test/subscription-stream.test.ts
npm run typecheck
git add packages/sdk-typescript
git commit -m "feat(sdk): add authenticated SSE streaming"
```

---

### Task 7: Real SDK reference flow, documentation, and verification

**Files:**
- Create: `packages/sdk-typescript/test/sdk-reference.integration.test.ts`
- Create: `packages/sdk-typescript/README.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-15-typescript-sdk-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-typescript-sdk-implementation.md`

**Interfaces:** Produces an executable Node SDK reference flow and roadmap status with 3C complete and Phase 4 next.

- [ ] **Step 1: Write failing real-server test**

Use only public SDK methods against the real 3B service for Direct Offer, replay, conflict, Capability Offer → Resolve → Accept, Handoff/Event read, Subscription Put, Pull/Ack, SSE reconnect/Ack/continuation, live/ready, and protected health. Client code never accesses server persistence or Core.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/sdk-typescript/test/sdk-reference.integration.test.ts
```

- [ ] **Step 3: Complete docs**

Document installation, setup, canonical/convenience commands, idempotency, Query, Pull/Ack, streaming, errors, retries, Node customization, and browser constraints. Mark only 3C complete and Phase 4 next.

- [ ] **Step 4: Run full verification**

```bash
npm run verify
npm run verify:exchange
git diff --check
```

- [ ] **Step 5: Review, commit, and push**

```bash
git diff --stat
git status --short
git add README.md docs packages package-lock.json
git commit -m "feat(sdk): complete TypeScript SDK"
git push -u origin codex/typescript-sdk
```
