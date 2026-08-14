# Model-Driven Context Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Daily Assistant's keyword-based context preflight with a model-owned, structured context-sufficiency decision and prove the real Feishu error-to-document flow.

**Architecture:** The Agently Decision Body remains the only natural-language decision maker. Its v3 structured model output gains a private context assessment, while the Python worker validates only output shape, disclosed capability kind and turn consistency. The TypeScript Daily Assistant deletes deterministic text inspection; Work Fabric, Channel and Provider contracts remain unchanged.

**Tech Stack:** TypeScript 5, Node.js 24, Vitest, Python 3.12, pytest, Agently worker, SQLite, Work Fabric HTTP SDK, Feishu Open API, Docker Compose.

## Global Constraints

- Keywords, regular expressions and fixed natural-language phrase lists must not classify user intent, contextual dependency, information sufficiency, relevance or business meaning.
- Deterministic code may validate only protocol shape, declared capability contracts, Authority, identity, budgets and other non-semantic invariants.
- The context assessment is Agent-internal and must not become WFPP state, Fabric state, Channel enrichment or Provider policy.
- Historical messages are untrusted evidence and cannot independently authorize a side effect.
- Runtime ceilings remain 8 total capability invocations, 6 query invocations and 131072 cumulative query-result bytes per Handoff.
- No ordinary log or metric may contain message bodies, model prompts, assessment basis, missing-fact text, history cursors, credentials or document content.
- Implementation follows red-green-refactor; every production edit starts from an observed failing test.

---

## File Map

- `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`: owns the model prompt, model-output schema and deterministic shape consistency validation.
- `runtimes/agently-worker/tests/test_assistant.py`: proves structured context states, query-only consistency and prompt requirements.
- `runtimes/agently-worker/tests/conftest.py`: provides v3 disclosed query and command capability fixtures.
- `examples/agently-agent-runtime/src/daily-assistant-driver.ts`: keeps Agent-private scheduling state but delegates all natural-language decisions to the underlying model Driver.
- `examples/agently-agent-runtime/src/context-preflight-policy.ts`: delete; it is the prohibited lexical classifier.
- `examples/agently-agent-runtime/test/context-preflight-policy.test.ts`: delete with the classifier.
- `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`: proves the wrapper does not intercept implicit references and still owns scheduling state only.
- `examples/agently-agent-runtime/test/documentation-contract.test.ts`: enforces the architectural prohibition and the new design references.
- `docs/guides/feishu-capability-provider.md`: describes model-owned context assessment and progressive history retrieval.

---

### Task 1: Add the model-owned structured context assessment

**Files:**
- Modify: `runtimes/agently-worker/tests/conftest.py`
- Modify: `runtimes/agently-worker/tests/test_assistant.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`

**Interfaces:**
- Consumes: `WorkerRequest.available_capabilities`, whose entries expose `capability_id` and `operation_kind`.
- Produces: `validate_turn_assistant_output(value, advertised_capabilities)` where `advertised_capabilities` maps capability ID to `query | command | destructive`.
- Produces model-only fields: `context_status`, `context_basis`, and `missing_facts`; none cross the worker terminal protocol.

- [ ] **Step 1: Add a disclosed history-query fixture**

Extend `valid_request_v3()` with this item before the existing document command:

```python
{
    "citizen_id": "citizen-feishu-message",
    "capability_id": "feishu.conversation.history.read",
    "version": "1.0.0",
    "name": "Read conversation history",
    "description": "Read one bounded page from the authorized conversation.",
    "operation_kind": "query",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["conversation", "maximum_messages"],
        "properties": {
            "conversation": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind"],
                "properties": {"kind": {"const": "current_conversation"}},
            },
            "maximum_messages": {"type": "integer", "minimum": 1, "maximum": 50},
        },
    },
}
```

- [ ] **Step 2: Write failing structured-output tests**

Add a test helper and cases to `test_assistant.py`:

```python
def contextual_turn(
    value: dict[str, object],
    *,
    status: str = "sufficient",
    basis: str = "当前请求包含完成本轮决策所需的信息",
    missing: list[str] | None = None,
) -> dict[str, object]:
    return {
        **value,
        "context_status": status,
        "context_basis": basis,
        "missing_facts": [] if missing is None else missing,
    }


def test_context_assessment_enforces_turn_consistency() -> None:
    capabilities = {
        "feishu.conversation.history.read": "query",
        "feishu.document.create": "command",
    }
    history = contextual_turn({
        "turn_type": "capability_request",
        "request_summary": "需要读取当前会话中的报错信息",
        "response": "",
        "invocation_id": "invocation-history-1",
        "capability_id": "feishu.conversation.history.read",
        "version_constraint": "1.0.0",
        "input": {
            "conversation": {"kind": "current_conversation"},
            "maximum_messages": 8,
        },
        "reason": "当前请求引用了尚未提供的报错详情",
        "private_state_action": "none",
        "private_state": {},
    }, status="needs_context", missing=["要写入文档的报错详情"])
    assert validate_turn_assistant_output(history, capabilities)["kind"] == "capability_request"

    with pytest.raises(AssistantOutputError, match="context"):
        validate_turn_assistant_output(
            contextual_turn({**history, "turn_type": "final", "response": "请重复报错"}, status="needs_context"),
            capabilities,
        )
    with pytest.raises(AssistantOutputError, match="context"):
        validate_turn_assistant_output(
            contextual_turn({**history, "capability_id": "feishu.document.create"}, status="needs_context"),
            capabilities,
        )
```

Add cases proving `sufficient + final`, `sufficient + command`, and
`exhausted + final` pass, while unknown status, empty basis, non-string
`missing_facts`, `exhausted + capability_request`, and an undisclosed
capability fail.

- [ ] **Step 3: Run the focused tests and observe red**

Run:

```bash
uv run --project runtimes/agently-worker pytest \
  runtimes/agently-worker/tests/test_assistant.py \
  -q
```

Expected: FAIL because `ASSISTANT_TURN_OUTPUT_SCHEMA` does not contain the
three context fields and `validate_turn_assistant_output` accepts only a set of
IDs.

- [ ] **Step 4: Extend the model schema and deterministic validator**

Add these fields to `ASSISTANT_TURN_OUTPUT_SCHEMA`:

```python
"context_status": (
    str,
    "sufficient、needs_context 或 exhausted；必须由模型按语义判断",
    "not_null",
),
"context_basis": (
    str,
    "上下文充分性判断的简短依据，不得包含隐藏推理过程",
    "not_null",
),
"missing_facts": (
    list,
    "当前仍缺失的事实；没有时返回空数组",
    True,
),
```

Change the validator signature to:

```python
def validate_turn_assistant_output(
    value: object,
    advertised_capabilities: Mapping[str, str] | None = None,
) -> dict[str, JsonValue]:
```

Validate the assessment before the existing final/request split:

```python
context_status = value["context_status"]
if context_status not in ("sufficient", "needs_context", "exhausted"):
    raise AssistantOutputError("assistant context status is invalid")
_non_empty_string(value["context_basis"], "context_basis", 2_048)
missing_facts = value["missing_facts"]
if (
    not isinstance(missing_facts, list)
    or len(missing_facts) > 32
    or any(not isinstance(item, str) or not item.strip() for item in missing_facts)
):
    raise AssistantOutputError("assistant missing facts are invalid")
```

Enforce these combinations without reading message text:

```python
if turn_type == "final" and context_status == "needs_context":
    raise AssistantOutputError("assistant context decision is inconsistent")
if turn_type == "capability_request" and context_status == "exhausted":
    raise AssistantOutputError("assistant context decision is inconsistent")
if (
    turn_type == "capability_request"
    and context_status == "needs_context"
    and advertised_capabilities is not None
    and advertised_capabilities.get(capability_id) != "query"
):
    raise AssistantOutputError("assistant context request must use a query capability")
```

In `execute_turn_with_agent`, replace the ID set with:

```python
advertised = {
    cast(str, item["capability_id"]): cast(str, item["operation_kind"])
    for item in request.available_capabilities
}
```

Keep `context_basis` and `missing_facts` private to the model boundary; do not
copy either into the Runtime result or logs.

- [ ] **Step 5: Strengthen the role prompt without adding a phrase list**

Require semantic assessment before turn selection:

```text
Before choosing final or capability_request, semantically assess whether the
current request contains all facts and referents needed for this turn. Resolve
implicit references by meaning, not by matching words or phrases. If material
facts may exist behind an authorized disclosed query, return needs_context and
request that read-only query before asking the Human to repeat them. Return a
short context_basis, never hidden chain-of-thought.
```

Update the two exact JSON output examples to include:

```json
"context_status":"sufficient",
"context_basis":"当前请求信息完整",
"missing_facts":[]
```

and update “ten keys” to “thirteen keys”. Add prompt assertions that require
semantic assessment and explicitly prohibit keyword, regex and phrase-list
intent routing.

- [ ] **Step 6: Update all v3 model fixtures and run green tests**

Wrap every `validate_turn_assistant_output` and v3 `FakeAgent.async_start`
fixture in `contextual_turn(...)`. Use:

- `sufficient` for existing final and command cases;
- `needs_context` only for read-only evidence queries;
- `exhausted` for bounded clarification cases.

Run:

```bash
uv run --project runtimes/agently-worker pytest \
  runtimes/agently-worker/tests/test_assistant.py \
  runtimes/agently-worker/tests/test_protocol.py \
  -q
```

Expected: PASS.

- [ ] **Step 7: Commit the worker contract**

```bash
git add \
  runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py \
  runtimes/agently-worker/tests/conftest.py \
  runtimes/agently-worker/tests/test_assistant.py
git commit -m "feat(agent): make context assessment model-owned"
```

---

### Task 2: Delete deterministic natural-language preflight

**Files:**
- Delete: `examples/agently-agent-runtime/src/context-preflight-policy.ts`
- Delete: `examples/agently-agent-runtime/test/context-preflight-policy.test.ts`
- Modify: `examples/agently-agent-runtime/src/daily-assistant-driver.ts`
- Modify: `examples/agently-agent-runtime/test/daily-assistant-driver.test.ts`
- Modify: `examples/agently-agent-runtime/test/documentation-contract.test.ts`

**Interfaces:**
- Consumes: the existing `CapabilityAwareAgentRuntimeDriver.executeTurn` boundary.
- Produces: `DailyAssistantDriver` that owns scheduling private state only and forwards natural-language turns to its underlying model Driver.

- [ ] **Step 1: Write a failing architecture guard test**

Add to `documentation-contract.test.ts`:

```ts
it("forbids deterministic natural-language intent classification", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  await expect(
    access(join(root, "examples/agently-agent-runtime/src/context-preflight-policy.ts")),
  ).rejects.toThrow();
  const driver = await readFile(
    join(root, "examples/agently-agent-runtime/src/daily-assistant-driver.ts"),
    "utf8",
  );
  expect(driver).not.toMatch(/ContextPreflightPolicy|explicitlyDependsOnEarlierContext/);
  const architecture = await readFile(join(root, "docs/architecture.md"), "utf8");
  expect(architecture).toContain("禁止用关键词、正则表达式或固定自然语言词表");
});
```

Import `access` from `node:fs/promises` and `join`, `resolve` from `node:path`.

- [ ] **Step 2: Run the guard and observe red**

Run:

```bash
npx vitest run \
  examples/agently-agent-runtime/test/documentation-contract.test.ts
```

Expected: FAIL because the policy file still exists and the Driver still
imports it.

- [ ] **Step 3: Remove the lexical policy from the Driver**

Delete both policy files. In `daily-assistant-driver.ts` remove:

- the `DefaultContextPreflightPolicy` and `ContextPreflightPolicy` imports;
- the `contextPreflight` property;
- `context_preflight` from the constructor options;
- the `this.contextPreflight.decide(...)` call and deterministic
  `capability_request` branch.

Retain `SchedulingSessionRepository`, cancellation handling, private-state
injection and final-state application. After cancellation handling, the next
operation must be construction of `enrichedTask` followed by the underlying
Driver call.

- [ ] **Step 4: Replace preflight tests with delegation tests**

Remove tests asserting automatic 20-message lookup. Add this case to
`daily-assistant-driver.test.ts`:

```ts
it("delegates an implicit contextual reference to the model Driver", async () => {
  const state = new MemoryAgentRuntimeStateStore();
  stores.push(state);
  const underlying = new StubDriver();
  underlying.executeTurn.mockResolvedValueOnce({
    kind: "capability_request",
    request: {
      invocation_id: "model-history-1",
      capability_id: "feishu.conversation.history.read",
      version_constraint: "1.0.0",
      input: {
        conversation: { kind: "current_conversation" },
        maximum_messages: 8,
      },
      reason: "需要取得当前请求所指的报错详情",
    },
  });
  const driver = new DailyAssistantDriver(underlying, state);
  const current = task({ text: "你把报错的详细信息记录到飞书文档里吧" });

  const turn = await driver.executeTurn(
    current,
    [historyCapability],
    null,
    async () => undefined,
    new AbortController().signal,
  );

  expect(turn).toMatchObject({
    kind: "capability_request",
    request: { capability_id: "feishu.conversation.history.read" },
  });
  expect(underlying.executeTurn).toHaveBeenCalledOnce();
  expect(underlying.executeTurn.mock.calls[0]?.[0].intent).toEqual(current.intent);
});
```

Keep existing scheduling-session tests; they prove the wrapper still owns its
private business state without moving it into Fabric.

- [ ] **Step 5: Run focused TypeScript tests**

Run:

```bash
npx vitest run \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts \
  examples/agently-agent-runtime/test/documentation-contract.test.ts \
  examples/agently-agent-runtime/test/scheduling-session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit lexical-policy removal**

```bash
git add -A \
  examples/agently-agent-runtime/src/context-preflight-policy.ts \
  examples/agently-agent-runtime/src/daily-assistant-driver.ts \
  examples/agently-agent-runtime/test/context-preflight-policy.test.ts \
  examples/agently-agent-runtime/test/daily-assistant-driver.test.ts \
  examples/agently-agent-runtime/test/documentation-contract.test.ts
git commit -m "refactor(agent): remove lexical intent preflight"
```

---

### Task 3: Prove the implicit error-to-document decision sequence

**Files:**
- Modify: `runtimes/agently-worker/tests/test_assistant.py`
- Modify: `docs/guides/feishu-capability-provider.md`

**Interfaces:**
- Consumes: the Agent model's structured `needs_context` and `sufficient` assessments.
- Produces: one read-only history request followed by one document command when the current Handoff explicitly asks to record retrieved error facts.

- [ ] **Step 1: Write the failing first-turn model decision test**

Build a v3 request whose exact intent is the observed message and return a
model-owned history request:

```python
@pytest.mark.asyncio
async def test_implicit_error_reference_is_decided_by_the_model() -> None:
    value = valid_request_v3()
    value["task"]["intent"] = [{
        "kind": "text",
        "media_type": "text/plain",
        "text": "你把报错的详细信息记录到飞书文档里吧",
    }]
    request = parse_request(value)
    agent = FakeAgent()

    async def assess() -> object:
        return contextual_turn({
            "turn_type": "capability_request",
            "request_summary": "先取得当前请求所指的报错详情",
            "response": "",
            "invocation_id": "model-history-error-1",
            "capability_id": "feishu.conversation.history.read",
            "version_constraint": "1.0.0",
            "input": {
                "conversation": {"kind": "current_conversation"},
                "maximum_messages": 8,
            },
            "reason": "当前文档任务缺少被引用的报错详情",
            "private_state_action": "none",
            "private_state": {},
        }, status="needs_context", missing=["报错代码和错误说明"])

    agent.async_start = assess  # type: ignore[method-assign]
    turn = await execute_turn_with_agent(request, agent)
    assert turn["kind"] == "capability_request"
    assert turn["request"]["capability_id"] == "feishu.conversation.history.read"
    assert "报错的详细信息" in str(agent.input_value)
```

Run this test before Task 1 production changes if it was not already observed
red; expected failure is the missing context-output contract.

- [ ] **Step 2: Write the post-history document decision test**

Add a transcript entry for `feishu.conversation.history.read` containing the
prior Agent-authored `calendar_not_registered` explanation. The second fake
model output must be:

```python
contextual_turn({
    "turn_type": "capability_request",
    "request_summary": "将已取得的日历报错详情写入飞书文档",
    "response": "",
    "invocation_id": "model-document-error-1",
    "capability_id": "feishu.document.create",
    "version_constraint": "1.0.0",
    "input": {
        "title": "Work Fabric 日历创建报错记录",
        "content": {
            "media_type": "text/markdown",
            "text": "## 报错详情\n\n- 错误代码：`calendar_not_registered`\n- 说明：Calendar is not registered",
        },
    },
    "reason": "当前 Handoff 明确要求把检索到的报错详情记录到文档",
    "private_state_action": "none",
    "private_state": {},
}, status="sufficient")
```

Assert that `turn_prompt_input(request)` contains the typed history result as
untrusted transcript evidence and that the returned command is exactly
`feishu.document.create`. Do not add the observed Chinese sentence to any
routing rule or production configuration.

- [ ] **Step 3: Run the exact scenario tests**

Run:

```bash
uv run --project runtimes/agently-worker pytest \
  runtimes/agently-worker/tests/test_assistant.py \
  -k 'context or implicit_error' \
  -q
```

Expected: PASS.

- [ ] **Step 4: Update the Feishu guide**

Replace the deterministic-preflight wording in the progressive context section
with this responsibility statement:

```text
Daily Assistant 的模型先输出结构化上下文充分性判断。模型认为当前请求缺少
可由已披露查询能力取得的事实时，才通过 Work Fabric 调用历史读取；Runtime
只校验 query 类型、Schema、Authority、has_more 和资源预算，禁止用关键词或
正则表达式判断自然语言意图。
```

Document the exact error-to-document example and state that historical facts
supply content while the current imperative supplies side-effect Authority.

- [ ] **Step 5: Commit the regression scenario and guide**

```bash
git add \
  runtimes/agently-worker/tests/test_assistant.py \
  docs/guides/feishu-capability-provider.md
git commit -m "test(agent): cover implicit context document flow"
```

---

### Task 4: Run focused and repository-wide verification

**Files:**
- Modify only files required by failures caused by the new required model fields; do not perform unrelated refactors.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a repository state in which all affected fixtures and conformance suites agree with the new internal model contract.

- [ ] **Step 1: Run all Agently worker tests**

```bash
uv run --project runtimes/agently-worker pytest \
  runtimes/agently-worker/tests \
  -q
```

Expected: every Python worker test passes.

- [ ] **Step 2: Run the affected TypeScript suites**

```bash
npx vitest run \
  packages/adapter-agent-runtime-agently/test \
  packages/agent-capability-runtime/test \
  examples/agently-agent-runtime/test \
  examples/feishu-capability-provider/test
```

Expected: every listed test passes. If a v3 fake model output lacks the new
three fields, update that test fixture with the semantically correct assessment
and rerun the same command.

- [ ] **Step 3: Prove no prohibited classifier remains**

Run:

```bash
rg -n \
  'explicitlyDependsOnEarlierContext|ContextPreflightPolicy|上面的事|刚才说的|how is it going' \
  examples/agently-agent-runtime/src \
  runtimes/agently-worker/src
```

Expected: no matches. Prompt examples may describe principles but must not
contain a routing vocabulary or phrase list.

- [ ] **Step 4: Run repository verification**

```bash
npm test
npm run test:conformance
npm audit --audit-level=high
```

Then run the repository's Python verification command recorded in
`package.json` or the root contributor guide if `npm test` does not already
include it:

```bash
uv run --project runtimes/agently-worker pytest -q
```

Expected: all tests and conformance checks pass; audit reports zero high or
critical vulnerabilities.

- [ ] **Step 5: Review the final diff and commit only necessary fixture fixes**

```bash
git diff --check
git status --short
git diff --stat HEAD~3..HEAD
```

If Task 4 required fixture-only changes, commit them separately:

```bash
git add \
  runtimes/agently-worker/tests/test_assistant.py \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts
git commit -m "test(agent): align context assessment fixtures"
```

Do not add `var/`, credentials, generated SQLite files, logs or deployment
secrets.

---

### Task 5: Push, deploy and perform real model/Feishu acceptance

**Files:**
- No Work Fabric source changes expected.
- Deployment state: an exact detached worktree at `$DEPLOY_WORKTREE_ROOT/work-fabric-office-$commit` on `<deployment-user>@<office-host>:<ssh-port>`, where `$commit` is assigned from `git rev-parse HEAD` before deployment.

**Interfaces:**
- Consumes: a verified Work Fabric commit and the existing private-deploy runbook.
- Produces: a healthy office-network deployment with the default Calendar binding preserved and a real model-selected history-to-document sequence.

- [ ] **Step 1: Read the deployment runbook and verify branch state**

```bash
sed -n '1,260p' \
  "$PRIVATE_DEPLOY_ROOT/docs/runbooks/agent-deployment-guide.md"
git status --short --branch
git log -1 --oneline
```

Expected: only user-owned `var/` remains untracked and all implementation
commits are present.

- [ ] **Step 2: Push the verified branch**

```bash
git push origin codex/agent-progressive-context
```

Expected: the remote branch advances to the verified commit.

- [ ] **Step 3: Build and deploy the exact commit**

Follow the runbook to create an exact detached deployment worktree under
`/opt/agently/deploy-worktrees`, build the Work Fabric image from that commit,
and recreate only the Work Fabric service. Preserve the existing bind-mounted
`/srv/agently/data/work-fabric` directory and secret file.

After recreation, verify:

```bash
docker inspect -f \
  'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}' \
  agently-work-fabric-work-fabric-1
```

Expected: `status=running health=healthy restarts=0`.

- [ ] **Step 4: Verify the Calendar binding survived deployment**

Inside the container, run:

```bash
WORK_FABRIC_ADMIN_PRINCIPAL_ID=principal-work-fabric-admin \
npm run feishu-calendar:admin -- list
```

Expected: alias `team` is active, `access_role` is `owner`, and
`is_default` is `true`. Do not print credentials.

- [ ] **Step 5: Run a real-model assessment smoke test before asking the Human**

Submit a bounded v3 worker request to the configured Agently worker with the
exact intent `你把报错的详细信息记录到飞书文档里吧`, the disclosed history query
and document command, and no transcript. Inspect only the structured terminal
record.

Expected:

```json
{
  "kind": "capability_request",
  "request": {
    "capability_id": "feishu.conversation.history.read"
  }
}
```

Do not retain or print the model prompt, API key, context basis or message
content in deployment logs.

- [ ] **Step 6: Run the real Feishu end-to-end acceptance**

Ask the Human to send one new message in the existing Feishu group:

```text
@AI助理 你把报错的详细信息记录到飞书文档里吧
```

Inspect the durable capability invocation records and verify this order:

1. current Feishu Handoff accepted by Daily Assistant;
2. `feishu.conversation.history.read` succeeds;
3. `feishu.document.create` succeeds exactly once;
4. Agent returns one semantic Feishu reply with a clickable document URL;
5. no keyword classifier, Channel enrichment or Fabric business decision is involved.

- [ ] **Step 7: Record final evidence**

Report the deployed source commit, container health, Calendar binding status,
focused/full test counts, the two capability IDs and their outcome classes,
and the created document URL. Do not report message bodies, Actor identifiers,
tokens, cursors, prompts or secret-bearing configuration.
