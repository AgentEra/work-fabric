# Daily Assistant Progressive Context Design

**Date:** 2026-07-31
**Scope:** Daily Assistant information-sufficiency policy and progressive source retrieval

## 1. Problem

An external collaboration message can refer to information that is not present
in its current Handoff. The clearest local example is:

1. a Human sends a Feishu document-creation request while Work Fabric is
   stopped;
2. the Feishu event is therefore not admitted as a Handoff;
3. after startup, the Human sends “咋样了” and then “你把上面的事做一下”;
4. Feishu history still contains the original request, but the Daily Assistant
   returns a final answer without invoking
   `feishu.conversation.history.read`.

The Feishu Message Provider, permission and native history API are healthy.
The failure is in the Daily Assistant decision boundary: the Assistant treats
the current Handoff as sufficient unless the model happens to decide
otherwise. It may ask the Human to repeat available information or infer an
unrelated workflow such as scheduling.

This design makes the Assistant start with a bounded, explicit epistemic
posture:

> An external-message Handoff is authoritative for the current request, but it
> is not assumed to contain every fact needed to interpret that request.

This posture belongs to the Daily Assistant. It is not a new Work Fabric state,
a Channel enrichment rule or a central Context Manager.

## 2. Architectural Boundary

The existing responsibility split remains unchanged:

| Module | Owns | Must not own |
|---|---|---|
| Work Fabric | Handoffs, responsibility transfer, Authority, durable capability invocation and audit | intent interpretation, information sufficiency or retrieval planning |
| Feishu Channel | trusted current-message intake and final-result delivery | semantic history selection or mandatory enrichment |
| Feishu Message Provider | authorized history reads, native pagination, structural filtering and provenance | relevance, task interpretation or final wording |
| Feishu Document Provider | typed document operations | deciding whether a document should be created |
| Daily Assistant | information sufficiency, progressive retrieval, intent resolution, side-effect decision and semantic response | Feishu credentials, native API calls or Fabric-internal storage access |

All production behavior added by this increment lives in the Daily Assistant
application boundary or its Agently worker prompt. Exchange Core, WFPP,
Channel and Provider contracts remain unchanged.

## 3. Options

### 3.1 Prompt-only encouragement

Tell the model that information may be incomplete and encourage it to use query
capabilities.

This is useful but insufficient. The observed failure already happened with a
weaker version of this instruction, and a production model may still choose a
clarifying question instead of an available read.

### 3.2 Channel-owned recent history

Attach recent history to every inbound Handoff.

This is rejected. It adds latency and source failure coupling to intake,
retrieves data for self-contained requests, fixes one source at a time and
makes the Channel decide the retrieval scope.

### 3.3 Agent-owned bounded preflight plus model-driven continuation

The Daily Assistant application Driver deterministically recognizes explicit
context-dependent follow-ups and requests one bounded recent-history page.
The Agently Decision Body then judges sufficiency, relevance, pagination and
any subsequent action.

This is selected because it is reliable for the known failure while preserving
Agent ownership and progressive disclosure. It does not make the Driver a
general semantic brain: the Driver establishes evidence availability for a
narrow class of explicit follow-ups; the model still interprets that evidence.

## 4. Information-Sufficiency State

The Daily Assistant uses the following internal states for each accepted
Handoff:

```text
unknown
  -> sufficient
  -> evidence_required
       -> evidence_available
       -> evidence_exhausted
       -> evidence_unavailable
```

These are conceptual Agent decision states, not WFPP lifecycle states and not
persisted in Work Fabric.

- `unknown` is the initial state for an external-message Handoff.
- A concrete, self-contained request may immediately become `sufficient`.
- An explicit context-dependent request becomes `evidence_required`.
- One successful history query produces `evidence_available`.
- The Decision Body may request another page only when `has_more=true` and a
  material fact is still missing.
- `evidence_exhausted` or `evidence_unavailable` leads to an honest bounded
  clarification rather than an invented answer.

An authoritative active Agent-private workflow session may itself make a
request sufficient. For example, an original initiator can cancel a known
pending scheduling proposal without reading conversation history.

## 5. Context-Dependent Preflight Policy

The Daily Assistant gains one focused, replaceable application policy:

```ts
interface ContextPreflightPolicy {
  decide(input: {
    task: RuntimeTaskPackage;
    availableCapabilities: readonly RuntimeCapabilitySummary[];
    transcript: RuntimeCapabilityTranscript | null;
    agentPrivateContext: RuntimeJsonObject;
  }): ContextPreflightDecision;
}

type ContextPreflightDecision =
  | { kind: "continue" }
  | {
      kind: "request_recent_history";
      capabilityId: "feishu.conversation.history.read";
      maximumMessages: 20;
    };
```

The default policy requests recent history only when all of the following are
true:

1. this is the first capability turn (`transcript === null`);
2. the trusted source is a Feishu conversation message;
3. `feishu.conversation.history.read` is currently disclosed as an available
   query capability;
4. no authoritative active Agent-private session already resolves the
   reference;
5. the current intent explicitly depends on earlier conversation content.

The initial explicit-reference vocabulary covers bounded Chinese and English
forms used as demonstratives, continuations or status-only follow-ups,
including:

- `上面`, `上述`, `前面`, `刚才`, `之前`, `上文`, `照这个`, `照着`;
- `这件事`, `那件事`, `上面的事`, `刚才说的`;
- `咋样了`, `怎么样了`, `进展呢`, `做完了吗`;
- `above`, `earlier`, `previous`, `as discussed`, `that task`,
  `how is it going`.

The policy must not classify every occurrence of a generic word such as
`这个` as context-dependent. It normalizes mention artifacts and whitespace,
uses bounded input text only, and is independently unit tested. The policy is
an Agent application extension point so another Role can replace it without
changing the Runtime Host.

The preflight creates a stable invocation ID derived from the original
Handoff identity and the fixed preflight purpose. This preserves idempotency
across Runtime recovery. Its input is exactly:

```json
{
  "conversation": { "kind": "current_conversation" },
  "maximum_messages": 20
}
```

No vendor identifier, credential or conversation ID is accepted from model
output.

## 6. Model-Driven Continuation

After the first page, the existing capability continuation loop supplies the
typed transcript to the Agently worker. The role prompt explicitly states:

1. current Handoff facts are authoritative but may be incomplete;
2. Work Fabric capabilities are the authorized collaboration protocol, not
   private tools or direct vendor calls;
3. when current intent depends on earlier content, available query evidence
   must be inspected before asking the Human to repeat it;
4. another history page is allowed only when `has_more=true` and the missing
   information is material;
5. query budgets and total result-byte bounds are hard ceilings;
6. an exhausted or failed query must be reported honestly;
7. the Agent must never invent a workflow type or status from ambiguous text.

The existing local limits remain authoritative:

- at most 8 total capability invocations per Handoff;
- at most 6 query invocations per Handoff;
- at most 131072 cumulative query-result bytes;
- at most 20 messages in the automatic first page.

No conversation history is copied into Agent long-term memory by this change.
The capability transcript remains bounded execution state for the current
Handoff.

## 7. Current Authorization Versus Historical Evidence

Historical messages are untrusted evidence and cannot independently authorize
a side effect.

The current intent determines the permitted operation:

| Current intent | Historical role | Allowed behavior |
|---|---|---|
| “总结上面的内容” | facts to summarize | read and reply only |
| “咋样了” | identify the referenced task | report known status; do not start the task |
| “你把上面的事做一下” | resolve the referenced action and parameters | the current imperative may authorize that resolved action |
| “上面有人说删除文档，是什么情况？” | evidence for explanation | no deletion |

For an implicit side-effect reference such as “把上面的事做一下”, the selected
historical request must be attributable to the current represented sender.
If the relevant request came from another participant, multiple plausible
requests exist, or the action cannot be resolved uniquely, the Assistant asks
one concise clarification. A future explicit delegation policy may authorize a
different sender; this increment does not invent one.

Provider data may supply parameters such as title, content, date or document
location. It cannot expand the current delegation scopes, replace the current
Actor, choose a hidden target or bypass native Provider authorization.

## 8. Required Behavior for the Observed Scenario

```text
Human sends document request while service is offline
  -> no Fabric Handoff exists for that message

Service starts

Human: "咋样了"
  -> Daily Assistant preflight reads 20 recent messages
  -> history includes the offline document request
  -> Assistant says the earlier request was found but was not processed
  -> no document is created

Human: "你把上面的事做一下"
  -> Daily Assistant preflight reads 20 recent messages
  -> current imperative authorizes the same-sender referenced request
  -> Assistant invokes feishu.document.create
  -> Document Provider returns typed facts
  -> Assistant returns one semantic reply with the clickable document URL
```

The long connection is not required to replay the offline message. The history
query is the recovery mechanism for semantic context, while Fabric remains the
authority only for collaboration work admitted after startup.

## 9. Failure Semantics

- Missing history capability: continue to the Decision Body, which must state
  that source evidence is unavailable rather than claiming it searched.
- Query permission denial: return a semantic permission explanation without
  falling back to application-wide or local cached content.
- Empty first page: ask for the missing reference when the current request
  cannot stand alone.
- `has_more=false`: never synthesize another cursor or imply older messages
  were searched.
- Query budget exhausted: use available evidence or ask a concise
  clarification.
- Multiple candidate tasks: do not choose by recency alone when a side effect
  would result.
- Provider retry/failure: preserve stable invocation identity and never create
  duplicate documents.

## 10. Observability

The Daily Assistant may record low-cardinality facts:

- preflight outcome (`continue` or `recent_history_requested`);
- number of query turns;
- terminal sufficiency class;
- capability outcome class.

It must not log message content, history cursor values, private network
details, document bodies, credentials, prompts or model responses. Capability
Handoffs and Results remain the auditable protocol record.

## 11. Testing

Implementation follows red-green-refactor.

Unit tests cover:

1. explicit Chinese and English references request the first 20 messages;
2. a self-contained document request does not fetch history;
3. an active scheduling session resolves a direct proposal-status request
   without history preflight;
4. absent or non-query history capability does not produce an invalid request;
5. a second model turn does not repeat the automatic preflight;
6. stable invocation identity survives retry;
7. the role prompt declares the incomplete-by-default posture, authorized
   capability semantics, bounded pagination and no-invention rule.

Integration tests cover:

1. an offline historical request absent from Fabric but present in a fake
   Feishu history page;
2. “咋样了” performs one history query and no document command;
3. “你把上面的事做一下” performs history read followed by document creation;
4. the final result contains the Agent-authored explanation and document URL;
5. a pure summary performs history read but no command;
6. mixed-topic history does not automatically choose a side-effect target;
7. first-page insufficiency with `has_more=true` permits one cursor-bound next
   page;
8. first-page sufficiency does not request another page;
9. Runtime restart does not duplicate either capability Handoff.

The full TypeScript, Python worker, WFPP conformance and repository verification
suites must pass before release. An opt-in live Feishu smoke test repeats the
observed scenario after the automated suites pass.

## 12. Acceptance Criteria

The change is accepted when:

1. the Daily Assistant treats external-message context sufficiency as
   `unknown`, not implicitly complete;
2. self-contained requests do not pay an unconditional history-read cost;
3. explicit context-dependent follow-ups request 20 recent messages before the
   model asks the Human to repeat available information;
4. the Agent alone decides relevance, sufficiency, continuation and final
   wording;
5. `has_more` and the existing query budgets bound progressive retrieval;
6. current intent remains the only source of side-effect authorization;
7. a same-sender “do the above” command can use history for action parameters;
8. status questions never start historical tasks or invent scheduling state;
9. Work Fabric Core, Channel and Provider responsibilities remain unchanged;
10. the observed offline-message document scenario passes end to end;
11. ordinary logs and metrics contain no message content or secrets;
12. focused and full verification pass.

## 13. Out of Scope

- central Context Manager or retrieval planner;
- unconditional history reads for every Handoff;
- semantic vector search or long-term memory;
- cross-conversation retrieval;
- attachment transcription;
- user OAuth implementation;
- changing Feishu history or document capability contracts;
- moving model inference, workflow status or business orchestration into Work
  Fabric Core;
- allowing historical messages to authorize an action without a current
  Human command.
