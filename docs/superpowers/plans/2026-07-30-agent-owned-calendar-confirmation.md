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

- [ ] **Step 1: Write failing Channel tests**

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

- [ ] **Step 2: Run Channel test and verify RED**

Run:

```bash
npx vitest run packages/plugin-channel-feishu/test/intake-message-policy.test.ts
```

Expected: FAIL because the two source references are absent.

- [ ] **Step 3: Implement canonical source references**

Encode sender and chat IDs with `encodeURIComponent`, add the two extensions,
and include the exact canonical references in delegated `resource_refs`.

- [ ] **Step 4: Run Channel test and verify GREEN**

Run the focused test again. Expected: PASS.

- [ ] **Step 5: Write failing task-package and Python boundary tests**

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

- [ ] **Step 6: Run Agent boundary tests and verify RED**

Run:

```bash
npx vitest run packages/agent-runtime-host/test/handoff-package-loader.test.ts packages/adapter-agent-runtime-agently/test/process-driver.test.ts
uv run --project runtimes/agently-worker pytest -q runtimes/agently-worker/tests/test_protocol.py
```

Expected: FAIL on missing task fields and Python exact-field validation.

- [ ] **Step 7: Implement provider-neutral fields**

Add:

```ts
readonly source_reference: RuntimeJsonObject;
readonly initiator: RuntimeJsonObject;
readonly agent_private_context: RuntimeJsonObject | null;
```

to `RuntimeTaskPackage`. Populate source and initiator from the immutable
Handoff snapshot. Update Python `_validate_task` and `task_prompt_input` to
accept and forward all three fields while retaining secret-field rejection.

- [ ] **Step 8: Verify and commit**

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
- Consumes optional text-part field:

```ts
readonly recipient_references?: readonly {
  readonly kind: "mention";
  readonly resource_uri: string;
  readonly display_text: string;
}[];
```

- Produces Feishu `post/md` content containing a safe native
  `<at user_id="ou-initiator">发起人</at>` element before the Agent-authored
  Markdown.

- [ ] **Step 1: Write failing renderer tests**

Add a Result with:

```ts
recipient_references: [{
  kind: "mention",
  resource_uri: "feishu://user/open-id/ou-initiator",
  display_text: "发起人",
}]
```

Put the same URI in `snapshot.package.authority_scope.resource_refs` and assert
the serialized `post` Markdown starts with:

```text
<at user_id="ou-initiator">发起人</at>
```

Add denial cases for an unscoped URI, non-Feishu URI, `all`, malformed percent
encoding, control characters and more than 16 recipients.

- [ ] **Step 2: Run renderer tests and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/signal-adapter.test.ts packages/connector-feishu/test/feishu-roundtrip.integration.test.ts
```

Expected: FAIL because annotations are ignored.

- [ ] **Step 3: Implement bounded annotation parsing**

Parse annotations only from coherent text summary parts. Require exact keys,
canonical `feishu://user/open-id/{encoded id}`, unique refs, bounded labels and
membership in the Result snapshot's delegated `resource_refs`. Escape XML
attribute/text characters. The Channel chooses Feishu syntax but never chooses
the recipient.

- [ ] **Step 4: Render one native message**

For Markdown, prepend validated native `at` tags to the existing `md` payload.
For plain text with mentions, use Feishu `post` because native mentions require
rich content. Preserve the existing UTF-8 byte limit and safe-link checks.

- [ ] **Step 5: Verify and commit**

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

- [ ] **Step 1: Add failing conformance cases**

The shared profile must prove create-at-version-zero, compare-and-swap update,
stale-version rejection, tenant/namespace isolation, immutable returned values,
bounded JSON and durable SQLite reopen.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npx vitest run packages/adapter-agent-runtime-memory/test packages/adapter-agent-runtime-sqlite/test
```

Expected: FAIL because private-state methods do not exist.

- [ ] **Step 3: Implement the SPI and Memory adapter**

Validate identifiers, RFC3339 time and JSON bounds using the existing runtime
validation conventions. Clone on write/read. Use one composite map key and
throw `AgentPrivateStateConflictError` on stale CAS.

- [ ] **Step 4: Implement additive SQLite migration and adapter**

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

- [ ] **Step 5: Verify and commit**

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

- [ ] **Step 1: Write failing session-domain tests**

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

- [ ] **Step 2: Run session tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/scheduling-session.test.ts
```

Expected: FAIL because the repository/domain module does not exist.

- [ ] **Step 3: Implement bounded session validation**

Implement exact phases, immutable proposal versions, original Handoff/Actor/
sender/conversation references, candidate facts, confirmation source and
capability-result evidence. Reject unknown fields and stale expected versions.

- [ ] **Step 4: Write failing Driver-decorator tests**

Use a fake underlying capability-aware Driver. Assert:

1. current session is injected into `task.agent_private_context`;
2. a validated private update in a final Result is persisted;
3. `recipient_references` can contain only the original sender reference;
4. private update metadata is removed from returned Result extensions;
5. a capability request is passed through unchanged;
6. malformed/stale/model-invented origin data fails closed.

- [ ] **Step 5: Run Driver tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

Expected: FAIL because `DailyAssistantDriver` does not exist.

- [ ] **Step 6: Implement and compose the decorator**

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

- [ ] **Step 7: Verify and commit**

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
- A final proposal/follow-up may add authorized `recipient_references` to its
  text summary.

- [ ] **Step 1: Write failing Python output tests**

Add cases proving:

- `private_state` is required on all turns;
- capability requests require `{}`;
- a final turn preserves a bounded private object;
- active session facts are supplied to the model;
- the role prompt requires inference, progressive history retrieval,
  follow-up questions, latest-proposal confirmation and original-initiator
  confirmation;
- calendar creation requests contain origin/confirmation/member evidence.

- [ ] **Step 2: Run Python tests and verify RED**

Run:

```bash
uv run --project runtimes/agently-worker pytest -q runtimes/agently-worker/tests/test_assistant.py
```

Expected: FAIL because the ninth structured field is unsupported.

- [ ] **Step 3: Implement generic private-state transport**

Add `private_state` to the exact turn schema. Preserve it only in final Result
extensions. Keep the worker protocol provider-neutral; scheduling-specific
instructions activate only when `task.agent_private_context.namespace` equals
`daily-assistant.scheduling/v1`.

- [ ] **Step 4: Add scheduling role instructions**

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

- [ ] **Step 5: Verify and commit**

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

- [ ] **Step 1: Write failing Authority tests**

Test acceptance only when:

- origin and confirmation have the same tenant and Feishu conversation/thread;
- current invocation Handoff equals the confirmation Handoff;
- confirmation initiator Actor equals origin initiator Actor;
- proposal digest is well formed;
- every individual attendee appears in a successful same-task
  `feishu.conversation.members.list` result.

Test denial for a different confirmer, different chat/thread, stale/missing
evidence, unverified attendee and tampered member provenance.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/local-invocation-authority.test.ts
```

Expected: FAIL because event creation only permits direct parent refs/current
chat and ignores confirmation evidence.

- [ ] **Step 3: Implement reusable evidence verification**

Extract one helper that verifies typed member-result Handoffs and reuse it for
free/busy, event create and attendee mutations. Add a second mechanical helper
for origin/confirmation identity and conversation correlation. Do not inspect
message text or Agent session data.

- [ ] **Step 4: Verify and commit**

Run the focused test and `npm run typecheck`, then:

```bash
git add examples/agently-agent-runtime/src/local-invocation-authority.ts examples/agently-agent-runtime/test/local-invocation-authority.test.ts
git commit -m "feat(authority): verify calendar confirmation evidence"
```

---

### Task 7: Multi-turn Debug and Feishu End-to-end Acceptance

**Files:**
- Create: `examples/agently-agent-runtime/test/calendar-confirmation.e2e.test.ts`
- Modify: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `packages/service-node/test/debug-channel.e2e.test.ts`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/architecture/coordination-state-and-data-ownership.md`

**Interfaces:**
- Uses only public Handoff/Channel/Provider surfaces plus the private Agent
  composition from previous tasks.
- Proves exactly one proposal reply, one native mention and one event create.

- [ ] **Step 1: Write failing deterministic E2E**

Drive these messages through Debug Channel:

```text
1. “根据群聊安排 EDA 评审”
2. unrelated noise from another Human
3. initiator supplies missing duration
4. Agent returns a proposal mentioning initiator
5. another Human says “可以”
6. Agent refuses to execute
7. initiator revises attendees
8. Agent returns proposal version 2
9. initiator says “可以，就这么安排”
```

Assert one member query, one free/busy query, one event create, explicit
attendees, completed session and final clickable event URL.

- [ ] **Step 2: Run E2E and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/calendar-confirmation.e2e.test.ts
```

Expected: FAIL before the new multi-turn composition is wired.

- [ ] **Step 3: Complete simulation fixtures**

Extend fake model and Feishu OpenAPI fixtures to return deterministic structured
turns and typed member/freebusy/calendar results. Assert the real renderer
payload contains the native mention and the created event attendees.

- [ ] **Step 4: Run focused integration suite**

Run:

```bash
npx vitest run \
  examples/agently-agent-runtime/test/calendar-confirmation.e2e.test.ts \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts \
  packages/service-node/test/debug-channel.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update operating guide**

Document the conversational flow, required Feishu scopes, original-initiator
confirmation rule, SQLite state location, restart behavior and the exact local
commands. State explicitly that Fabric does not manage the scheduling flow.

- [ ] **Step 6: Run complete verification**

Run:

```bash
npm run verify
npm run agent-runtime:test-python
git diff --check
```

Expected: TypeScript, all Vitest suites, Python tests and 169/169 WFPP
conformance checks pass.

- [ ] **Step 7: Commit final acceptance**

```bash
git add examples packages docs runtimes
git commit -m "test: prove agent-owned calendar confirmation flow"
```
