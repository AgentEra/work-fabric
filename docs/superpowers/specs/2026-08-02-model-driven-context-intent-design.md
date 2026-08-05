# Model-Driven Context Intent Design

**Date:** 2026-08-02
**Scope:** Daily Assistant context-sufficiency decisions and progressive source retrieval
**Supersedes:** The deterministic intent-classification portions of
`2026-07-31-daily-assistant-progressive-context-design.md`, especially
Sections 3.3, 5, 11 and acceptance criteria 2–3

## 1. Problem and Evidence

The deployed Daily Assistant received this Feishu follow-up after reporting a
calendar error:

```text
你把报错的详细信息记录到飞书文档里吧
```

The preceding bot message was available from the authorized Feishu history API
as a supported `post` message. Nevertheless, the Agent asked the Human to
repeat the error and did not invoke either
`feishu.conversation.history.read` or a document capability.

The failure originated in `DefaultContextPreflightPolicy`. It used a regular
expression containing phrases such as `上面`, `刚才` and `之前` to decide
whether the request depended on earlier conversation content. The actual
request used an implicit definite reference—`报错的详细信息`—and therefore
bypassed preflight. Adding that phrase to the expression would only move the
failure to the next unenumerated expression.

Natural-language intent and contextual dependency are semantic decisions. A
fixed word list cannot own them in a production Agent.

## 2. Non-Negotiable Rule

For Agent-owned natural-language work:

> Keywords, regular expressions and fixed natural-language phrase lists must
> not classify user intent, contextual dependency, information sufficiency,
> relevance or business meaning. These decisions belong to the Agent model.
> Deterministic code may validate only protocol shape, declared capability
> contracts, Authority, identity, budgets and other non-semantic invariants.

This rule does not place a model in Work Fabric. Fabric remains a connection,
handoff and shallow collaboration-state network and must not interpret user
language.

Structural checks remain deterministic. For example, code may verify that a
source is an authorized conversation message, that a capability is currently
disclosed as a query, that `has_more` is true, or that a page limit is not
exceeded. It must not infer from the message text whether history is relevant.

## 3. Responsibility Boundary

| Component | Owns | Must not own |
|---|---|---|
| Work Fabric | Handoff, Authority, capability exchange, audit and shallow state | intent or context-sufficiency decisions |
| Channel | trusted intake and result rendering | semantic enrichment or relevance selection |
| Source Provider | authorized typed history reads, native pagination, structural filtering and provenance | deciding whether or why the Agent needs history |
| Agent model | intent, implicit references, sufficiency, relevance, pagination need and final semantics | credentials, native API calls or Fabric persistence |
| Agent Runtime | model invocation, structured-output validation, capability budgets, recovery and idempotency | keyword-based semantic fallback or rewriting Agent meaning |

No new Context Manager, workflow brain or Fabric service is introduced.

## 4. Selected Design

The existing Agent capability turn remains the decision point. The
deterministic preflight classifier is removed rather than replaced by another
heuristic.

On every initial capability-aware Agent turn, the model receives:

- the current Handoff intent and trusted source metadata;
- Agent-private workflow state, when present;
- dynamically disclosed capability summaries and input schemas;
- the existing incomplete-by-default epistemic posture;
- an empty capability transcript on the first turn.

Before choosing a final response or a capability request, the model must return
a structured context assessment:

```ts
type ContextAssessment =
  | {
      status: "sufficient";
      basis: string;
      missing_facts: [];
    }
  | {
      status: "needs_context";
      basis: string;
      missing_facts: string[];
    }
  | {
      status: "exhausted";
      basis: string;
      missing_facts: string[];
    };
```

This is an Agent-internal structured decision, not a WFPP message or Fabric
state. `basis` is a short decision summary, not hidden chain-of-thought, and is
not sent to the collaboration channel.

The allowed turn combinations are:

| Context status | Allowed next turn |
|---|---|
| `sufficient` | final response or a disclosed capability needed to perform the current request |
| `needs_context` | a disclosed read-only query capability request |
| `exhausted` | one concise clarification or bounded honest explanation |

The Runtime validates only this structural consistency. It does not decide
which status is semantically correct. The model selects a suitable query from
the dynamic capability catalog; neither the Runtime protocol nor the policy
hard-codes Feishu as the only possible source.

## 5. Progressive Retrieval

When the model selects `feishu.conversation.history.read`, the request travels
through the existing Work Fabric capability Handoff. The Feishu Message
Provider returns one typed page with provenance, `has_more` and an opaque
cursor. On the next Agent turn, the model reassesses sufficiency using the
capability transcript.

The model may request another page only when the returned facts still do not
resolve a material part of the current request and `has_more=true`. Runtime
enforces the existing ceilings:

- at most 8 total capability invocations per Handoff;
- at most 6 query invocations per Handoff;
- at most 131072 cumulative query-result bytes;
- at most 50 messages per Provider request, with the normal Agent request using
  the smallest useful bounded page.

The first page size is model-selected within the declared schema and Runtime
ceilings. No unconditional Channel enrichment is introduced.

## 6. Authority and Safety

Historical content is untrusted evidence. It may supply facts and parameters,
but it cannot create Authority or independently authorize a side effect. The
current Handoff intent remains the only source of action authorization.

The Agent must:

- distinguish a request to explain an earlier error from a request to record
  that error in a document;
- use historical facts only from the authorized source and current capability
  transcript;
- avoid choosing among ambiguous historical tasks when a side effect would
  result;
- ask one concise clarification when authorized evidence is absent, exhausted
  or ambiguous;
- never claim that it searched history when no successful query result exists.

Runtime and Provider continue to enforce same-conversation boundaries, trigger
time, delegation scope, cursor binding, expiry and query budgets.

## 7. Migration

Implementation removes the deterministic text classifier and its phrase-list
tests from the Daily Assistant application boundary. The replaceable Driver
may retain non-semantic structural policy, but it may not inspect natural
language to classify meaning.

The Agently structured model-output contract gains the context assessment.
Parser validation rejects inconsistent output shapes, such as
`needs_context` paired with a final answer or a command capability. The parser
does not second-guess a model-provided `sufficient` assessment using text
rules.

The role prompt explicitly prohibits lexical classification and requires the
model to reason over implicit references before asking the Human to repeat
retrievable information. Capability selection remains based on live disclosure
and Provider-owned input schemas.

## 8. Observability

Low-cardinality telemetry may record:

- context assessment status;
- selected capability ID and outcome class;
- query page count and cumulative result size;
- terminal state (`completed`, `clarification`, `exhausted` or `failed`).

It must not log message bodies, model prompts, assessment basis, missing-fact
text, history cursors, credentials or document content.

## 9. Testing and Live Acceptance

Implementation follows red-green-refactor.

Automated tests must prove:

1. the deterministic preflight no longer inspects intent text or contains a
   natural-language phrase list;
2. model output accepts the three context-assessment states and rejects
   structurally inconsistent turn combinations;
3. `needs_context` can select only a disclosed read-only query capability;
4. a successful history result returns to the model for a fresh assessment;
5. pagination remains bounded by `has_more`, invocation count and byte limits;
6. historical facts cannot authorize a command without the current intent;
7. Provider, Channel and Fabric contracts remain unchanged;
8. focused TypeScript and Python suites pass before full repository
   verification.

The live deployment acceptance scenario is:

```text
Agent reports a concrete calendar error
Human: 你把报错的详细信息记录到飞书文档里吧
Agent model: needs_context
Agent -> history query
Agent model: sufficient, current imperative authorizes document creation
Agent -> document create
Agent -> one semantic reply containing the document URL
```

The exact phrase above must succeed without adding it or any synonym to source
code, prompts as a routing list, configuration or tests as a keyword matcher.
The live test inspects capability Handoffs to prove that the model selected the
history query before document creation.

## 10. Acceptance Criteria

The change is accepted when:

1. no deterministic component uses natural-language keywords or regular
   expressions to classify context dependency or intent;
2. the Agent model produces a validated structured context assessment;
3. implicit references can trigger progressive retrieval through dynamic
   capability disclosure;
4. the Runtime enforces safety and resource ceilings without owning semantics;
5. the Provider owns source access while the Agent owns relevance and
   continuation;
6. Fabric Core and Channel remain unchanged;
7. the observed error-to-document scenario passes against the real deployed
   model and Feishu capabilities;
8. ordinary logs and metrics contain no private content or secrets;
9. focused and full automated verification pass.

## 11. Out of Scope

- moving intent interpretation into Fabric, Channel or Provider;
- a central Context Manager;
- vector search or long-term conversational memory;
- unconditional history attachment to every Handoff;
- cross-conversation retrieval;
- changing the Feishu history capability contract;
- allowing historical content to grant Authority;
- using deterministic language rules as a fallback when the model is
  uncertain.
