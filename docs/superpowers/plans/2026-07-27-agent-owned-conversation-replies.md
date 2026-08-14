# Agent-owned Conversation Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver exactly one Agent-authored semantic result to the originating Feishu conversation while preserving all Fabric events for operational consumers.

**Architecture:** The Agent Runtime normalizes conditionally omitted structured-output fields before validating and returns the Agent response in the canonical Result summary. A narrow Channel SPI reads the permission-filtered canonical Handoff snapshot at the delivery boundary; the Feishu route adapter attaches that standard snapshot to the result event, and the Feishu renderer only formats the Agent-owned summary. The dynamic conversation subscription selects only `result_returned`, so lifecycle and progress events remain in Fabric without becoming chat replies.

**Tech Stack:** Python 3.10+, Agently 4.1.4.1, TypeScript, Vitest, WFPP v1 Protocol Events, Feishu Open API.

## Global Constraints

- The daily assistant Agent is the sole producer of user-facing semantic reply content.
- Work Fabric persists and routes state; it does not author, summarize, translate, or repair business replies.
- Channel adapters format and transport canonical content; they do not infer reply semantics from lifecycle state.
- Modules communicate through stable SPI/protocol contracts and may not import another module's concrete storage or runtime implementation.
- Operational events remain available through Event, API, SDK, and Console surfaces.
- Unknown Agent output fields remain invalid; conditional draft fields default only when `handoff_draft_required` is false.

---

### Task 1: Make module closure a project-level architecture principle

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-27-agent-owned-conversation-replies-design.md`

**Interfaces:**
- Consumes: Existing Work Fabric positioning and responsibility-boundary text.
- Produces: A normative project rule used by all later implementation and review tasks.

- [ ] **Step 1: Add the principle to the main project boundary**

Add an explicit rule under `README.md` responsibility boundaries:

```markdown
### 模块职责闭环与解耦

每个模块必须在自身职责内形成完整闭环，并只通过稳定协议或 SPI
交换事实。一个模块不得为另一个模块补做业务语义、决策或执行。
```

- [ ] **Step 2: Add normative dependency and content-ownership rules**

Document in `docs/architecture.md` that Core, Runtime, Agent, Connector, and
Channel layers own state exchange, execution semantics, business content,
external-system mapping, and transport rendering respectively. Explicitly ban
concrete cross-module storage imports and cross-layer fallback content.

- [ ] **Step 3: Verify documentation consistency**

Run:

```bash
rg -n "模块职责闭环|稳定协议|业务语义|具体实现" README.md docs/architecture.md docs/superpowers/specs/2026-07-27-agent-owned-conversation-replies-design.md
```

Expected: all three documents express the same ownership and dependency direction.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture.md docs/superpowers/specs/2026-07-27-agent-owned-conversation-replies-design.md
git commit -m "docs: require closed module responsibilities"
```

### Task 2: Normalize conditional Agent output

**Files:**
- Modify: `runtimes/agently-worker/tests/test_assistant.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`

**Interfaces:**
- Consumes: `validate_assistant_output(value: object)`.
- Produces: The same function returning a complete output mapping with empty
  draft fields when a model legitimately omits them.

- [ ] **Step 1: Write the failing normalization tests**

Add tests proving this succeeds:

```python
output = validate_assistant_output({
    "request_summary": "整理后的请求",
    "response": "请补充短信服务商和验证码有效期",
    "missing_information": ["短信服务商", "验证码有效期"],
    "handoff_draft_required": False,
    "handoff_draft_reason": "信息尚不完整",
})
assert output["handoff_draft_capability"] == ""
assert output["handoff_draft_intent"] == ""
assert output["handoff_draft_acceptance_criteria"] == []
```

Also prove omitted draft fields still fail when
`handoff_draft_required` is true, and unknown fields still fail.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
runtimes/agently-worker/.venv/bin/pytest runtimes/agently-worker/tests/test_assistant.py -q
```

Expected: the omitted-fields test fails with
`assistant output has unknown or missing fields`.

- [ ] **Step 3: Implement minimal conditional normalization**

Normalize only the three conditional fields before exact-key validation:

```python
normalized = dict(value)
if normalized.get("handoff_draft_required") is False:
    normalized.setdefault("handoff_draft_capability", "")
    normalized.setdefault("handoff_draft_intent", "")
    normalized.setdefault("handoff_draft_acceptance_criteria", [])
```

Validate `normalized` with all existing type, unknown-field, and
required-draft checks.

- [ ] **Step 4: Run worker tests and verify GREEN**

Run:

```bash
runtimes/agently-worker/.venv/bin/pytest runtimes/agently-worker/tests -q
```

Expected: all worker tests pass.

- [ ] **Step 5: Commit**

```bash
git add runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py runtimes/agently-worker/tests/test_assistant.py
git commit -m "fix(agent): normalize optional handoff draft output"
```

### Task 3: Add a transport-neutral Channel snapshot port

**Files:**
- Create: `packages/channel-spi/src/handoff-snapshot-source.ts`
- Modify: `packages/channel-spi/src/index.ts`
- Modify: `packages/channel-spi/test/contracts.test.ts`
- Create: `packages/service-node/src/channel-handoff-snapshot-source.ts`
- Modify: `packages/service-node/src/compose.ts`
- Create: `packages/service-node/test/channel-handoff-snapshot-source.test.ts`

**Interfaces:**
- Consumes: `HandoffReadModelStore.getHandoff(handoffId)`.
- Produces:

```ts
export interface ChannelHandoffSnapshotRequest {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly minimum_resource_version: number;
}
export type ChannelHandoffSnapshotResult =
  | { readonly kind: "ready"; readonly snapshot: JsonObject }
  | { readonly kind: "not_ready" }
  | { readonly kind: "not_found" };
export interface ChannelHandoffSnapshotSource {
  get(input: ChannelHandoffSnapshotRequest): Promise<ChannelHandoffSnapshotResult>;
}
```

- [ ] **Step 1: Write failing SPI contract tests**

Add tests for exact request validation and immutable `ready` snapshot results.
Add a service composition test that resolves the capability
`channel.handoff_snapshot_source` without exposing a storage adapter to the
plugin.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run packages/channel-spi/test/contracts.test.ts packages/service-node/test/compose.test.ts
```

Expected: imports/capability assertions fail because the port does not exist.

- [ ] **Step 3: Implement the SPI and composition adapter**

Implement validation in Channel SPI. In `service-node`, adapt the scoped
`HandoffReadModelStore`:

```ts
async get(input) {
  const model = await storage.handoffs.getHandoff(input.handoff_id);
  if (model === null || model.tenant_id !== input.tenant_id) {
    return { kind: "not_found" };
  }
  if (model.stream_version < input.minimum_resource_version) {
    return { kind: "not_ready" };
  }
  return { kind: "ready", snapshot: structuredClone(model.state) };
}
```

Register only this port as `channel.handoff_snapshot_source`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-spi packages/service-node/src/compose.ts packages/service-node/test/compose.test.ts
git commit -m "feat(channel): add canonical handoff snapshot port"
```

### Task 4: Deliver only Agent-owned results to conversation routes

**Files:**
- Modify: `packages/plugin-channel-feishu/src/intake-receipt-handler.ts`
- Modify: `packages/plugin-channel-feishu/src/route-aware-signal-adapter.ts`
- Modify: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-receipt-handler.test.ts`
- Modify: `packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts`
- Modify: `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`

**Interfaces:**
- Consumes: `ChannelHandoffSnapshotSource.get(...)`.
- Produces: A `result_returned` Protocol Event whose standard
  `data.snapshot` is populated at the permission-checked delivery edge.

- [ ] **Step 1: Write failing conversation-route tests**

Prove the dynamic subscription filter is exactly:

```ts
filter: {
  event_types: ["workfabric.handoff.result_returned.v1"],
  handoff_ids: ["handoff-1"],
  actor_ids: [],
  endpoint_ids: [],
  thread_ids: [],
  work_reference_uris: [],
  capability_ids: [],
  lifecycle_states: [],
}
```

Prove the route adapter:

- fetches the snapshot for a result event;
- attaches it to a cloned Event without mutating the canonical input;
- returns `retryable_failure` for `not_ready`;
- returns `permanent_failure` for `not_found`;
- never fetches a snapshot for static non-result subscriptions.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-feishu/test/intake-receipt-handler.test.ts packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts
```

Expected: filter and snapshot expectations fail.

- [ ] **Step 3: Implement result-only subscription and snapshot enrichment**

Inject `ChannelHandoffSnapshotSource` into the route adapter and plugin factory.
For a Handoff route, only the result subscription reaches the adapter. Resolve
the snapshot at `minimum_resource_version: event.wfsequence`, attach it as
`data.snapshot`, then delegate. Preserve static subscription behavior.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-channel-feishu
git commit -m "fix(feishu): route only canonical agent results"
```

### Task 5: Render the Agent-owned Result summary

**Files:**
- Modify: `packages/connector-feishu/src/event-renderer.ts`
- Modify: `packages/connector-feishu/test/signal-adapter.test.ts`
- Modify: `packages/connector-feishu/test/feishu-roundtrip.integration.test.ts`

**Interfaces:**
- Consumes: `event.data.snapshot.result.summary` content parts.
- Produces: Feishu text/card messages containing only Agent-authored text
  summary content.

- [ ] **Step 1: Write failing renderer tests**

Create a `workfabric.handoff.result_returned.v1` Event with a snapshot result:

```ts
summary: [{
  kind: "text",
  media_type: "text/plain",
  text: "已整理需求目标、缺失信息和验收条件。",
}]
```

Assert text and card modes contain that sentence and do not contain
`handoff-1`, `result_returned`, `accepted`, or `State:`.
Assert malformed or non-text-only summaries fail safely instead of synthesizing
a fallback reply.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/signal-adapter.test.ts packages/connector-feishu/test/feishu-roundtrip.integration.test.ts
```

Expected: rendered content still contains Handoff lifecycle text.

- [ ] **Step 3: Implement semantic Result rendering**

Extract non-empty `text/*` summary parts from the snapshot, preserve their
order, join them with newlines, and apply existing byte bounds. Cards use a
neutral assistant header; no business text is created by the adapter.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/connector-feishu
git commit -m "fix(feishu): render agent-owned result summaries"
```

### Task 6: Verify the complete path

**Files:**
- Modify only if verification reveals a defect covered by a new failing test.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: A verified local Feishu → Fabric → Agently → Fabric → Feishu flow.

- [ ] **Step 1: Run focused verification**

```bash
npm run verify:agent-runtime
npx vitest run packages/channel-spi packages/plugin-channel-feishu packages/connector-feishu packages/service-node
```

Expected: all focused suites pass.

- [ ] **Step 2: Run full verification**

```bash
npm run verify
```

Expected: all repository gates, TypeScript tests, Python tests, schema checks,
and WFPP conformance checks pass.

- [ ] **Step 3: Restart local service and Runtime**

Start the existing local YAML compositions with
`$REPOSITORY_ROOT/feishu.env`, then verify liveness,
readiness, and Agent endpoint availability without printing secrets.

- [ ] **Step 4: Execute local end-to-end verification**

Send one Feishu request. Confirm:

- one Handoff is offered and accepted;
- progress remains queryable but creates no Feishu chat card;
- one Result is returned;
- Feishu receives exactly one Agent-authored semantic reply;
- no internal Handoff ID or lifecycle code appears in that reply.

- [ ] **Step 5: Commit any verification-only corrections**

If no correction is needed, do not create an empty commit. Otherwise stage only
the failing-test-backed correction and commit:

```bash
git commit -m "test: cover agent-owned Feishu reply flow"
```
