# Authoritative Calendar Query and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make calendar-list answers use authoritative Feishu facts and make proposal cancellation atomically terminate the Daily Assistant's private scheduling session.

**Architecture:** Add one read-only capability wholly owned by the Feishu Calendar Provider, authorized to the trusted current sender. Keep scheduling interpretation and cancellation in the Daily Assistant, with the Runtime adapter persisting validated Agent-private state before returning a reply. Work Fabric Core and the Feishu Channel remain unchanged.

**Tech Stack:** TypeScript, Vitest, Python 3, pytest, Agently structured output, Feishu Calendar OpenAPI, SQLite-backed Agent private state

## Global Constraints

- Fabric only validates, propagates and records collaboration facts; it does not orchestrate Calendar or Agent behavior.
- Calendar Provider returns typed external facts and owns Feishu API semantics.
- Daily Assistant owns scheduling interpretation, replies and private session state.
- Feishu Channel does not synthesize business replies or inspect Agent state.
- No event title or semantic detail may be invented when Feishu redacts it.
- Every production behavior is introduced by a failing test first.

---

### Task 1: Provider event-list contract

**Files:**
- Modify: `packages/provider-feishu/src/calendar-contracts.ts`
- Modify: `packages/provider-feishu/src/calendar-declarations.ts`
- Modify: `packages/provider-feishu/src/calendar-validation.ts`
- Test: `packages/provider-feishu/test/calendar-declarations.test.ts`
- Test: `packages/provider-feishu/test/calendar-validation.test.ts`

**Interfaces:**
- Produces: `CalendarEventListInput`, normalized event-page facts, and capability ID `feishu.calendar.events.list`
- Consumes: existing Calendar resource adapters and declaration helpers

- [x] **Step 1: Write failing declaration and validation tests**

Add assertions that the capability is a low-risk query, accepts one authorized
user subject, a maximum 31-day RFC3339 window, `page_size` 1-50 and an optional
opaque token, and rejects unknown fields, invalid subjects and oversized
windows.

- [x] **Step 2: Run tests and observe the missing capability failures**

Run:

```bash
npx vitest run packages/provider-feishu/test/calendar-declarations.test.ts packages/provider-feishu/test/calendar-validation.test.ts
```

Expected: FAIL because `feishu.calendar.events.list` is not declared or parsed.

- [x] **Step 3: Implement the minimal typed contract, schemas and parser**

Add the new input to `CalendarExecutionInput`, publish bounded input/output
schemas, and route it through `parseCalendarExecutionInput`.

- [x] **Step 4: Run the focused tests**

Run the Step 2 command. Expected: PASS.

### Task 2: Feishu OpenAPI event facts

**Files:**
- Modify: `packages/provider-feishu/src/calendar-contracts.ts`
- Modify: `packages/provider-feishu/src/calendar-openapi-backend.ts`
- Test: `packages/provider-feishu/test/calendar-openapi-backend.test.ts`

**Interfaces:**
- Produces: `FeishuCalendarBackend.listPrimaryEvents(...)`
- Consumes: `FeishuOpenApiRequestClient`

- [x] **Step 1: Write failing tests for primary resolution, pagination, redaction and all-day boundaries**

The fake request client must observe:

```text
POST /open-apis/calendar/v4/calendars/primarys?user_id_type=open_id
GET  /open-apis/calendar/v4/calendars/{id}/events?...&op_user_id={open_id}
```

Assert that missing summaries become `details_visible=false`, visible summaries
are preserved, all-day values stay dates, and provider tokens stay opaque.

- [x] **Step 2: Run the focused backend test and observe the missing method**

```bash
npx vitest run packages/provider-feishu/test/calendar-openapi-backend.test.ts
```

Expected: FAIL because `listPrimaryEvents` does not exist.

- [x] **Step 3: Implement bounded response normalization**

Resolve exactly one requested primary calendar, classify its role, issue one
event page request, normalize each event, and fail closed on malformed data.

- [x] **Step 4: Run the focused backend test**

Run the Step 2 command. Expected: PASS.

### Task 3: Calendar Provider executor and local Authority

**Files:**
- Modify: `packages/provider-feishu/src/calendar-executor.ts`
- Modify: `examples/agently-agent-runtime/src/local-invocation-authority.ts`
- Test: `packages/provider-feishu/test/calendar-executor-query.test.ts`
- Test: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`

**Interfaces:**
- Consumes: `CalendarEventListInput` and `FeishuCalendarBackend.listPrimaryEvents`
- Produces: typed Capability outcome with Feishu provenance

- [x] **Step 1: Write failing authorization and executor tests**

Assert that only `source_reference.extensions["workfabric.dev/sender_resource_uri"]`
may be queried, another user is denied, redacted event facts are returned
without a fabricated title, and paging fields survive.

- [x] **Step 2: Run the focused tests and observe unsupported capability failures**

```bash
npx vitest run packages/provider-feishu/test/calendar-executor-query.test.ts examples/agently-agent-runtime/test/local-invocation-authority.test.ts
```

- [x] **Step 3: Implement the scope, Authority and executor branch**

Reuse `calendar_event:read`; add the trusted sender to
`allowed_target_refs`; map backend facts to stable resource URIs and typed
JSON.

- [x] **Step 4: Run the focused tests**

Run the Step 2 command. Expected: PASS.

### Task 4: Agent-owned proposal cancellation

**Files:**
- Modify: `examples/agently-agent-runtime/src/scheduling-session.ts`
- Modify: `examples/agently-agent-runtime/src/daily-assistant-driver.ts`
- Test: `examples/agently-agent-runtime/test/scheduling-session.test.ts`
- Test: `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`

**Interfaces:**
- Consumes: a model final turn containing `phase=cancelled`
- Produces: a terminal private state that is absent from later `active_session`

- [x] **Step 1: Write failing repository and Driver tests**

Persist an `awaiting_confirmation` proposal, then return a cancellation final
turn from the stub model. Assert version increments, stored phase is
`cancelled`, the final text is returned only after persistence, and the next
enriched task has `active_session=null`. Also assert that a different sender
cannot cancel.

- [x] **Step 2: Run the focused tests and observe missing cancellation validation**

```bash
npx vitest run examples/agently-agent-runtime/test/scheduling-session.test.ts examples/agently-agent-runtime/test/daily-assistant-driver.test.ts
```

- [x] **Step 3: Implement the minimal cancellation invariants**

Validate active phase, original initiator, null side-effect fields and empty
evidence. Keep optimistic persistence in the Driver before returning the final
Result.

- [x] **Step 4: Run the focused tests**

Run the Step 2 command. Expected: PASS.

### Task 5: Agently decision contract

**Files:**
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Test: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- Produces: model instructions and validated structured state for authoritative event queries and cancellation
- Consumes: dynamic capability summaries and trusted `agent_private_context`

- [x] **Step 1: Write failing prompt and output-contract tests**

Assert that the prompt requires `feishu.calendar.events.list` for calendar
truth, uses only the current sender as subject, treats redacted items as busy
slots, forbids proposal substitution, and requires `private_state_action=update`
for proposal cancellation with all eight state fields.

- [x] **Step 2: Run the Python test and observe the missing rules**

```bash
uv run --project runtimes/agently-worker pytest -q runtimes/agently-worker/tests/test_assistant.py
```

- [x] **Step 3: Extend the scheduling state schema and prompt**

Allow `cancelled`, describe the exact cancellation envelope, and retain generic
dynamic capability selection.

- [x] **Step 4: Run the Python test**

Run the Step 2 command. Expected: PASS.

### Task 6: Documentation and verification

**Files:**
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/superpowers/plans/2026-07-31-authoritative-calendar-query-and-cancellation.md`

**Interfaces:**
- Documents: permissions, current free/busy visibility, example Agent behavior and module boundaries

- [x] **Step 1: Document configuration and permission behavior**

Document `calendar:calendar.event:read` or
`calendar:calendar:readonly`, the difference between application
`free_busy_reader` and full event visibility, pagination, and the fact that
proposal cancellation does not delete an external event.

- [x] **Step 2: Run focused verification**

```bash
npx vitest run packages/provider-feishu/test examples/agently-agent-runtime/test
uv run --project runtimes/agently-worker pytest -q
```

- [x] **Step 3: Run repository verification**

```bash
npm run typecheck
npm test
npm run conformance
```

- [x] **Step 4: Run an opt-in real read-only smoke query**

Use the configured Feishu application identity to query the known current
sender through the new Provider backend. Record only counts, access mode and
visibility counts; never print credentials or raw private event content.

- [x] **Step 5: Review the final diff and commit**

```bash
git status --short
git diff --check
git diff --stat
git add packages/provider-feishu examples/agently-agent-runtime runtimes/agently-worker docs
git commit -m "fix(calendar): use authoritative event facts"
git push origin codex/debug-channel
```

