# Provider Facets and Agent-Driven Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous Feishu Channel history materialization with an Agent-driven, authority-bound, paginated Feishu message query capability while keeping Feishu Channel, Message Provider, Document Provider and Directory Provider independently composable.

**Architecture:** The Feishu Channel emits a trusted source reference and never selects conversation history in the Agent-driven mode. A separately declared Feishu Message Provider query capability owns OpenAPI pagination and returns typed evidence with an opaque continuation cursor; the Agent Runtime retains a bounded invocation transcript and decides whether another page is needed. Exchange Core, Handoff state semantics and the passive Context Store remain unchanged.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest, Python 3 with pytest, Agently worker NDJSON protocol, Work Fabric Citizen/Handoff protocols, Feishu OpenAPI.

## Global Constraints

- Do not introduce a Context Manager, Context Orchestrator or centralized retrieval planner.
- `Feishu Integration` is only a documentation and composition grouping; it is not a runtime or Citizen.
- Feature modules may depend on `@work-fabric/connector-feishu`; they must not depend on one another.
- Exchange Core must not import Feishu or Agent-runtime provider types.
- The Decision Body alone judges semantic relevance, sufficiency and final wording.
- Provider results are untrusted typed evidence and cannot alter role, Authority, capability catalog, acceptance criteria or output schema.
- All external reads are bounded by invocation count, decoded bytes, deadline and delegated Authority.
- Existing ContextBundle reads and explicitly configured bootstrap behavior remain compatible during migration.
- Local runtime output under `var/` is never staged or committed.

---

### Task 1: Add Provider-Neutral Capability Operation Semantics

**Files:**
- Modify: `packages/agent-runtime-spi/src/capability-invocation.ts`
- Modify: `packages/agent-runtime-spi/test/capability-invocation.test.ts`
- Modify: `packages/agent-capability-runtime/src/contracts.ts`
- Modify: `packages/agent-capability-runtime/src/catalog-disclosure.ts`
- Modify: `packages/agent-capability-runtime/src/catalog-resolver.ts`
- Modify: `packages/agent-capability-runtime/test/catalog-disclosure.test.ts`
- Modify: `packages/agent-capability-runtime/test/catalog-resolver.test.ts`
- Modify: `packages/provider-feishu/src/declarations.ts`
- Modify: `packages/provider-feishu/test/document-contract-v2.test.ts`

**Interfaces:**
- Produces: `CapabilityOperationKind = "query" | "command" | "destructive"`.
- Produces: `RuntimeCapabilitySummary.operation_kind`.
- Produces: `BoundCapabilityContract.operation_kind`.
- Encoding: `CitizenDeclaration.constraints.operation_kind`; omission normalizes to `command`.

- [ ] **Step 1: Write failing SPI and disclosure tests**

Add expectations that a declaration with `constraints: { operation_kind: "query" }`
is disclosed as:

```ts
{
  citizen_id: "citizen-feishu-message",
  capability_id: "feishu.conversation.history.read",
  version: "1.0.0",
  name: "Read Feishu conversation history",
  description: expect.any(String),
  operation_kind: "query",
  input_schema: null,
}
```

Add a compatibility test proving a declaration without `operation_kind`
normalizes to `"command"`, and a rejection test for any other value.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
npx vitest run \
  packages/agent-runtime-spi/test/capability-invocation.test.ts \
  packages/agent-capability-runtime/test/catalog-disclosure.test.ts \
  packages/agent-capability-runtime/test/catalog-resolver.test.ts \
  packages/provider-feishu/test/document-contract-v2.test.ts
```

Expected: FAIL because summaries and bound contracts do not expose
`operation_kind`.

- [ ] **Step 3: Implement normalization**

Add:

```ts
export type CapabilityOperationKind =
  | "query"
  | "command"
  | "destructive";

export interface RuntimeCapabilitySummary {
  readonly citizen_id: string;
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly operation_kind: CapabilityOperationKind;
  readonly input_schema: RuntimeJsonObject | null;
}
```

Create one private normalizer in `agent-capability-runtime`:

```ts
function operationKind(
  constraints: CitizenJsonObject,
): CapabilityOperationKind {
  const value = constraints.operation_kind;
  if (value === undefined) return "command";
  if (
    value !== "query" &&
    value !== "command" &&
    value !== "destructive"
  ) throw new TypeError("Capability operation_kind is invalid");
  return value;
}
```

Use it in both catalog disclosure and bound contract resolution. Add
`operation_kind` to every Feishu declaration: document read and conversation
history are `query`; create/update/append/message send are `command`; delete is
`destructive`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run \
  packages/agent-runtime-spi/test/capability-invocation.test.ts \
  packages/agent-capability-runtime/test/catalog-disclosure.test.ts \
  packages/agent-capability-runtime/test/catalog-resolver.test.ts \
  packages/provider-feishu/test/document-contract-v2.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/agent-runtime-spi \
  packages/agent-capability-runtime \
  packages/provider-feishu/src/declarations.ts \
  packages/provider-feishu/test/document-contract-v2.test.ts
git commit -m "feat(citizens): classify query and command capabilities"
```

---

### Task 2: Preserve Feishu Native Pagination

**Files:**
- Modify: `packages/connector-feishu/src/open-api-client.ts`
- Modify: `packages/connector-feishu/test/open-api-client.test.ts`

**Interfaces:**
- Produces: `FeishuListMessagesInput.page_token?: string`.
- Produces: accepted `FeishuHistoryResult` with `has_more: boolean` and
  `next_page_token?: string`.

- [ ] **Step 1: Write failing pagination tests**

Change the current list-message fixture to expect:

```ts
expect(result).toEqual({
  kind: "accepted",
  items: [expect.objectContaining({ message_id: "om-history-1" })],
  has_more: true,
  next_page_token: "page-2",
});
```

Assert a second request with `page_token: "page-2"` sends:

```ts
expect(new URL(String(input)).searchParams.get("page_token")).toBe("page-2");
```

Add rejection cases for `has_more: true` without a non-empty page token and
for a page token longer than 2,048 characters.

- [ ] **Step 2: Run the connector test and verify red**

Run:

```bash
npx vitest run packages/connector-feishu/test/open-api-client.test.ts
```

Expected: FAIL because `has_more` and `page_token` are discarded.

- [ ] **Step 3: Implement bounded page metadata**

Update the contracts:

```ts
export interface FeishuListMessagesInput {
  // existing fields
  readonly page_token?: string;
}

export type FeishuHistoryResult =
  | {
      readonly kind: "accepted";
      readonly items: readonly FeishuHistoryMessage[];
      readonly has_more: boolean;
      readonly next_page_token?: string;
    }
  | /* existing failures */;
```

Validate the response relationship:

```ts
if (hasMore && pageToken === undefined) {
  throw new TypeError("Feishu history page token is missing");
}
```

Add `page_token` to the URL only when supplied. Freeze page metadata with the
same deep-freeze boundary used for message items.

- [ ] **Step 4: Run connector tests and typecheck**

Run:

```bash
npx vitest run packages/connector-feishu/test/open-api-client.test.ts
npm run typecheck
```

Expected: PASS after updating existing test fakes to return
`has_more: false`.

- [ ] **Step 5: Commit**

```bash
git add packages/connector-feishu
git commit -m "feat(feishu): preserve message history pagination"
```

---

### Task 3: Bind Capability Authority to the Original Source Reference

**Files:**
- Modify: `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`
- Modify: `examples/agently-agent-runtime/src/local-invocation-authority.ts`
- Modify: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`
- Modify: `packages/provider-feishu/src/execution-adapter.ts`
- Modify: `packages/provider-feishu/test/execution-adapter.test.ts`

**Interfaces:**
- Produces: trusted WorkReference extensions
  `provider_family`, `resource_kind`, `external_tenant_id`,
  `conversation_id`, `message_id`, and optional `thread_id`.
- Produces: `authority_evidence.source_reference`, copied from the accepted
  original Handoff rather than model input.
- Produces: `conversation:read` scope mapping for
  `feishu.conversation.history.read`.

- [ ] **Step 1: Write failing source and Authority tests**

Assert Feishu intake emits:

```ts
work_reference: {
  uri: "feishu://tenant-key-1/message/om-1",
  extensions: {
    "workfabric.dev/provider_family": "feishu",
    "workfabric.dev/resource_kind": "conversation_message",
    "workfabric.dev/external_tenant_id": "tenant-key-1",
    "workfabric.dev/conversation_id": "oc-1",
    "workfabric.dev/message_id": "om-1",
  },
}
```

Add an Authority test in which the model requests:

```ts
{
  conversation: { kind: "current_conversation" },
  maximum_messages: 20,
}
```

and verify the issued evidence contains the original Handoff WorkReference,
the represented human Actor and only `conversation:read`.

Add rejection tests for missing trusted extensions, a non-Feishu provider
family and an original delegation without `conversation:read`.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
npx vitest run \
  packages/plugin-channel-feishu/test/intake-message-policy.test.ts \
  examples/agently-agent-runtime/test/local-invocation-authority.test.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
```

Expected: FAIL because the source reference is not carried into invocation
Authority.

- [ ] **Step 3: Implement trusted source propagation**

Extend `requiredScope`:

```ts
if (capabilityId === "feishu.conversation.history.read") {
  return "conversation:read";
}
```

Read `state.package.work_reference` from the original Handoff and copy a
validated, frozen form into:

```ts
"workfabric.dev/capability_authority": {
  // existing fields
  source_reference: {
    uri: originalWorkReference.uri,
    extensions: originalWorkReference.extensions,
  },
}
```

Also include the original source URI in the narrowed
`authority_scope.resource_refs`. Extend the Provider execution adapter's
authority parser to return this bounded source reference.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run \
  packages/plugin-channel-feishu/test/intake-message-policy.test.ts \
  examples/agently-agent-runtime/test/local-invocation-authority.test.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/plugin-channel-feishu \
  examples/agently-agent-runtime/src/local-invocation-authority.ts \
  examples/agently-agent-runtime/test/local-invocation-authority.test.ts \
  packages/provider-feishu/src/execution-adapter.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
git commit -m "feat(authority): bind provider queries to source references"
```

---

### Task 4: Implement the Feishu Message Query Capability

**Files:**
- Create: `packages/provider-feishu/src/conversation-cursor.ts`
- Create: `packages/provider-feishu/src/message-query-executor.ts`
- Create: `packages/provider-feishu/test/conversation-cursor.test.ts`
- Create: `packages/provider-feishu/test/message-query-executor.test.ts`
- Modify: `packages/provider-feishu/src/contracts.ts`
- Modify: `packages/provider-feishu/src/declarations.ts`
- Modify: `packages/provider-feishu/src/schema-registry.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Modify: `packages/provider-feishu/src/execution-adapter.ts`

**Interfaces:**
- Produces:

```ts
export interface ConversationCursorCodec {
  encode(payload: FeishuConversationCursorPayload): string;
  decode(cursor: string): FeishuConversationCursorPayload;
}
```

- Produces:

```ts
export class FeishuMessageQueryExecutor {
  readConversationHistory(
    input: FeishuConversationHistoryRequest,
  ): Promise<FeishuConversationHistoryOutcome>;
}
```

- Produces capability `feishu.conversation.history.read@1.0.0`.

- [ ] **Step 1: Write failing cursor tests**

Cover deterministic round-trip and rejection of:

- modified payload;
- modified signature;
- wrong source URI;
- expired cursor;
- cursor longer than 4,096 characters;
- key material shorter than 32 bytes.

Use this payload:

```ts
{
  version: 1,
  tenant_id: "tenant-1",
  source_uri: "feishu://tenant-key-1/message/om-trigger",
  conversation_id: "oc-1",
  trigger_message_id: "om-trigger",
  trigger_time: "2026-07-29T10:00:00.000Z",
  native_page_token: "native-page-2",
  expires_at: "2026-07-29T10:10:00.000Z",
}
```

- [ ] **Step 2: Write failing message-query tests**

Test that the first query:

```ts
{
  conversation: { kind: "current_conversation" },
  maximum_messages: 20,
}
```

uses the trusted `source_reference`, excludes current/future/deleted and
cross-chat records, returns chronological typed messages, and reports:

```ts
{
  has_more: true,
  next_cursor: expect.any(String),
  coverage: {
    newest_at: "2026-07-29T09:59:00.000Z",
    oldest_at: "2026-07-29T09:40:00.000Z",
  },
  provenance: {
    provider_family: "feishu",
    source: "im.message",
    source_reference: "feishu://tenant-key-1/message/om-trigger",
  },
}
```

Then decode the cursor in a second call and assert the Connector receives
`page_token: "native-page-2"`. Add failure tests for non-Feishu references,
missing `conversation:read`, mismatched tenant and malformed message bodies.

- [ ] **Step 3: Run tests and verify red**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test/conversation-cursor.test.ts \
  packages/provider-feishu/test/message-query-executor.test.ts
```

Expected: FAIL because the codec and query executor do not exist.

- [ ] **Step 4: Implement the signed cursor**

Use canonical JSON plus HMAC-SHA-256:

```ts
const body = Buffer.from(canonical(payload), "utf8").toString("base64url");
const signature = createHmac("sha256", key).update(body).digest("base64url");
return `wfc1.${body}.${signature}`;
```

Use `timingSafeEqual` for verification. Validate every decoded field, source
binding and expiry before returning the payload.

- [ ] **Step 5: Implement the query executor and declaration**

The declaration input schema allows only:

```ts
{
  conversation: {
    oneOf: [
      { kind: { const: "current_conversation" } },
      { kind: { const: "resource_reference" }, resource_uri: { type: "string" } },
    ],
  },
  cursor: { type: "string", maxLength: 4096 },
  maximum_messages: { type: "integer", minimum: 1, maximum: 50 },
}
```

The executor resolves actual Feishu IDs only from Authority evidence or a
validated cursor. It uses the existing safe text/rich-text decoders, preserves
native `has_more`, and never summarizes or interprets message relevance.

- [ ] **Step 6: Run provider tests and typecheck**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test/conversation-cursor.test.ts \
  packages/provider-feishu/test/message-query-executor.test.ts \
  packages/provider-feishu/test/schema-registry.test.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): add authority-bound conversation query"
```

---

### Task 5: Register Independent Feishu Provider Facets

**Files:**
- Modify: `packages/provider-feishu/src/config.ts`
- Modify: `packages/provider-feishu/test/config.test.ts`
- Modify: `packages/provider-feishu/src/declarations.ts`
- Modify: `examples/feishu-capability-provider/src/configuration.ts`
- Modify: `examples/feishu-capability-provider/src/composition.ts`
- Modify: `examples/feishu-capability-provider/src/provision.ts`
- Modify: `examples/feishu-capability-provider/test/configuration.test.ts`
- Modify: `examples/feishu-capability-provider/test/composition.test.ts`
- Modify: `examples/feishu-capability-provider/test/provision.test.ts`
- Modify: `examples/config/local-feishu-assistant.bundle.yaml`

**Interfaces:**
- Produces independent `message_citizen` and `document_citizen` configuration.
- Retains `capability_citizen` as a legacy aggregate compatibility form.
- Produces `feishuMessageCapabilityDeclarations()` and
  `feishuDocumentCapabilityDeclarations()`.

- [ ] **Step 1: Write failing facet configuration tests**

Add a modern configuration:

```ts
{
  credential_ref: "feishu-primary",
  cursor_signing_key: "0123456789abcdef0123456789abcdef",
  open_api: { /* existing values */ },
  state: { type: "memory" },
  message_citizen: {
    enabled: true,
    citizen_id: "citizen-feishu-message",
    principal_id: "principal-feishu-provider",
    actor_id: "actor-feishu-provider",
    endpoint_id: "endpoint-feishu-provider",
    registration_version: 1,
  },
  document_citizen: {
    enabled: true,
    citizen_id: "citizen-feishu-document",
    principal_id: "principal-feishu-provider",
    actor_id: "actor-feishu-provider",
    endpoint_id: "endpoint-feishu-provider",
    registration_version: 1,
  },
  context_citizen: { /* deprecated compatibility citizen */ },
}
```

Assert either facet may be disabled without preventing the other from loading.
Assert duplicate Citizen IDs are rejected. Add a compatibility test for the
existing `capability_citizen` form.

- [ ] **Step 2: Run configuration and provisioning tests and verify red**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test/config.test.ts \
  examples/feishu-capability-provider/test/configuration.test.ts \
  examples/feishu-capability-provider/test/composition.test.ts \
  examples/feishu-capability-provider/test/provision.test.ts
```

Expected: FAIL because facets are not independently configurable.

- [ ] **Step 3: Implement facet declaration sets**

Split declaration factories without cross-imports:

```ts
export function feishuMessageCapabilityDeclarations() {
  return [messageSendDeclaration, conversationHistoryDeclaration] as const;
}

export function feishuDocumentCapabilityDeclarations() {
  return [
    documentAppendDeclaration,
    documentCreateDeclaration,
    documentDeleteDeclaration,
    documentReadDeclaration,
    documentUpdateDeclaration,
  ] as const;
}
```

Keep `feishuCapabilityDeclarations()` as a deprecated aggregate export for
legacy callers.

- [ ] **Step 4: Implement independent runtime registration**

Provision and start one `FeishuCapabilityCitizenRuntime` per enabled facet.
Both may share the low-level OpenAPI client and endpoint process, but each has
its own Citizen ID, declaration set, lease and health entry. The provider Host
accepts the union of enabled capability IDs.

Resolve `cursor_signing_key` through the existing Secret Resolver. Do not put
the resolved key in Citizen declarations, logs, health data or runtime result
extensions.

- [ ] **Step 5: Update the local bundle**

Configure:

```yaml
message_citizen:
  enabled: true
  citizen_id: citizen-feishu-message
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
document_citizen:
  enabled: true
  citizen_id: citizen-feishu-document
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
cursor_signing_key:
  secret_ref: WORK_FABRIC_FEISHU_CURSOR_SECRET
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test \
  examples/feishu-capability-provider/test/configuration.test.ts \
  examples/feishu-capability-provider/test/composition.test.ts \
  examples/feishu-capability-provider/test/provision.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/provider-feishu \
  examples/feishu-capability-provider \
  examples/config/local-feishu-assistant.bundle.yaml
git commit -m "refactor(feishu): register independent provider facets"
```

---

### Task 6: Give the Agent a Bounded Invocation Transcript

**Files:**
- Modify: `packages/agent-runtime-spi/src/capability-invocation.ts`
- Modify: `packages/agent-runtime-spi/test/capability-invocation.test.ts`
- Modify: `packages/agent-runtime-host/src/capability-loop.ts`
- Modify: `packages/agent-runtime-host/src/config.ts`
- Modify: `packages/agent-runtime-host/src/configuration-loader.ts`
- Modify: `packages/agent-runtime-host/test/capability-loop.test.ts`
- Modify: `packages/agent-runtime-host/test/config.test.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/agently-process-driver.ts`
- Modify: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`
- Modify: `packages/adapter-agent-runtime-agently/test/process-driver.test.ts`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Modify: `runtimes/agently-worker/tests/conftest.py`
- Modify: `runtimes/agently-worker/tests/test_protocol.py`
- Modify: `runtimes/agently-worker/tests/test_assistant.py`
- Modify: `examples/config/agent-runtime-agently.yaml`

**Interfaces:**
- Produces:

```ts
export interface RuntimeCapabilityTranscript {
  readonly entries: readonly RuntimeCapabilityContinuation[];
}
```

- `CapabilityAwareAgentRuntimeDriver.executeTurn` receives
  `RuntimeCapabilityTranscript | null`.
- Adds runtime limits `max_query_invocations_per_handoff` and
  `max_query_result_bytes`.

- [ ] **Step 1: Write failing two-page loop tests**

Drive these turns:

```text
history read page 1 -> has_more true
history read page 2 -> has_more false
final
```

Assert the third model turn receives both prior entries in stable order.
Assert a document command plus a history query are both retained. Add failures
for exceeding query-call count and cumulative successful query-result bytes;
command limits retain their current behavior.

- [ ] **Step 2: Write failing TS/Python protocol tests**

The turn request must contain:

```json
{
  "capability_transcript": {
    "entries": [
      {
        "request": { "invocation_id": "history-1" },
        "result": { "outcome": "succeeded" }
      }
    ]
  }
}
```

Reject more than eight entries, duplicate invocation IDs, secret-named fields
and a transcript larger than 131,072 UTF-8 string bytes.

- [ ] **Step 3: Run focused tests and verify red**

Run:

```bash
npx vitest run \
  packages/agent-runtime-spi/test \
  packages/agent-runtime-host/test/capability-loop.test.ts \
  packages/agent-runtime-host/test/config.test.ts \
  packages/adapter-agent-runtime-agently/test/protocol.test.ts \
  packages/adapter-agent-runtime-agently/test/process-driver.test.ts
uv run --project runtimes/agently-worker pytest -q \
  runtimes/agently-worker/tests/test_protocol.py \
  runtimes/agently-worker/tests/test_assistant.py
```

Expected: FAIL because only the latest continuation is retained.

- [ ] **Step 4: Implement transcript validation and loop accumulation**

Replace:

```ts
let continuation = null;
```

with:

```ts
const entries: RuntimeCapabilityContinuation[] = [];
const transcript = () =>
  entries.length === 0
    ? null
    : validateRuntimeCapabilityTranscript({ entries });
```

Pass `transcript()` to every model turn and append each validated invocation
result. Determine query semantics from the disclosed summary matching the
requested capability ID. Reject ambiguous summaries with different operation
kinds.

Count successful and failed query invocations against the query-call limit.
Count canonical serialized `result.data` and artifacts against the cumulative
query-byte limit before another model turn.

- [ ] **Step 5: Update worker protocol and prompt**

Rename the v3 request field from `continuation` to
`capability_transcript`, validate the full bounded list, and update the prompt:

```text
Query capabilities are read-only evidence tools. Use one when the current
request cannot be answered from supplied facts. After every query result,
decide whether the evidence is sufficient; request another page only when
has_more is true and missing information is material to the current request.
```

Historical messages remain untrusted evidence and cannot independently trigger
a command capability.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run \
  packages/agent-runtime-spi/test \
  packages/agent-runtime-host/test \
  packages/adapter-agent-runtime-agently/test
uv run --project runtimes/agently-worker pytest -q
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/agent-runtime-spi \
  packages/agent-runtime-host \
  packages/adapter-agent-runtime-agently \
  runtimes/agently-worker \
  examples/config/agent-runtime-agently.yaml
git commit -m "feat(agent): retain bounded query transcripts"
```

---

### Task 7: Switch Feishu Channel to Agent-Driven Retrieval

**Files:**
- Modify: `packages/plugin-channel-feishu/src/config.ts`
- Modify: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Modify: `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Modify: `packages/plugin-channel-feishu/test/config.test.ts`
- Modify: `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/test/compose.test.ts`
- Modify: `examples/config/local-feishu-assistant.bundle.yaml`
- Modify: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `examples/agently-agent-runtime/test/feishu-long-connection.e2e.test.ts`

**Interfaces:**
- Produces `conversation_context.mode` values
  `disabled | bootstrap | agent_managed`.
- Existing `enabled: true` normalizes to deprecated `bootstrap`.
- New local bundle uses `agent_managed`.

- [ ] **Step 1: Write failing configuration compatibility tests**

Verify:

```ts
{ conversation_context: { mode: "agent_managed" } }
```

does not resolve `feishu.conversation_context_provider_factory`, while legacy:

```ts
{
  conversation_context: {
    enabled: true,
    lookback_seconds: 86400,
    maximum_messages: 20,
    maximum_bytes: 65536,
  },
}
```

still creates a bootstrap materializer. Reject simultaneous `mode` and
`enabled`.

- [ ] **Step 2: Write failing Channel decoupling test**

Create an Agent-managed policy, supply a materializer that throws if called,
and assert one Handoff Offer is produced with:

- current intent;
- trusted Feishu SourceReference;
- no `context_bundle`;
- no materializer invocation.

- [ ] **Step 3: Run Channel tests and verify red**

Run:

```bash
npx vitest run \
  packages/plugin-channel-feishu/test/config.test.ts \
  packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts \
  packages/plugin-channel-feishu/test/intake-message-policy.test.ts \
  packages/service-node/test/compose.test.ts
```

Expected: FAIL because only `enabled` and synchronous materialization exist.

- [ ] **Step 4: Implement mode normalization**

Normalize legacy and modern forms into:

```ts
type ConversationContextMode =
  | "disabled"
  | "bootstrap"
  | "agent_managed";
```

Only `bootstrap` injects `ConversationContextMaterializer`. Remove the Provider
factory lookup and OpenAPI history-client construction from the
`agent_managed` path. Channel ingress availability must not depend on the
Message Provider.

- [ ] **Step 5: Add two-page end-to-end coverage**

In the local stack test:

1. Feishu intake produces a source reference without a ContextBundle.
2. Agent requests `feishu.conversation.history.read`.
3. The Provider returns page one with `has_more: true`.
4. Agent requests page two using `next_cursor`.
5. Agent returns one semantic final result.
6. Channel emits only that final result.

Add a cross-facet test that disables Feishu Channel and Message Provider while
retaining `feishu.document.create`; an email-shaped original Handoff still
completes document creation.

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
npx vitest run \
  packages/plugin-channel-feishu/test \
  packages/service-node/test \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts \
  examples/agently-agent-runtime/test/feishu-long-connection.e2e.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/plugin-channel-feishu \
  packages/service-node \
  examples/config/local-feishu-assistant.bundle.yaml \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts \
  examples/agently-agent-runtime/test/feishu-long-connection.e2e.test.ts
git commit -m "refactor(feishu): let agents retrieve conversation evidence"
```

---

### Task 8: Update Architecture, Operations and Verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/architecture/network-citizens.md`
- Modify: `docs/guides/feishu-collaboration-channel.md`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/guides/agently-agent-runtime.md`
- Modify: `README.md`
- Modify: `examples/agently-agent-runtime/test/documentation-contract.test.ts`

**Interfaces:**
- Documents the virtual Integration grouping, independent facet lifecycle,
  Agent-driven retrieval, query/command semantics, permissions, migration and
  local verification.

- [ ] **Step 1: Write failing documentation contract tests**

Require the guides to contain all of:

```text
feishu.conversation.history.read
agent_managed
WORK_FABRIC_FEISHU_CURSOR_SECRET
query capability
Feishu Message Provider
Feishu Document Provider
```

Require the architecture document to say that Integration is not a Citizen or
runtime and that Provider facets do not depend on Channel facets.

- [ ] **Step 2: Run documentation tests and verify red**

Run:

```bash
npx vitest run \
  examples/agently-agent-runtime/test/documentation-contract.test.ts
```

Expected: FAIL because the current docs still describe synchronous fixed
history materialization as the target architecture.

- [ ] **Step 3: Update documents**

Document:

- module/Citizen/process as separate axes;
- Feishu Integration as a virtual grouping;
- independent configuration and credential references;
- required `im:message:readonly` and group-history scopes;
- signed cursor secret generation:

```bash
export WORK_FABRIC_FEISHU_CURSOR_SECRET="$(openssl rand -hex 32)"
```

- Agent-managed local configuration;
- legacy bootstrap migration;
- email/WeCom Channel plus Feishu document example;
- debugging `has_more`, query budgets and Authority denial without printing
  cursor contents or message bodies.

- [ ] **Step 4: Run documentation and boundary checks**

Run:

```bash
npx vitest run \
  examples/agently-agent-runtime/test/documentation-contract.test.ts
npm run check:plugin-boundaries
npm run check:sensitive-observability
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run verify
npm run verify:agent-runtime
git diff --check
git status --short
```

Expected:

- all type checks, Vitest suites, Python tests and conformance tests pass;
- `git diff --check` is empty;
- only intentional source/document changes and the pre-existing untracked
  `var/` directory remain.

- [ ] **Step 6: Commit**

```bash
git add \
  README.md \
  docs \
  examples/agently-agent-runtime/test/documentation-contract.test.ts
git commit -m "docs: explain provider facets and agent-driven context"
```

- [ ] **Step 7: Review final commit range**

Run:

```bash
git log --oneline 8e1fc58..HEAD
git diff --stat 8e1fc58..HEAD
git status --short --branch
```

Expected: the commit range contains only the eight implementation slices;
`var/` remains untracked and no secret file is committed.
