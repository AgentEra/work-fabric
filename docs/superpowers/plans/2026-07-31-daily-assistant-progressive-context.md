# Daily Assistant Progressive Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Daily Assistant retrieve a bounded recent-history page for explicit context-dependent follow-ups before it asks the Human to repeat available information or invents an unrelated workflow.

**Architecture:** Add a replaceable, deterministic preflight policy inside the Daily Assistant application Driver. It emits the existing `feishu.conversation.history.read` query request for the first 20 messages only when the current Handoff explicitly depends on earlier conversation content; the existing capability continuation loop and Agently worker retain responsibility for sufficiency, pagination, side-effect decisions and final wording.

**Tech Stack:** TypeScript, Vitest, Python 3.13, pytest, Agently worker, Work Fabric capability continuation protocol.

## Global Constraints

- Work Fabric Core, WFPP, Feishu Channel and Feishu Provider contracts must not change.
- External-message context sufficiency starts as unknown, not implicitly complete.
- Self-contained requests must not unconditionally fetch history.
- The automatic first page contains at most 20 messages.
- Current Handoff intent is the only source of side-effect authorization; historical messages are typed untrusted evidence.
- An existing authoritative Agent-private workflow session may resolve a direct status/cancellation reference without history.
- The existing total-invocation, query-invocation and query-byte limits remain authoritative.
- No message body, cursor, credential, prompt or model response may be added to ordinary logs.
- Implementation follows red-green-refactor.

---

### Task 1: Agent-Owned Context Preflight Policy

**Files:**
- Create: `examples/agently-agent-runtime/src/context-preflight-policy.ts`
- Create: `examples/agently-agent-runtime/test/context-preflight-policy.test.ts`

**Interfaces:**
- Consumes: `RuntimeTaskPackage`, `RuntimeCapabilitySummary`, `RuntimeCapabilityTranscript`, and the Daily Assistant private context.
- Produces: `DefaultContextPreflightPolicy.decide(...)` returning either `{ kind: "continue" }` or a complete `RuntimeCapabilityRequest`.

- [ ] **Step 1: Write failing tests for explicit follow-ups**

Create a table-driven test that passes Feishu-origin tasks with:

```ts
[
  "咋样了",
  "你把上面的事做一下",
  "按刚才说的继续",
  "How is that earlier task going?",
]
```

Each must return:

```ts
{
  kind: "request",
  request: {
    capability_id: "feishu.conversation.history.read",
    version_constraint: "1.0.0",
    input: {
      conversation: { kind: "current_conversation" },
      maximum_messages: 20,
    },
  },
}
```

Assert that the invocation ID is stable for the same Handoff and different for
different Handoffs.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test/context-preflight-policy.test.ts
```

Expected: FAIL because `DefaultContextPreflightPolicy` does not exist.

- [ ] **Step 3: Add failing negative and bound tests**

Cover:

```ts
"帮我创建一份标题为办公网环境、正文为测试内容的文档"
"这个日程取消吧" // with a matching active Agent-private session
```

Also cover non-Feishu source, missing capability, history declared as
`command`, and non-null transcript. Every case must return
`{ kind: "continue" }`.

- [ ] **Step 4: Implement the minimal policy**

Export:

```ts
export type ContextPreflightDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "request";
      readonly request: RuntimeCapabilityRequest;
    };

export interface ContextPreflightPolicy {
  decide(input: {
    readonly task: RuntimeTaskPackage;
    readonly available_capabilities: readonly RuntimeCapabilitySummary[];
    readonly transcript: RuntimeCapabilityTranscript | null;
    readonly agent_private_context: RuntimeJsonObject;
  }): ContextPreflightDecision;
}

export class DefaultContextPreflightPolicy
  implements ContextPreflightPolicy {
  decide(input: ContextPreflightInput): ContextPreflightDecision;
}
```

Use bounded text extraction, explicit Chinese/English reference patterns, an
exact query-capability check, and a SHA-256-derived stable invocation ID based
on tenant, Handoff and fixed preflight purpose. Do not expose source IDs in the
request.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npx vitest run examples/agently-agent-runtime/test/context-preflight-policy.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add examples/agently-agent-runtime/src/context-preflight-policy.ts \
  examples/agently-agent-runtime/test/context-preflight-policy.test.ts
git commit -m "feat(agent): add bounded context preflight policy"
```

### Task 2: Daily Assistant Driver Integration

**Files:**
- Modify: `examples/agently-agent-runtime/src/daily-assistant-driver.ts`
- Modify: `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`

**Interfaces:**
- Consumes: `ContextPreflightPolicy` from Task 1.
- Produces: a Driver that executes deterministic cancellation first, then
  context preflight, then the underlying model turn.

- [ ] **Step 1: Write the failing Driver test**

Add a test where:

```ts
task({ text: "你把上面的事做一下" })
```

is executed with an available query summary for
`feishu.conversation.history.read` and a null transcript. Assert:

```ts
expect(turn).toMatchObject({
  kind: "capability_request",
  request: {
    capability_id: "feishu.conversation.history.read",
    input: {
      conversation: { kind: "current_conversation" },
      maximum_messages: 20,
    },
  },
});
expect(underlying.executeTurn).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the Driver test and verify RED**

```bash
npx vitest run examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

Expected: FAIL because the underlying Driver returns a final answer.

- [ ] **Step 3: Add continuation and session precedence tests**

Assert:

1. a non-null history transcript is passed to the underlying Driver and does
   not repeat preflight;
2. deterministic proposal cancellation remains earlier than preflight;
3. a self-contained request reaches the underlying Driver without query;
4. a direct status request with a matching active scheduling session reaches
   the underlying Driver with private state instead of reading history.

- [ ] **Step 4: Wire the policy**

Extend the constructor without breaking existing callers:

```ts
constructor(
  underlying: CapabilityAwareAgentRuntimeDriver,
  store: AgentPrivateStateStore,
  options: {
    readonly now?: () => string;
    readonly context_preflight?: ContextPreflightPolicy;
  } = {},
)
```

After loading private context and applying deterministic cancellation:

```ts
const preflight = this.contextPreflight.decide({
  task,
  available_capabilities: availableCapabilities,
  transcript,
  agent_private_context: privateContext,
});
if (preflight.kind === "request") {
  return { kind: "capability_request", request: preflight.request };
}
```

Then continue through the existing enriched task, model turn and private-state
mutation path.

- [ ] **Step 5: Run policy and Driver suites**

```bash
npx vitest run \
  examples/agently-agent-runtime/test/context-preflight-policy.test.ts \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add examples/agently-agent-runtime/src/daily-assistant-driver.ts \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
git commit -m "feat(agent): retrieve context before ambiguous follow-ups"
```

### Task 3: Agently Epistemic and Safety Contract

**Files:**
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Modify: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- Consumes: current Handoff, dynamically disclosed capabilities and accumulated
  capability transcript.
- Produces: an explicit model contract for incomplete-by-default information,
  bounded query continuation and current-intent-only side-effect authorization.

- [ ] **Step 1: Write failing prompt-contract tests**

Add assertions requiring the capability-turn prompt to state:

```python
assert "authoritative but may be incomplete" in prompt
assert "authorized collaboration protocol" in prompt
assert "before asking the Human to repeat" in prompt
assert "has_more=true" in prompt
assert "must not invent a workflow type or status" in prompt
assert "current Handoff intent" in prompt
assert "historical messages" in prompt
```

Also require the prompt to distinguish a current status question from an
imperative “do the above” command.

- [ ] **Step 2: Run pytest and verify RED**

```bash
uv run --project runtimes/agently-worker pytest -q \
  runtimes/agently-worker/tests/test_assistant.py
```

Expected: the new assertions fail because the complete contract is absent.

- [ ] **Step 3: Clarify the role prompt**

Remove the apparent contradiction between “Do not use tools” and capability
requests by stating that the worker must not make private/vendor calls, while
Work Fabric capability requests are the authorized collaboration protocol.

Add the incomplete-information, progressive query, no-invention, same-sender
implicit-side-effect and current-intent authorization rules. Preserve all
existing calendar, private-state and Provider-result safety rules.

- [ ] **Step 4: Run Python tests and verify GREEN**

```bash
uv run --project runtimes/agently-worker pytest -q \
  runtimes/agently-worker/tests/test_assistant.py
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add \
  runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py \
  runtimes/agently-worker/tests/test_assistant.py
git commit -m "fix(agent): require grounded progressive context"
```

### Task 4: Capability-Loop Scenario and Documentation

**Files:**
- Modify: `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`
- Modify: `examples/agently-agent-runtime/test/documentation-contract.test.ts`
- Modify: `docs/guides/agently-agent-runtime.md`

**Interfaces:**
- Consumes: the preflight policy, typed history transcript and existing
  document capability contract.
- Produces: regression coverage for offline-history semantics and an operator
  description of the behavior.

- [ ] **Step 1: Add a failing multi-turn Driver scenario**

Use one scripted underlying Driver to verify this sequence:

```text
current "你把上面的事做一下"
-> deterministic history request
-> transcript contains same-sender offline document request
-> underlying requests feishu.document.create
-> document result transcript
-> underlying returns final result with clickable URL
```

Assert the original historical message is evidence only, the final reply is
Agent-authored, and no automatic history request repeats after the transcript
exists.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

Expected: FAIL until the scripted continuation expectations and final behavior
are correctly wired.

- [ ] **Step 3: Complete the minimal scenario and operator docs**

Document:

- long connection does not replay offline messages;
- explicit follow-ups read 20 recent messages through the Message Provider;
- self-contained requests do not fetch history;
- current intent authorizes actions and historical messages only supply facts;
- pagination remains bounded and Agent-driven.

Update the documentation-contract test to require these statements.

- [ ] **Step 4: Run focused TypeScript and Python suites**

```bash
npx vitest run \
  examples/agently-agent-runtime/test/context-preflight-policy.test.ts \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts \
  examples/agently-agent-runtime/test/documentation-contract.test.ts \
  examples/agently-agent-runtime/test/agently-daily-assistant.e2e.test.ts

uv run --project runtimes/agently-worker pytest -q \
  runtimes/agently-worker/tests/test_assistant.py
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts \
  examples/agently-agent-runtime/test/documentation-contract.test.ts \
  docs/guides/agently-agent-runtime.md
git commit -m "test(agent): cover progressive offline context"
```

### Task 5: Full Verification and Local Runtime Acceptance

**Files:**
- No production source additions.
- Runtime-only files remain under untracked `var/`.

**Interfaces:**
- Consumes: the completed branch.
- Produces: repository verification and a restarted live Feishu stack.

- [ ] **Step 1: Run static and repository verification**

```bash
git diff --check
npm run verify
```

Expected: type checking, all Vitest suites and 169 WFPP conformance scenarios
pass.

- [ ] **Step 2: Run the full Python worker suite**

```bash
uv run --project runtimes/agently-worker pytest -q
```

Expected: all tests pass.

- [ ] **Step 3: Restart the persistent local services**

Restart `com.workfabric.local-feishu` from this branch using the existing
environment/configuration and leave `com.workfabric.local-console` running.

- [ ] **Step 4: Verify runtime health**

```bash
npm run local:feishu:status
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8790/api/health/ready
```

Expected: Service, Feishu Provider, Daily Assistant, Message, Document,
Calendar and Context citizens all report ready.

- [ ] **Step 5: Perform the bounded live acceptance**

Send or replay through the approved local diagnostic entry:

```text
你把上面的事做一下
```

Verify protocol evidence shows `feishu.conversation.history.read` before any
document command, and verify the final response contains a semantic result
rather than internal Handoff identifiers. Do not create another live document
unless the current test command explicitly authorizes it.

- [ ] **Step 6: Commit any verification-only documentation correction**

If no correction is required, do not create an empty commit.
