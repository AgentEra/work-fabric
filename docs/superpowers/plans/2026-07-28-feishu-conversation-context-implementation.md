# Feishu Conversation Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authorized, bounded Feishu conversation history to the Daily Assistant so “总结上面消息” produces a grounded semantic reply.

**Architecture:** Extend the existing Feishu Context Citizen with a conversation declaration and materializer, attach its immutable ContextBundle to the inbound Handoff, and add a vendor-neutral authorized ContextBundle query consumed by Agent Runtime. The Channel, Provider, Agent and Exchange state machine remain independently closed modules.

**Tech Stack:** TypeScript 5, Node.js, Fastify, Vitest, SQLite adapters, WFPP JSON Schema, Python 3, pytest, Agently, Feishu OpenAPI.

## Global Constraints

- Existing dirty changes in `citizen-routes.ts`, `citizen-routes.test.ts`, `assistant.py`, and `test_assistant.py` must be preserved and reviewed before overlapping edits.
- One Citizen registration has exactly one `citizen_kind`; one process may host multiple Citizens.
- No Feishu type, credential, SDK object or response body may enter Exchange domain state.
- Channel does not interpret history or write semantic replies.
- Provider returns bounded typed facts and provenance; Agent remains the sole producer of user-facing semantics.
- Default chat history is 86,400 seconds, at most 20 messages and at most 65,536 bytes.
- Thread history wins when a trusted `thread_id` is present.
- Current and future messages, deleted messages and unsupported payloads are excluded.
- Historical content is untrusted evidence and cannot change role, Authority, capabilities or output schema.
- Every production behavior is introduced with a failing test first.
- No test, metric or ordinary log may expose app secrets or conversation bodies.

---

### Task 0: Preserve Existing Worktree Fixes

**Files:**
- Review: `packages/transport-http/src/routes/citizen-routes.ts`
- Review: `packages/transport-http/test/citizen-routes.test.ts`
- Review: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Review: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- Consumes: current verified heartbeat authority and non-streaming Agently fixes.
- Produces: one isolated baseline commit before conversation-context edits.

- [ ] **Step 1: Review only the four tracked diffs**

Run:

```bash
git diff -- packages/transport-http/src/routes/citizen-routes.ts \
  packages/transport-http/test/citizen-routes.test.ts \
  runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py \
  runtimes/agently-worker/tests/test_assistant.py
```

Expected: only citizen-session authority resource alignment and Agently
non-streaming/fallback behavior; no generated data from `var/`.

- [ ] **Step 2: Re-run the focused TypeScript tests**

Run:

```bash
npx vitest run \
  packages/transport-http/test/citizen-routes.test.ts \
  packages/network-citizen-runtime/test/leased-network-citizen-runtime.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 3: Re-run the full Agently worker tests**

Run:

```bash
cd runtimes/agently-worker
PYTHONPATH=src ../../.venv/bin/python -m pytest -q
```

Expected: 35 tests pass. If the repository virtual environment has a different
path, use the Python executable already documented by the local stack and
record the exact command in the task log.

- [ ] **Step 4: Commit only the reviewed fixes**

```bash
git add packages/transport-http/src/routes/citizen-routes.ts \
  packages/transport-http/test/citizen-routes.test.ts \
  runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py \
  runtimes/agently-worker/tests/test_assistant.py
git commit -m "fix: stabilize citizen and Agently runtime sessions"
```

### Task 1: Authorized ContextBundle Read Contract

**Files:**
- Modify: `packages/exchange-spi/src/context.ts`
- Modify: `packages/adapter-context-memory/src/memory-context-repository.ts`
- Modify: `packages/adapter-context-memory/test/memory-context-repository.test.ts`
- Modify: `packages/adapter-storage-sqlite/test/sqlite-supporting-stores.test.ts`

**Interfaces:**
- Consumes: existing `ContextReference`, `ContextAccessRequest`, immutable `putBundle`.
- Produces:

```ts
type ContextReadResult =
  | { readonly kind: "available"; readonly bundle: JsonObject }
  | { readonly kind: "unavailable"; readonly reason: string };

interface ContextRepository {
  readBundle(request: ContextAccessRequest): Promise<ContextReadResult>;
}
```

- [ ] **Step 1: Write failing memory-repository tests**

Add tests proving `readBundle`:

```ts
await expect(repository.readBundle({
  tenant_id: "tenant-1",
  actor_id: "actor-agent",
  endpoint_id: "endpoint-agent",
  reference,
})).resolves.toEqual({ kind: "available", bundle });
```

Also prove tenant, digest, actor, endpoint and expired visibility produce
`unavailable` without returning the body. Use a fixed repository clock for the
expiry case.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run packages/adapter-context-memory/test/memory-context-repository.test.ts
```

Expected: compilation or assertion failure because `readBundle` does not exist.

- [ ] **Step 3: Implement minimal authorized read**

Add `ContextReadResult` and `readBundle` to the SPI. Refactor the memory adapter
so `checkAvailability` and `readBundle` share one private lookup/visibility
decision. Verify `visibility_scope.expires_at` against an injected clock and
return `structuredClone(stored.bundle)` only after every check passes.

- [ ] **Step 4: Add SQLite replay coverage**

Write a failing then passing test that puts a bundle, recreates the durable
adapter and reads the exact body through `readBundle`. The mutation journal
continues to record only `putBundle`; reads are never replayed as mutations.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run \
  packages/adapter-context-memory/test/memory-context-repository.test.ts \
  packages/adapter-storage-sqlite/test/sqlite-supporting-stores.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/exchange-spi/src/context.ts \
  packages/adapter-context-memory/src/memory-context-repository.ts \
  packages/adapter-context-memory/test/memory-context-repository.test.ts \
  packages/adapter-storage-sqlite/test/sqlite-supporting-stores.test.ts
git commit -m "feat(context): add authorized bundle reads"
```

### Task 2: Context Query HTTP and TypeScript SDK

**Files:**
- Modify: `packages/transport-http/src/query-service.ts`
- Modify: `packages/transport-http/src/routes/query-routes.ts`
- Modify: `packages/transport-http/test/query-routes.test.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/sdk-typescript/src/query-client.ts`
- Modify: `packages/sdk-typescript/src/protocol-types.ts`
- Modify: `packages/sdk-typescript/test/query-operations-client.test.ts`

**Interfaces:**
- Consumes: `ContextRepository.readBundle`.
- Produces:

```ts
interface ContextReferenceInput {
  readonly contextId: string;
  readonly version: number;
  readonly digest: string | null;
}

QueryClient.getContextBundle(
  reference: ContextReferenceInput,
  options?: RequestOptions,
): Promise<RuntimeJsonObject>;
```

- [ ] **Step 1: Write failing HTTP route tests**

Add:

```text
GET /v1/contexts/:context_id/versions/:version?digest=<encoded>
action = workfabric.context.content.read.v1
resource = context_id
```

Prove an authorized actor gets the canonical bundle, an unauthorized actor gets
403, unavailable references return 404 with stable `context_unavailable`, and
malformed version/digest return 400.

- [ ] **Step 2: Verify HTTP RED**

Run:

```bash
npx vitest run packages/transport-http/test/query-routes.test.ts
```

Expected: 404 or missing query method.

- [ ] **Step 3: Implement query service and route**

Inject `ContextRepository` into `StoreBackedExchangeQueryService`, call
`readBundle` with authenticated tenant plus represented actor/endpoint, and
return no Provider-specific fields outside the stored bundle. Wire the existing
SQLite context store from `service-node`.

- [ ] **Step 4: Write failing SDK tests**

Assert exact URL encoding, representation headers, retry mode `query`, strict
positive version validation and bounded nullable digest validation.

- [ ] **Step 5: Implement SDK method**

Add `getContextBundle` using the existing immutable request and decoder
patterns. Do not add Feishu concepts to public SDK types.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run \
  packages/transport-http/test/query-routes.test.ts \
  packages/sdk-typescript/test/query-operations-client.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-http packages/service-node/src/compose.ts \
  packages/sdk-typescript
git commit -m "feat(context): expose authorized bundle queries"
```

### Task 3: Resolve Context Into Agent Runtime

**Files:**
- Modify: `packages/agent-runtime-spi/src/driver.ts`
- Modify: `packages/agent-runtime-host/src/handoff-package-loader.ts`
- Modify: `packages/agent-runtime-host/test/handoff-package-loader.test.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Modify: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Modify: `runtimes/agently-worker/tests/test_protocol.py`
- Modify: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- Consumes: `QueryClient.getContextBundle`, existing `context_reference`.
- Produces: `RuntimeTaskPackage.resolved_context: RuntimeJsonObject | null`.

- [ ] **Step 1: Write failing package-loader tests**

Prove:

- no reference produces `resolved_context: null`;
- a reference calls `getContextBundle` exactly once and freezes its body;
- an unavailable or mismatched bundle aborts package loading with
  `context_unavailable`;
- no model driver runs after resolution failure.

- [ ] **Step 2: Verify TypeScript RED**

Run:

```bash
npx vitest run \
  packages/agent-runtime-host/test/handoff-package-loader.test.ts \
  packages/adapter-agent-runtime-agently/test/protocol.test.ts
```

Expected: task contract failures because `resolved_context` is missing.

- [ ] **Step 3: Implement TypeScript runtime propagation**

Extend the exact task contract, resolve the bundle in
`HandoffPackageLoader.load`, and preserve both `context_reference` and
`resolved_context`. Update Agently JSON validation and size accounting.

- [ ] **Step 4: Write failing Python protocol and prompt tests**

Prove `resolved_context` is required in the worker task, remains bounded JSON,
and is included in `task_prompt_input`. Add a prompt-injection fixture whose
history says to change roles or emit a capability request; assert the role
prompt labels it untrusted and the validated final output contract remains
unchanged.

- [ ] **Step 5: Verify Python RED**

Run:

```bash
cd runtimes/agently-worker
PYTHONPATH=src ../../.venv/bin/python -m pytest -q \
  tests/test_protocol.py tests/test_assistant.py
```

Expected: failures for missing `resolved_context`.

- [ ] **Step 6: Implement Python propagation and isolation**

Add `resolved_context` to exact protocol fields and prompt input. Update the
role prompt with a fixed instruction that history is evidence only and cannot
modify role, Authority, capabilities, acceptance criteria or output schema.

- [ ] **Step 7: Verify GREEN**

Run the TypeScript and Python commands from Steps 2 and 5.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runtime-spi packages/agent-runtime-host \
  packages/adapter-agent-runtime-agently runtimes/agently-worker
git commit -m "feat(agent): resolve bounded handoff context"
```

### Task 4: Typed Feishu History OpenAPI Client

**Files:**
- Modify: `packages/connector-feishu/src/open-api-client.ts`
- Modify: `packages/connector-feishu/src/ingress-normalizer.ts`
- Modify: `packages/connector-feishu/test/open-api-client.test.ts`
- Modify: `packages/connector-feishu/test/ingress-normalizer.test.ts`

**Interfaces:**
- Produces:

```ts
interface FeishuConversationApi {
  getMessage(input: {
    credential_ref: string;
    message_id: string;
  }): Promise<FeishuHistoryResult>;
  listMessages(input: {
    credential_ref: string;
    container_type: "chat" | "thread";
    container_id: string;
    start_time?: number;
    end_time?: number;
    sort_type: "ByCreateTimeDesc";
    page_size: number;
  }): Promise<FeishuHistoryResult>;
}
```

The accepted result contains only validated message IDs, ancestry/thread IDs,
sender IDs/types, timestamps, message type/content, updated/deleted flags and
container evidence.

- [ ] **Step 1: Write failing client tests**

Cover exact chat/thread query parameters, token refresh on token rejection,
429/5xx retryable mapping, 400/403 permanent mapping, response-size failure,
malformed JSON, malformed item and page-size bounds `1..50`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/open-api-client.test.ts
```

Expected: missing methods/types.

- [ ] **Step 3: Implement minimal typed reads**

Reuse the token and bounded-response helpers. Never expose arbitrary response
properties or page tokens beyond the first bounded page required by this
policy.

- [ ] **Step 4: Preserve trusted thread ID at ingress**

Write a failing normalizer test for `message.thread_id`, implement bounded
optional preservation, and verify existing `root_id`/`parent_id` behavior.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run \
  packages/connector-feishu/test/open-api-client.test.ts \
  packages/connector-feishu/test/ingress-normalizer.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/connector-feishu
git commit -m "feat(feishu): add bounded conversation history client"
```

### Task 5: Feishu Conversation Context Provider

**Files:**
- Create: `packages/provider-feishu/src/conversation-context-provider.ts`
- Create: `packages/provider-feishu/test/conversation-context-provider.test.ts`
- Modify: `packages/provider-feishu/src/declarations.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Modify: `packages/provider-feishu/test/executor.test.ts`
- Modify: `examples/feishu-capability-provider/src/composition.ts`
- Modify: `examples/feishu-capability-provider/test/composition.test.ts`

**Interfaces:**
- Consumes: `FeishuConversationApi`.
- Produces:

```ts
interface ConversationContextMaterializer {
  materialize(
    request: ConversationContextRequest,
    signal: AbortSignal,
  ): Promise<
    | { kind: "materialized"; bundle: JsonObject }
    | { kind: "temporarily_unavailable"; code: string; retry_after?: string }
    | { kind: "permanently_unavailable"; code: string }
  >;
}
```

- [ ] **Step 1: Write failing provider selection tests**

Prove thread selection, 24-hour chat bounds, maximum 20, ascending output,
current/future/deleted/unsupported exclusion, text and rich-text decoding,
maximum-byte enforcement, deterministic ID/digest, audience/expiry and
provenance.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run packages/provider-feishu/test/conversation-context-provider.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement provider**

Use fixed validation bounds from the spec. Represent history as ContextBundle
data parts. Compute SHA-256 over canonical JSON with `digest` omitted, then set
the WFPP digest object. Map only stable error codes.

- [ ] **Step 4: Add declaration RED**

Expect `feishuContextDeclarations()` to include:

```ts
{
  declaration_id: "feishu.conversation.context",
  declaration_kind: "context",
  version: "1.0.0",
  risk: "low",
  confirmation: "none",
}
```

with complete request/result schema references and dynamic digest.

- [ ] **Step 5: Implement declaration and composition**

Export the provider and add conversation routing to the existing Context
Citizen resolver without changing `feishu.document.context`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test/conversation-context-provider.test.ts \
  packages/provider-feishu/test/executor.test.ts \
  examples/feishu-capability-provider/test/composition.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu examples/feishu-capability-provider
git commit -m "feat(feishu): provide bounded conversation context"
```

### Task 6: Channel Materialization and Unified Configuration

**Files:**
- Modify: `packages/plugin-channel-feishu/src/config.ts`
- Modify: `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Modify: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Modify: `packages/plugin-channel-feishu/test/config.test.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`
- Modify: `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`
- Modify: `examples/config/local-feishu-assistant.bundle.yaml`
- Modify: relevant global configuration fixtures under `packages/service-node/test/`

**Interfaces:**
- Consumes: `ConversationContextMaterializer`.
- Produces: optional validated `conversation_context` configuration and
`handoff.offer.input.context_bundle`.

- [ ] **Step 1: Write failing configuration tests**

Prove defaults and exact accepted ranges:

```yaml
conversation_context:
  enabled: true
  lookback_seconds: 86400
  maximum_messages: 20
  maximum_bytes: 65536
```

Reject unknown keys and out-of-range values. Disabled configuration preserves
the legacy no-context path.

- [ ] **Step 2: Verify config RED**

Run:

```bash
npx vitest run packages/plugin-channel-feishu/test/config.test.ts
```

Expected: unknown configuration key.

- [ ] **Step 3: Write failing intake tests**

Prove the Channel:

- passes only route, identity, target, delegation and policy facts;
- attaches a materialized bundle without inspecting message bodies;
- maps temporary unavailability to retryable ingress rejection;
- maps permanent unavailability to a deterministic error-fact bundle;
- never creates more than one Handoff for one message;
- preserves `thread_id` in work-reference extensions.

- [ ] **Step 4: Implement materializer integration**

Inject the port into `FeishuIntakeMessagePolicy`. Compose the Feishu
implementation with the existing token/OpenAPI client in the plugin factory.
Keep current intent separate from historical items.

- [ ] **Step 5: Update local bundle**

Enable conversation context and add `conversation:read` to the bounded inbound
delegation scopes. Continue resolving credentials through the global
Configuration Service and environment secret resolver.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run \
  packages/plugin-channel-feishu/test/config.test.ts \
  packages/plugin-channel-feishu/test/intake-message-policy.test.ts \
  packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts \
  packages/service-node/test/global-configuration.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-channel-feishu examples/config \
  packages/service-node/test
git commit -m "feat(feishu): attach conversation context to intake"
```

### Task 7: Cross-Module Integration, Documentation and Real Validation

**Files:**
- Modify: `packages/service-node/test/admission-feishu.e2e.test.ts`
- Modify: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `docs/guides/feishu-collaboration-channel.md`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/architecture/network-citizens.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: complete callback → context → Agent → result → Channel flow.
- Produces: documented permissions, startup, test procedure and acceptance evidence.

- [ ] **Step 1: Write failing E2E**

Create prior Feishu messages, then submit:

```text
@AI助理 你帮我总结下我上面消息都说了些啥
```

Assert one Handoff contains a ContextReference, the responsible Agent retrieves
the exact authorized bundle, the current trigger is absent from history, and
the final Channel result is Agent-authored rather than Provider text.

- [ ] **Step 2: Verify E2E RED**

Run:

```bash
npx vitest run \
  packages/service-node/test/admission-feishu.e2e.test.ts \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts
```

Expected: failure before final cross-module wiring is complete.

- [ ] **Step 3: Complete composition wiring**

Fix only missing composition dependencies exposed by the E2E. Do not add
semantic branching to Channel or Provider.

- [ ] **Step 4: Update documentation**

Document:

- `im.message.receive_v1` subscription;
- `im:message` or `im:message:readonly`;
- `im:message.group_msg` for application-identity group history;
- bot membership requirement;
- unified YAML settings and environment secret locations;
- local startup and a two-message/summary verification procedure;
- the separate `channel`, `context-provider` and `decision-body` boundaries.

- [ ] **Step 5: Verify focused E2E GREEN**

Run the Step 2 command and require zero failures.

- [ ] **Step 6: Run full repository verification**

Run:

```bash
npm run typecheck
npm test
cd runtimes/agently-worker
PYTHONPATH=src ../../.venv/bin/python -m pytest -q
```

Expected: every command exits 0.

- [ ] **Step 7: Start the real local stack**

Run from the worktree:

```bash
WORK_FABRIC_ENV_FILE=/Users/bottleliu/work/git/agently/work-fabric/feishu.env \
WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml" \
npm run local:feishu:start
```

Expected: service, Feishu long connection, Context/Capability Citizens and
Agently Runtime report ready. If persisted development state conflicts with
provisioning, use the documented non-destructive local-state migration or an
explicitly selected clean test database; never delete user data implicitly.

- [ ] **Step 8: Execute real smoke test**

Send two or more ordinary messages followed by:

```text
@AI助理 你帮我总结下我上面消息都说了些啥
```

Verify:

- the new ingress, Handoff and Agent run are visible;
- the ContextBundle contains only prior authorized messages;
- the Agent returns a readable grounded summary;
- Feishu receives exactly one final semantic reply;
- no secret or conversation body appears in ordinary process logs.

- [ ] **Step 9: Commit final integration and docs**

```bash
git add packages/service-node/test examples/feishu-capability-provider/test \
  docs
git commit -m "test(feishu): verify conversation summary flow"
```

## Final Review Checklist

- [ ] Compare every acceptance criterion in
  `docs/superpowers/specs/2026-07-28-feishu-conversation-context-design.md`
  to at least one passing automated or real-service test.
- [ ] Run `git diff --check` and confirm `var/` is untracked and uncommitted.
- [ ] Inspect every staged file before each commit.
- [ ] Confirm no Feishu secret, token, message body fixture copied from a real
  conversation or database file is committed.
- [ ] Report exact test counts, real Handoff ID and failure evidence if the
  opt-in smoke test cannot complete.
