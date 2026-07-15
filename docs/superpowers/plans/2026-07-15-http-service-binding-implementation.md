# Work Fabric HTTP Service Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3B as a runnable Node.js HTTP service exposing the canonical WFPP Command API, authorized Query/Admin views, durable Cursor Pull/Ack and SSE, and bounded health endpoints.

**Architecture:** Add a technology-neutral public surface in `@work-fabric/transport-http` with Fastify 5.10.0 hidden behind it. Routes only map HTTP to `ExchangeApplication`, a bounded query facade, and existing Runtime services; authentication and query authority use existing Identity/Authority SPI, and no route imports a concrete Adapter or domain decider.

**Tech Stack:** TypeScript 7, Node.js 22+, ESM, Fastify 5.10.0, Vitest, existing WFPP JSON Schemas and Exchange SPI/Core/Runtime packages.

## Global Constraints

- Implement [HTTP Service Binding Design](../specs/2026-07-15-http-service-binding-design.md) exactly.
- `exchange-core` and `exchange-spi` must not import Fastify, HTTP, or `transport-http`.
- Fastify types must not appear in any export from `packages/transport-http/src/index.ts`.
- `POST /v1/commands` accepts only a canonical `CommandEnvelope`; routes never reproduce Handoff decisions.
- Query and operations routes use Identity and Authority SPI before reading data.
- Public Event responses use `buildProtocolEvent`; never expose `domain_data`, partition positions, commit IDs, or credentials.
- Every collection input has a positive limit with a configured hard maximum.
- SSE uses delivery batches of exactly one Event so one opaque SSE ID cannot acknowledge or skip multiple Events.
- Outbound Webhook, OIDC/JWT verification, SDK, Endpoint Directory, Agent Gateway, and Console are out of scope.

---

### Task 1: Package, configuration, authentication evidence, and error mapping

**Files:**
- Create: `packages/transport-http/package.json`
- Create: `packages/transport-http/src/index.ts`
- Create: `packages/transport-http/src/public-types.ts`
- Create: `packages/transport-http/src/config.ts`
- Create: `packages/transport-http/src/authentication.ts`
- Create: `packages/transport-http/src/problem-details.ts`
- Create: `packages/transport-http/src/operation-result-http.ts`
- Test: `packages/transport-http/test/config-auth-error.test.ts`
- Modify: `package-lock.json`

**Interfaces:** Produces `HttpServiceConfig`, `HttpRequestAuthenticator`, `BearerAuthenticationEvidenceMapper`, `ProblemDetails`, `operationResultStatus`, and framework-neutral `HttpService` dispatch/listen/close types.

- [x] **Step 1: Write failing package contract tests**

Test unsafe limit rejection, Bearer mapping to `{ bearer_token: token }`, missing/malformed authorization returning `null`, OperationResult status mapping, safe Problem Details, and absence of Fastify names from public exports.

- [x] **Step 2: Run tests and verify RED**

```bash
npx vitest run packages/transport-http/test/config-auth-error.test.ts
```

Expected: FAIL because the package does not exist.

- [x] **Step 3: Implement the public primitives**

Use this public shape:

```ts
export interface HttpRequestAuthenticator {
  authenticationEvidence(
    metadata: HttpAuthenticationMetadata,
  ): Promise<JsonObject | null>;
}

export interface HttpService {
  dispatch(request: HttpDispatchRequest): Promise<HttpDispatchResponse>;
  listen(options: {
    readonly host: string;
    readonly port: number;
  }): Promise<{ readonly origin: string }>;
  close(): Promise<void>;
}
```

`HttpServiceConfig` contains positive limits for body bytes, page size, request timeout, SSE connections/poll/heartbeat/idle, and shutdown timeout. Pin Fastify 5.10.0 and keep it internal.

- [x] **Step 4: Run focused tests and typecheck**

```bash
npx vitest run packages/transport-http/test/config-auth-error.test.ts
npm run typecheck
```

- [x] **Step 5: Commit**

```bash
git add packages/transport-http package-lock.json
git commit -m "feat(http): add transport service primitives"
```

---

### Task 2: Query identity/authority coordinator and bounded query facade

**Files:**
- Create: `packages/transport-http/src/request-authorization.ts`
- Create: `packages/transport-http/src/query-service.ts`
- Test: `packages/transport-http/test/request-authorization.test.ts`
- Test: `packages/transport-http/test/query-service.test.ts`

**Interfaces:** Produces `AuthorizedHttpRequest`, `authorizeHttpRequest`, `ExchangeQueryService`, and `StoreBackedExchangeQueryService`. Consumes existing Identity, Authority, Journal, read-model, subscription, projection-failure, and delivery-state ports.

- [x] **Step 1: Write failing authorization tests**

Cover missing evidence (401), tenant mismatch (401), unrepresented Actor/Endpoint (403), Authority denial (403), and success. Verify exact action/resource and dependency order.

- [x] **Step 2: Write failing query facade tests**

Define bounded methods for Handoff get/list, Handoff/partition Protocol Events, Subscription get/list, projection failures, delivery attempts, and delivery position. Assert tenant mismatches return no facts, limits bound immutable output, and EventRecord is always converted with `buildProtocolEvent`.

- [x] **Step 3: Run tests and verify RED**

```bash
npx vitest run packages/transport-http/test/request-authorization.test.ts packages/transport-http/test/query-service.test.ts
```

- [x] **Step 4: Implement coordinator and facade**

Use the resolved Principal tenant; never accept tenant identity from query parameters. Clone returned values and fail closed on inconsistent stored tenant identity.

- [x] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/transport-http/test/request-authorization.test.ts packages/transport-http/test/query-service.test.ts
npm run typecheck
git add packages/transport-http
git commit -m "feat(http): add authorized query services"
```

---

### Task 3: Fastify host shell and canonical Command route

**Files:**
- Create: `packages/transport-http/src/internal/create-server.ts`
- Create: `packages/transport-http/src/internal/request-mapping.ts`
- Create: `packages/transport-http/src/routes/command-route.ts`
- Create: `packages/transport-http/src/create-http-service.ts`
- Test: `packages/transport-http/test/command-route.test.ts`
- Test: `packages/transport-http/test/dependency-boundaries.test.ts`

**Interfaces:** Produces `createHttpService(dependencies, config): HttpService`. Consumes `ExchangeApplication` and `HttpRequestAuthenticator`.

- [x] **Step 1: Write failing Command route tests**

Cover Content-Type, malformed/excessive JSON, missing Bearer, valid Offer, invalid command, Authority denial, idempotent retry, version conflict, unavailable Resolver, request ID, and exact HTTP/OperationResult mapping through `service.dispatch`.

- [x] **Step 2: Write failing dependency guard**

Assert Core/SPI do not import Fastify, Node HTTP, or transport-http, and the transport public index does not export internal modules.

- [x] **Step 3: Run tests and verify RED**

```bash
npx vitest run packages/transport-http/test/command-route.test.ts packages/transport-http/test/dependency-boundaries.test.ts
```

- [x] **Step 4: Implement the shell and route**

The command route extracts bounded authentication metadata, maps missing evidence to an empty object for the Application's normal unauthenticated result, invokes only `application.handle`, and returns the unchanged `OperationResult`. Thrown failures become a bounded synthetic 503 result without internal text.

- [x] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/transport-http/test/command-route.test.ts packages/transport-http/test/dependency-boundaries.test.ts
npm run typecheck
git add packages/transport-http
git commit -m "feat(http): expose canonical command endpoint"
```

---

### Task 4: Handoff, Event, Subscription, and Admin query routes

**Files:**
- Create: `packages/transport-http/src/routes/query-routes.ts`
- Create: `packages/transport-http/src/routes/subscription-resource-routes.ts`
- Create: `packages/transport-http/src/routes/admin-routes.ts`
- Test: `packages/transport-http/test/query-routes.test.ts`
- Test: `packages/transport-http/test/admin-routes.test.ts`

**Interfaces:** Consumes `ExchangeQueryService`, `SubscriptionStore`, `WfppSchemaValidator`, request authorization, and page limits. Produces every GET/PUT route in design section 5 except Pull/Ack/SSE.

- [x] **Step 1: Write failing participant route tests**

Cover authorized Handoff/Event reads, 404, cross-tenant non-disclosure, exact action/resource, safe Protocol Events, Subscription get, and Subscription put with schema validation, path/body ID equality, tenant/owner checks, immutable persistence, and denial.

- [x] **Step 2: Write failing Admin route tests**

Cover partition Handoffs/Events, active subscriptions for the Principal tenant, projection failures, delivery attempts/position, invalid pagination, default/hard maximum limits, and bounded Problem Details.

- [x] **Step 3: Run tests and verify RED**

```bash
npx vitest run packages/transport-http/test/query-routes.test.ts packages/transport-http/test/admin-routes.test.ts
```

- [x] **Step 4: Implement routes**

Register one exact authority action from the design table per route. No route may serialize EventRecord or receive a concrete Adapter.

- [x] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/transport-http/test/query-routes.test.ts packages/transport-http/test/admin-routes.test.ts
npm run typecheck
git add packages/transport-http
git commit -m "feat(http): expose authorized read APIs"
```

---

### Task 5: Cursor Pull/Ack binding and SSE-capable Runtime pull

**Files:**
- Modify: `packages/exchange-runtime/src/subscription/cursor-pull-service.ts`
- Test: `packages/exchange-runtime/test/cursor-pull-service.test.ts`
- Create: `packages/transport-http/src/routes/delivery-routes.ts`
- Test: `packages/transport-http/test/delivery-routes.test.ts`

**Interfaces:** Adds `CursorPullService.pullSse(subscriptionId, partitionId, cursor)` with a fixed one-Event limit, sharing the existing delivery engine while requiring delivery mode `sse`.

- [ ] **Step 1: Write failing Runtime tests**

Assert `pull` remains `cursor_pull`-only; `pullSse` is `sse`-only, reads one Event, replays the same pending Delivery until Ack, and advances only through Ack.

- [ ] **Step 2: Write failing HTTP Pull/Ack tests**

Cover authentication/authority, delivery/idle, invalid/expired cursor, wrong subscription/partition, Ack outcomes, error/status mapping, and no position change on transport error.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run packages/exchange-runtime/test/cursor-pull-service.test.ts packages/transport-http/test/delivery-routes.test.ts
```

- [ ] **Step 4: Implement one parameterized Runtime engine and HTTP routes**

Keep existing public `pull` behavior compatible. Pull body is `{ partition_id, cursor, limit }` and Ack body remains the canonical Delivery Ack. Register exact Pull/Ack actions.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/exchange-runtime/test/cursor-pull-service.test.ts packages/transport-http/test/delivery-routes.test.ts
npm run typecheck
git add packages/exchange-runtime packages/transport-http
git commit -m "feat(http): bind durable pull and ack"
```

---

### Task 6: SSE, health, listen/close, and graceful shutdown

**Files:**
- Create: `packages/transport-http/src/sse-connection-manager.ts`
- Create: `packages/transport-http/src/routes/sse-route.ts`
- Create: `packages/transport-http/src/health-service.ts`
- Create: `packages/transport-http/src/routes/health-routes.ts`
- Modify: `packages/transport-http/src/create-http-service.ts`
- Test: `packages/transport-http/test/sse-route.test.ts`
- Test: `packages/transport-http/test/health-host.test.ts`

**Interfaces:** Produces `HealthProbe`, `DependencyHealth`, and complete `HttpService.listen/close` behavior. Consumes `CursorPullService.pullSse`.

- [ ] **Step 1: Write failing SSE tests**

On an ephemeral loopback port, assert SSE headers, one Event/frame, opaque cursor ID, Protocol Event data, Last-Event-ID resume, heartbeat, no same-connection duplicate while Ack is pending, reconnect replay without Ack, continuation after separate Ack, connection limit, and disconnect cleanup.

- [ ] **Step 2: Write failing health/host tests**

Cover liveness, bounded readiness, protected dependency detail, failing/throwing/slow probe normalization, readiness false during shutdown, idempotent close, in-flight shutdown deadline, and refusal of new connections after shutdown starts.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run packages/transport-http/test/sse-route.test.ts packages/transport-http/test/health-host.test.ts
```

- [ ] **Step 4: Implement bounded streaming and lifecycle**

The SSE loop calls `pullSse`, emits only when its cursor differs from the last emitted cursor on that connection, otherwise sends heartbeat comments, and observes both request-abort and shutdown-abort signals.

- [ ] **Step 5: Run, typecheck, and commit**

```bash
npx vitest run packages/transport-http/test/sse-route.test.ts packages/transport-http/test/health-host.test.ts
npm run typecheck
git add packages/transport-http
git commit -m "feat(http): add SSE and service health"
```

---

### Task 7: Public HTTP reference suite, docs, and verification

**Files:**
- Create: `packages/transport-http/test/http-reference.integration.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-15-http-service-binding-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-http-service-binding-implementation.md`

**Interfaces:** Produces an executable 3B HTTP reference flow and roadmap status with 3B complete and 3C TypeScript SDK next.

- [ ] **Step 1: Write the failing black-box reference test**

Use only HTTP against `127.0.0.1:0`. Cover Direct Offer, Capability Offer → Resolve → Accept, idempotency, conflict, Handoff query preserving Requirement and Binding, safe Events, Subscription put, Pull/Ack, SSE reconnect, liveness/readiness, and protected health.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/transport-http/test/http-reference.integration.test.ts
```

- [ ] **Step 3: Complete composition and status docs**

Document startup/configuration/routes. Mark only 3B complete and 3C next; do not claim OIDC, Webhook Worker, SDK, Agent Gateway, or Console.

- [ ] **Step 4: Run full verification**

```bash
npm run verify
npm run verify:exchange
git diff --check
```

- [ ] **Step 5: Review and commit**

```bash
git diff --stat
git status --short
git add README.md docs packages package-lock.json
git commit -m "feat(http): complete HTTP service binding"
```

- [ ] **Step 6: Push**

```bash
git push origin codex/exchange-core-design
```
