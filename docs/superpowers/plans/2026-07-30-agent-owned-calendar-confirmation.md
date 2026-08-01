# Agent-owned Calendar Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Daily Assistant infer a versioned calendar proposal from
Feishu conversation facts, ask follow-up questions, notify the original
initiator with a native mention, accept only that Human's confirmation and
then create an event for an Authority-verified attendee list.

**Architecture:** Feishu Channel publishes trusted sender and conversation
references and renders channel-neutral recipient annotations. The Daily
Assistant decorates the Agently Driver with a private, optimistic scheduling
session backed by the Agent Runtime State Store. Calendar and Message Citizens
remain independent providers; dynamic member and confirmation evidence is
validated by the Agent-owned Authority adapter. Exchange Core and WFPP do not
change.

**Tech Stack:** TypeScript 7, Node.js 22 `node:sqlite`, Vitest 4, Python 3.12,
pytest, Agently, Feishu IM/Calendar OpenAPI.

**Implementation status (2026-07-30):** Tasks 1–7 are complete. The final
verification passed 2,422 TypeScript tests, all 169 WFPP conformance checks and
44 Python Worker tests.

## Global Constraints

- The original Human initiator is the only valid confirmer in version one.
- Agent-authored natural language determines whether a reply confirms, revises
  or supplements a proposal.
- Every material revision creates a new proposal version and invalidates old
  confirmation.
- Agent scheduling state is private runtime state and never a Citizen or Fabric
  projection.
- Fabric does not interpret content, correlate business replies, wake the Agent
  or create downstream tasks.
- Reactive proposal and follow-up messages use the existing Result-to-Channel
  route exactly once; `feishu.message.send` remains an independent proactive
  capability.
- Calendar Provider accepts only explicit participants and does not read
  Message or Agent state.
- No Exchange Core, WFPP state-machine, Wait, Resume, Scheduler, Planner or
  Coordinator change is permitted.

## Architecture Boundary Check

1. Scheduling sessions, proposal versions, inferred missing facts and
   confirmation decisions belong to the Daily Assistant.
2. Trusted sender/conversation/reply facts belong to Feishu and are normalized
   by Channel. Message and Calendar execution facts belong to their Providers.
3. Humans publish messages; the Agent independently accepts them and publishes
   capability Handoffs; Providers independently claim matching work.
4. Fabric only validates, propagates and records existing protocol facts.
5. Citizens communicate only by Handoff/Event/Subscription/Receipt; runtime
   composition uses provider-neutral SPIs.
6. Removing the Daily Assistant, Feishu Channel or Calendar Citizen affects
   only that module's capability; Exchange Core and unrelated Citizens remain.
7. No vendor or scheduling branch is added to Core.

---

### Task 1: Trusted Source Facts and Provider-neutral Agent Input

**Files:**
- Modify: `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`
- Modify: `packages/agent-runtime-spi/src/driver.ts`
- Modify: `packages/agent-runtime-host/src/handoff-package-loader.ts`
- Modify: `packages/agent-runtime-host/test/handoff-package-loader.test.ts`
- Modify: `packages/adapter-agent-runtime-agently/test/process-driver.test.ts`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Modify: `runtimes/agently-worker/tests/test_protocol.py`

**Interfaces:**
- Produces `RuntimeTaskPackage.source_reference`,
  `RuntimeTaskPackage.initiator` and
  `RuntimeTaskPackage.agent_private_context`.
- The Handoff loader always sets `agent_private_context: null`; a role-specific
  Driver decorator may replace it without changing the Handoff.

- [x] **Step 1: Write failing Channel tests**

Extend the existing intake assertion:

```ts
expect(command.input.work_reference.extensions).toMatchObject({
  "workfabric.dev/sender_resource_uri":
    "feishu://user/open-id/ou-human",
  "workfabric.dev/conversation_resource_uri":
    "feishu://chat/oc-team",
});
expect(command.input.authority_scope.resource_refs).toEqual([
  command.input.work_reference.uri,
  "feishu://user/open-id/ou-human",
  "feishu://chat/oc-team",
]);
```

- [x] **Step 2: Run Channel test and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-feishu/test/intake-message-policy.test.ts
```

Expected: FAIL because the two source references are absent.

- [x] **Step 3: Implement canonical source references**

Encode sender and chat IDs with `encodeURIComponent`, add the two extensions,
and include the exact canonical references in delegated `resource_refs`.

- [x] **Step 4: Run Channel test and verify GREEN**

Run the focused test again. Expected: PASS.

- [x] **Step 5: Write failing task-package and Python boundary tests**

Assert the loaded task contains:

```ts
{
  source_reference: handoffPackage.work_reference,
  initiator: snapshot.state.initiator,
  agent_private_context: null,
}
```

Update the Python test fixture to include those exact keys and add one test
that rejects a secret-named field inside `agent_private_context`.

- [x] **Step 6: Run Agent boundary tests and verify RED**

Run:

```bash
npx vitest run packages/agent-runtime-host/test/handoff-package-loader.test.ts packages/adapter-agent-runtime-agently/test/process-driver.test.ts
uv run --project runtimes/agently-worker pytest -q runtimes/agently-worker/tests/test_protocol.py
```

Expected: FAIL on missing task fields and Python exact-field validation.

- [x] **Step 7: Implement provider-neutral fields**

Add:

```ts
readonly source_reference: RuntimeJsonObject;
readonly initiator: RuntimeJsonObject;
readonly agent_private_context: RuntimeJsonObject | null;
```

to `RuntimeTaskPackage`. Populate source and initiator from the immutable
Handoff snapshot. Update Python `_validate_task` and `task_prompt_input` to
accept and forward all three fields while retaining secret-field rejection.

- [x] **Step 8: Verify and commit**

Run the focused commands from Steps 4 and 6, then:

```bash
git add packages/plugin-channel-feishu packages/agent-runtime-spi/src/driver.ts packages/agent-runtime-host packages/adapter-agent-runtime-agently/test runtimes/agently-worker
git commit -m "feat(agent): expose trusted handoff source facts"
```

---

### Task 2: Channel-neutral Recipient Annotation and Feishu Mention

**Files:**
- Modify: `packages/connector-feishu/src/event-renderer.ts`
- Modify: `packages/connector-feishu/test/signal-adapter.test.ts`
- Modify: `packages/connector-feishu/test/feishu-roundtrip.integration.test.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes an optional namespaced text-part extension:

```ts
readonly extensions?: {
  readonly "workfabric.dev/recipient_references"?: readonly {
  readonly kind: "mention";
  readonly resource_uri: string;
  readonly display_text: string;
  }[];
};
```

- Produces Feishu `post/md` content containing a safe native
  `<at user_id="ou-initiator">发起人</at>` element before the Agent-authored
  Markdown.

- [x] **Step 1: Write failing renderer tests**

Add a Result with:

```ts
extensions: {
  "workfabric.dev/recipient_references": [{
    kind: "mention",
    resource_uri: "feishu://user/open-id/ou-initiator",
    display_text: "发起人",
  }]
}
```

Put the same URI in `snapshot.package.authority_scope.resource_refs` and assert
the serialized `post` Markdown starts with:

```text
<at user_id="ou-initiator">发起人</at>
```

Add denial cases for an unscoped URI, non-Feishu URI, `all`, malformed percent
encoding, control characters and more than 16 recipients.

- [x] **Step 2: Run renderer tests and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/signal-adapter.test.ts packages/connector-feishu/test/feishu-roundtrip.integration.test.ts
```

Expected: FAIL because annotations are ignored.

- [x] **Step 3: Implement bounded annotation parsing**

Parse annotations only from coherent text summary parts. Require exact keys,
canonical `feishu://user/open-id/{encoded id}`, unique refs, bounded labels and
membership in the Result snapshot's delegated `resource_refs`. Escape XML
attribute/text characters. The Channel chooses Feishu syntax but never chooses
the recipient.

- [x] **Step 4: Render one native message**

For Markdown, prepend validated native `at` tags to the existing `md` payload.
For plain text with mentions, use Feishu `post` because native mentions require
rich content. Preserve the existing UTF-8 byte limit and safe-link checks.

- [x] **Step 5: Verify and commit**

Run the focused tests and `npm run typecheck`, update the architecture content
contract, then:

```bash
git add packages/connector-feishu docs/architecture.md
git commit -m "feat(feishu): render authorized result mentions"
```

---

### Task 3: Agent-private Optimistic State Store

**Files:**
- Modify: `packages/agent-runtime-spi/src/state.ts`
- Modify: `packages/agent-runtime-spi/src/index.ts`
- Modify: `packages/agent-runtime-conformance/src/state-store-profile.ts`
- Modify: `packages/adapter-agent-runtime-memory/src/memory-agent-runtime-state-store.ts`
- Modify: `packages/adapter-agent-runtime-sqlite/migrations/003_private_state.sql`
- Modify: `packages/adapter-agent-runtime-sqlite/src/migrations.ts`
- Modify: `packages/adapter-agent-runtime-sqlite/src/sqlite-agent-runtime-state-store.ts`
- Modify: `packages/adapter-agent-runtime-memory/test/memory-agent-runtime-state-store.test.ts`
- Modify: `packages/adapter-agent-runtime-sqlite/test/sqlite-agent-runtime-state-store.test.ts`

**Interfaces:**
- Produces an internal, non-Citizen store:

```ts
interface AgentPrivateStateRecord {
  tenant_id: string;
  namespace: string;
  key: string;
  version: number;
  value: RuntimeJsonObject;
  updated_at: string;
}

interface AgentPrivateStateStore {
  getPrivateState(
    tenantId: string,
    namespace: string,
    key: string,
  ): Promise<AgentPrivateStateRecord | null>;
  putPrivateState(input: {
    tenant_id: string;
    namespace: string;
    key: string;
    expected_version: number;
    value: RuntimeJsonObject;
    updated_at: string;
  }): Promise<AgentPrivateStateRecord>;
}
```

- [x] **Step 1: Add failing conformance cases**

The shared profile must prove create-at-version-zero, compare-and-swap update,
stale-version rejection, tenant/namespace isolation, immutable returned values,
bounded JSON and durable SQLite reopen.

- [x] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npx vitest run packages/adapter-agent-runtime-memory/test packages/adapter-agent-runtime-sqlite/test
```

Expected: FAIL because private-state methods do not exist.

- [x] **Step 3: Implement the SPI and Memory adapter**

Validate identifiers, RFC3339 time and JSON bounds using the existing runtime
validation conventions. Clone on write/read. Use one composite map key and
throw `AgentPrivateStateConflictError` on stale CAS.

- [x] **Step 4: Implement additive SQLite migration and adapter**

Create:

```sql
CREATE TABLE agent_private_state (
  tenant_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  state_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, namespace, state_key)
);
```

Use an immediate transaction for insert/update CAS. Never expose table or SQL
details through the SPI.

- [x] **Step 5: Verify and commit**

Run adapter tests plus `npm run typecheck`, then:

```bash
git add packages/agent-runtime-spi packages/agent-runtime-conformance packages/adapter-agent-runtime-memory packages/adapter-agent-runtime-sqlite
git commit -m "feat(agent): add private optimistic runtime state"
```

---

### Task 4: Daily Assistant Scheduling Session and Driver Decorator

**Files:**
- Create: `examples/agently-agent-runtime/src/scheduling-session.ts`
- Create: `examples/agently-agent-runtime/src/daily-assistant-driver.ts`
- Create: `examples/agently-agent-runtime/test/scheduling-session.test.ts`
- Create: `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`
- Modify: `examples/agently-agent-runtime/src/main.ts`
- Modify: `examples/agently-agent-runtime/test/daily-assistant-e2e-builders.ts`

**Interfaces:**
- `SchedulingSessionRepository` wraps `AgentPrivateStateStore` with namespace
  `daily-assistant.scheduling/v1`.
- `DailyAssistantDriver` implements both `AgentRuntimeDriver` and
  `CapabilityAwareAgentRuntimeDriver`, decorates an underlying Driver and
  removes private mutations before returning a canonical Result.
- Correlation key preference: Feishu `thread_id`, then `root_id`, then
  conversation URI.

- [x] **Step 1: Write failing session-domain tests**

Cover:

```text
no session -> collecting_information version 1
proposal -> awaiting_confirmation with proposal version/digest
initiator revision -> new proposal version and cleared confirmation
initiator confirmation -> executing
non-initiator confirmation -> no execution
calendar success -> completed
```

Require deterministic SHA-256 proposal digests over canonical JSON.

- [x] **Step 2: Run session tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/scheduling-session.test.ts
```

Expected: FAIL because the repository/domain module does not exist.

- [x] **Step 3: Implement bounded session validation**

Implement exact phases, immutable proposal versions, original Handoff/Actor/
sender/conversation references, candidate facts, confirmation source and
capability-result evidence. Reject unknown fields and stale expected versions.

- [x] **Step 4: Write failing Driver-decorator tests**

Use a fake underlying capability-aware Driver. Assert:

1. current session is injected into `task.agent_private_context`;
2. a validated private update in a final Result is persisted;
3. `workfabric.dev/recipient_references` can contain only the original sender
   reference;
4. private update metadata is removed from returned Result extensions;
5. a capability request is passed through unchanged;
6. malformed/stale/model-invented origin data fails closed.

- [x] **Step 5: Run Driver tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

Expected: FAIL because `DailyAssistantDriver` does not exist.

- [x] **Step 6: Implement and compose the decorator**

The private extension is:

```ts
{
  "workfabric.agent/private_state": {
    namespace: "daily-assistant.scheduling/v1",
    expected_version: 0,
    phase: "awaiting_confirmation",
    proposal: {
      version: 1,
      title: "EDA 方案评审",
      participant_resource_uris: [
        "feishu://user/open-id/ou-initiator"
      ],
      starts_at: "2026-07-31T06:00:00.000Z",
      ends_at: "2026-07-31T07:00:00.000Z",
      timezone: "Asia/Shanghai",
      summary_markdown: "请确认 EDA 方案评审排期。",
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    confirmed_proposal_digest: null
  }
}
```

The wrapper derives tenant, correlation, origin and initiator from trusted task
facts rather than model output. Compose it around `AgentlyProcessDriver` and
use the same SQLite runtime store.

- [x] **Step 7: Verify and commit**

Run both focused tests and `npm run typecheck`, then:

```bash
git add examples/agently-agent-runtime
git commit -m "feat(assistant): own durable scheduling sessions"
```

---

### Task 5: Agently Structured Scheduling Decisions

**Files:**
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Modify: `runtimes/agently-worker/tests/test_assistant.py`
- Modify: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Modify: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`

**Interfaces:**
- Every structured turn includes `private_state: {}`.
- A final scheduling turn may place the exact daily-assistant mutation under
  `response.extensions["workfabric.agent/private_state"]`.
- A final proposal/follow-up may add authorized
  `workfabric.dev/recipient_references` to its text summary extensions.

- [x] **Step 1: Write failing Python output tests**

Add cases proving:

- `private_state` is required on all turns;
- capability requests require `{}`;
- a final turn preserves a bounded private object;
- active session facts are supplied to the model;
- the role prompt requires inference, progressive history retrieval,
  follow-up questions, latest-proposal confirmation and original-initiator
  confirmation;
- calendar creation requests contain origin/confirmation/member evidence.

- [x] **Step 2: Run Python tests and verify RED**

Run:

```bash
uv run --project runtimes/agently-worker pytest -q runtimes/agently-worker/tests/test_assistant.py
```

Expected: FAIL because the ninth structured field is unsupported.

- [x] **Step 3: Implement generic private-state transport**

Add `private_state` to the exact turn schema. Preserve it only in final Result
extensions. Keep the worker protocol provider-neutral; scheduling-specific
instructions activate only when `task.agent_private_context.namespace` equals
`daily-assistant.scheduling/v1`.

- [x] **Step 4: Add scheduling role instructions**

Require the Agent to:

```text
infer relevant facts from current/history evidence;
ask instead of guessing;
produce a complete versioned proposal;
notify the original initiator;
interpret natural-language confirmation/revision;
never accept another Actor's confirmation;
never create before current-proposal confirmation;
include origin_handoff_id, confirmation_handoff_id,
proposal_digest and member-result Handoff IDs as authority_evidence.
```

- [x] **Step 5: Verify and commit**

Run Python tests, Agently adapter tests and `npm run typecheck`, then:

```bash
git add runtimes/agently-worker packages/adapter-agent-runtime-agently
git commit -m "feat(agently): emit private scheduling decisions"
```

---

### Task 6: Dynamic Attendee and Confirmation Authority

**Files:**
- Modify: `examples/agently-agent-runtime/src/local-invocation-authority.ts`
- Modify: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`

**Interfaces:**
- `feishu.calendar.event.create` and attendee mutation inputs accept:

```json
{
  "authority_evidence": {
    "session_origin_handoff_id": "handoff-origin",
    "confirmation_handoff_id": "handoff-confirm",
    "proposal_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "capability_result_handoff_ids": ["handoff-members"]
  }
}
```

- The Authority adapter validates facts by querying Handoffs; it does not read
  Agent private state or interpret confirmation text.

- [x] **Step 1: Write failing Authority tests**

Test acceptance only when:

- origin and confirmation have the same tenant and Feishu conversation/thread;
- current invocation Handoff equals the confirmation Handoff;
- confirmation initiator Actor equals origin initiator Actor;
- proposal digest is well formed;
- every individual attendee appears in a successful same-task
  `feishu.conversation.members.list` result.

Test denial for a different confirmer, different chat/thread, stale/missing
evidence, unverified attendee and tampered member provenance.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/local-invocation-authority.test.ts
```

Expected: FAIL because event creation only permits direct parent refs/current
chat and ignores confirmation evidence.

- [x] **Step 3: Implement reusable evidence verification**

Extract one helper that verifies typed member-result Handoffs and reuse it for
free/busy, event create and attendee mutations. Add a second mechanical helper
for origin/confirmation identity and conversation correlation. Do not inspect
message text or Agent session data.

- [x] **Step 4: Verify and commit**

Run the focused test and `npm run typecheck`, then:

```bash
git add examples/agently-agent-runtime/src/local-invocation-authority.ts examples/agently-agent-runtime/test/local-invocation-authority.test.ts
git commit -m "feat(authority): verify calendar confirmation evidence"
```

---

### Task 7: Multi-turn Feishu End-to-end Acceptance

**Implemented files:**
- Modify: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/architecture/coordination-state-and-data-ownership.md`

**Implemented scope:** The existing deterministic local Feishu stack is the
canonical cross-module acceptance harness. It uses the real Channel,
Handoff/Subscription surfaces, Agently Python Worker, Agent private SQLite,
Capability Handoffs, Authority and Calendar Provider while replacing only the
external model and Feishu OpenAPI with deterministic local fakes.

- [x] **Step 1: Prove the proposal phase**

The first Feishu message causes one member query and one free/busy query,
persists proposal version 1 and sends one native `@` proposal reply. The fake
Feishu OpenAPI event-create counter remains zero.

- [x] **Step 2: Prove the confirmation phase**

A later message from the original Human becomes a new Handoff. The Runtime
discloses the active private session to Agently; the Agent emits confirmation
evidence bound to both Handoffs and the current proposal digest.

- [x] **Step 3: Prove Provider execution and final reply**

Calendar Authority validates the evidence and explicit targets, the Provider
creates one event and performs one attendee mutation, and the second Result is
rendered once with a clickable event URL.

- [x] **Step 4: Cover rejection and revision rules**

Focused session and Authority tests reject a different confirmer, prevent
another group member from replacing the active proposal, require a new
proposal version for revision and permit a fresh session after terminal state.

- [x] **Step 5: Update operating guide**

The guide documents scopes, local commands, original-initiator confirmation,
Agent-private SQLite ownership/restart semantics and the exact two-message
manual validation flow. It states explicitly that Fabric does not manage the
scheduling workflow.

- [x] **Step 6: Run complete verification**

The completion gate is:

```bash
npm run verify
uv run --project runtimes/agently-worker pytest -q
git diff --check
```

Expected: TypeScript, all Vitest suites, Python tests and 169/169 WFPP
conformance checks pass.
