# Provider Facets and Agent-Driven Context Design

## 1. Purpose

Work Fabric connects independently operated people, Agents and systems. It
transfers responsibility and facts; it does not decide what information an
Agent needs and does not become an automation brain.

The current Feishu conversation-context implementation violates that boundary
in one important way: the Feishu Channel synchronously materializes one fixed
history window before offering a Handoff. This makes the Channel choose the
retrieval scope, prevents the Agent from deciding whether more information is
needed, and couples message intake to a Context Provider call.

This change replaces that target architecture with Agent-driven, provider-owned
read capabilities:

- the Channel contributes the current message and a trusted source reference;
- the Agent decides whether information is sufficient;
- the Agent invokes a dynamically declared, read-only provider capability when
  it needs more evidence;
- the provider owns native API access, pagination, structural filtering,
  provenance and native authorization;
- the Agent may request another page after inspecting the returned facts;
- Work Fabric owns declaration discovery, delegated invocation, durable state,
  authority and audit, but no semantic relevance decision.

The design applies equally to Feishu, email, WeCom, Slack, document systems,
issue trackers, code hosts and future information sources.

## 2. Architectural Decisions

### 2.1 No central Context Manager

The system does not introduce a Context Manager, Context Orchestrator or
mandatory Context Query service. Information retrieval remains a capability of
the module that owns access to the source system. The Decision Body remains the
only component that judges relevance and sufficiency.

`ContextBundle` and Context Store remain passive exchange and persistence
primitives. They may hold an immutable snapshot or large result that was
actually used, but they do not select providers, fetch pages or decide when
retrieval is complete.

### 2.2 Integration is a virtual grouping

`Feishu Integration` is a documentation namespace and composition view. It is
not a runtime, Citizen, state owner, credential owner or mandatory dependency.

The Feishu family consists of independent feature modules:

| Module | Network responsibility |
|---|---|
| Feishu Channel | Receive Feishu events and deliver canonical results |
| Feishu Message Provider | Read Feishu messages and conversation history |
| Feishu Document Provider | Create, read, update, append and delete documents |
| Feishu Directory Provider | Resolve Feishu identity and organization evidence |
| Feishu Connector | Shared low-level OpenAPI, token and error-mapping library |

Feature modules may share the Connector library. They must not depend on each
other. An optional composition root may run several modules in one process,
but co-location does not merge their Citizen identity, lease, Authority,
health, concurrency or state.

### 2.3 Capability includes read-only abilities

A Capability means “what a module can do”; it does not imply an external side
effect. Capability declarations distinguish operational semantics:

| Operation kind | Meaning |
|---|---|
| `query` | Read-only; no external state change |
| `command` | Changes external state |
| `destructive` | Deletes data or performs another irreversible change |

Conversation-history reads are `query` capabilities with low risk and no
confirmation. Document creation and update are `command` capabilities.
Document deletion is `destructive`.

The first implementation encodes this value as
`constraints.operation_kind` in the existing Citizen declaration contract.
This avoids a breaking WFPP/Citizen schema change. Existing declarations that
omit it are interpreted as `command`; destructive risk and confirmation rules
continue to take precedence. Runtime disclosure includes the normalized value
so the Decision Body and Host can apply query-specific budgets without
inspecting provider-family identifiers.

This distinction avoids inventing a separate Context role solely to make a
read operation callable by an Agent.

### 2.4 Channel and source provider are independent

The system that transports a request need not be the system that provides or
stores the work resources. For example:

```text
Email Channel
  -> Agent reads email thread history
  -> Agent creates a Feishu document
  -> Agent creates an issue in another system
  -> Email Channel delivers the final result
```

The Feishu Channel may be disabled while Feishu Document Provider remains
enabled. Likewise, Feishu Message Provider may be disabled when the deployment
uses Feishu only for documents.

## 3. Options Considered

### 3.1 Keep synchronous Channel enrichment

The Channel could continue reading a fixed history window before every
Handoff. This is rejected because it adds latency and failure coupling to
ingress, retrieves data even when the request is self-contained, and prevents
the Agent from requesting more than one fixed page.

### 3.2 Add a central Context Query role

A new Context service could select providers and manage progressive retrieval.
This is rejected because relevance and sufficiency would move away from the
Decision Body, while source access would move away from the provider that owns
the native API. The result would be a coupled, low-cohesion intermediary.

### 3.3 Provider-owned read capability

Each source provider dynamically declares bounded read capabilities. The Agent
invokes them through the existing capability protocol and decides whether to
continue. This is selected because it preserves module closure, reuses the
network's discovery and Handoff invocation mechanics, and allows arbitrary
cross-system composition without changing Exchange Core.

## 4. Module and Dependency Boundaries

The target dependency graph is:

```text
plugin-channel-feishu -----------+
provider-feishu-message ---------+--> connector-feishu
provider-feishu-document --------+
adapter-directory-feishu --------+

agent-runtime-host --> agent-runtime-spi
agent-capability-runtime --> network-citizen-spi + public SDK

Exchange Core has no Feishu dependency.
```

The following dependencies are forbidden:

- Channel to Message Provider;
- Channel to Document Provider;
- Message Provider to Channel;
- Document Provider to Channel;
- one provider facet to another provider facet;
- Agent Runtime to a Feishu SDK or Feishu credential;
- Exchange Core to a provider-family contract.

In the first implementation, message and document provider code may remain in
one npm workspace package if their internal imports and runtime registrations
remain independent. Physical package splitting is required only when separate
versioning or deployment ownership provides concrete value. Architectural and
Citizen boundaries apply immediately.

## 5. Trusted Source References

Every inbound Channel constructs a provider-neutral `SourceReference` from
trusted transport data:

```text
resource_uri
provider_family
resource_kind
external_tenant_id
occurred_at
extensions
```

Examples:

```text
feishu://tenant/<tenant>/chat/<chat>/message/<message>
email://tenant/<tenant>/thread/<thread>/message/<message>
wecom://tenant/<tenant>/conversation/<conversation>/message/<message>
```

The reference is stored in the original Handoff's `WorkReference` and is not
constructed from model output. Provider-specific transport identifiers remain
inside the URI or bounded extensions.

`current_conversation` is a convenience selector in a read capability. The
Agent Runtime resolves it to the original Handoff's trusted SourceReference.
The model cannot replace the tenant, conversation or triggering-message
identity. A Feishu message provider rejects non-Feishu source references.

Cross-system operations use explicit resource references. For example, an
email request containing an authorized Feishu document URL may lead to a
`feishu.document.read` request for the normalized Feishu document URI. It does
not reinterpret the email conversation as a Feishu conversation.

## 6. Feishu Message Query Capability

The Feishu Message Provider dynamically declares:

```text
feishu.conversation.history.read
```

Its input contract contains:

```text
conversation:
  kind: current_conversation | resource_reference
  resource_uri?: explicit authorized URI
cursor?: opaque continuation cursor
maximum_messages
```

The first release supports `current_conversation` for a Feishu-origin Handoff.
An explicit resource reference is accepted only when it is already present in
the original Handoff authority scope or was returned as a typed, authorized
fact by another provider invocation.

Its output contract contains:

```text
messages[]
has_more
next_cursor?
coverage:
  newest_at?
  oldest_at?
provenance:
  provider_family
  source
  source_reference
```

Every returned message preserves message identity, sender identity/type,
occurrence time, supported textual content, edit/delete status and provenance.
The provider excludes the triggering message, future messages, deleted
messages, cross-conversation results, malformed content and unsupported active
payloads.

The result is typed untrusted evidence. It cannot alter the Agent role,
Authority, capability catalog, acceptance criteria or output contract.

## 7. Pagination and Cursor Semantics

Feishu native `has_more` and `page_token` are preserved by the Connector
boundary. They are not discarded or inferred from the number of decoded
messages.

The Provider returns an opaque continuation cursor. The cursor is bound to:

- tenant and provider family;
- source conversation;
- triggering-message upper bound;
- retrieval direction;
- represented actor and delegation boundary;
- provider snapshot or native cursor;
- expiry.

The Agent cannot inspect or edit the cursor. Each continuation request repeats
Authority checks. A cursor cannot be moved to another conversation, tenant,
Handoff or represented actor.

The Provider performs structural filtering only. It does not decide which
topic is relevant and does not summarize results. When a native page contains
only unsupported or filtered records but `has_more` is true, the Provider may
advance through a bounded number of native pages to produce one useful logical
page. It must still return accurate coverage and continuation state.

## 8. Agent-Driven Retrieval Loop

The Agent Runtime gives the Decision Body:

- the current Handoff intent;
- trusted SourceReference metadata;
- dynamically disclosed capabilities and schemas;
- accumulated results from capability invocations performed during this run.

The Decision Body may:

1. return a final result without reading history;
2. request the first conversation-history page;
3. inspect that page and return a final result;
4. request another page with the returned cursor;
5. invoke a different provider capability using an authorized resource
   reference;
6. ask the user for clarification when authorized evidence remains
   insufficient.

The Runtime keeps a bounded invocation transcript for the current Handoff so a
later model turn can see all prior pages, not only the most recent
continuation. Runtime state is execution recovery state, not long-term memory.

Read and write calls use the same generic capability-discovery and invocation
protocol but retain different operation semantics, limits and confirmation
rules. Runtime policy enforces:

- allowed namespaces;
- maximum total invocations;
- maximum query invocations;
- maximum cumulative query result bytes;
- per-call and whole-run deadlines;
- duplicate invocation prevention;
- authority narrowing from the original Handoff.

The Agent alone authors the final user-facing result.

## 9. Authority and Identity

The original Channel authenticates the external participant and establishes
the Work Fabric Actor represented by the Handoff. A later provider invocation
derives a narrower delegation from that accepted Handoff.

For a conversation-history read:

- the represented actor cannot be replaced by model input;
- the source resource must be covered by the original authority;
- the Provider validates native application/user access;
- the Provider applies the original expiry and any stricter local ceiling;
- returned facts retain their provenance and visibility.

Provider application identity is a deployment mechanism, not a grant to every
Agent. A deployment that temporarily uses application-wide Feishu access still
passes represented-actor and delegation evidence so a future Identity Broker
can enforce end-user document or message access without changing capability
contracts.

## 10. Configuration and Composition

Feature enablement is independent:

```yaml
integrations:
  feishu:
    channel:
      enabled: true
      credential_ref: feishu-channel

    capabilities:
      message_history:
        enabled: true
        credential_ref: feishu-message-reader
      documents:
        enabled: true
        credential_ref: feishu-documents

    directory:
      enabled: true
      credential_ref: feishu-directory
```

The exact YAML shape may be adapted to the existing configuration schema
during implementation. The architectural requirement is that the
Configuration Provider exposes independent facet configuration. Consumers do
not read YAML directly, and a database or remote configuration source may
replace YAML without changing module interfaces.

Credential references may point to the same Feishu application for local
development. Production deployments may use separate applications and least
privilege scopes. Disabling one facet does not prevent another from starting.

An optional all-in-one local composition starts several Citizens in one
process. Production may split Channel, Message Provider, Document Provider and
Directory Provider into separate processes without changing declarations or
Agent behavior.

## 11. Compatibility and Migration

The target path removes the Channel's synchronous dependency on
`ConversationContextMaterializer`.

Migration proceeds as follows:

1. preserve Feishu pagination metadata in the Connector;
2. declare and execute `feishu.conversation.history.read` as a query
   capability;
3. extend the Agent continuation protocol to retain a bounded invocation
   transcript and allow multiple query calls;
4. include a trusted SourceReference in Feishu intake Handoffs;
5. switch the local Feishu assistant composition to Agent-driven retrieval;
6. retain the old one-shot materializer only as a deprecated bootstrap
   compatibility adapter for existing configuration;
7. remove the Channel-to-materializer dependency after the compatibility
   window.

The compatibility adapter may fetch one bounded initial page, but it is not
permitted to perform semantic selection or progressive retrieval. New
deployments use Agent-driven retrieval.

The existing generic Context Store read API remains compatible. Existing
Handoffs that already contain a ContextBundle continue to resolve it.

## 12. Failure Semantics

- Channel ingress succeeds or retries independently of history-query
  availability.
- Query failure is returned as a typed invocation result to the Agent.
- Retryable provider failures retain stable invocation identity and do not
  duplicate Handoffs or final replies.
- Invalid, expired or cross-resource cursors fail closed.
- Native permission denial is not silently replaced by application-wide
  access.
- Empty history is a successful typed result with zero messages and accurate
  continuation state.
- Exhausted query budgets are explicit to the Agent, which may answer from
  available evidence or request user clarification.
- A failed history query never makes the Feishu Channel unavailable.

## 13. Performance and Scalability

Channel and query work use independent concurrency pools and rate-limit
budgets. Long history reads cannot block durable event acceptance.

The local composition may share an OpenAPI client and token cache, but shared
infrastructure must not create shared feature state. Production deployments
can scale message-query workers independently from Channel workers.

Provider responses are bounded by page count, decoded message count, response
bytes and deadline. Work Fabric persists invocation state and typed terminal
facts; it does not copy complete provider histories into core state by default.
Large results may be stored as immutable Context/Artifact references.

Cursor-based retrieval avoids offset scans and permits provider-native
pagination. Broker or cache acceleration may be introduced behind the Provider
port without changing capability contracts.

## 14. Observability

Each facet reports independent health and low-cardinality telemetry:

- Channel ingress/delivery outcome;
- query invocation outcome and stable error class;
- native pages visited and logical messages returned;
- `has_more` result and cumulative bytes;
- rate-limit, timeout and cursor rejection counts;
- Agent query-loop count and budget exhaustion;
- capability Citizen lease and availability.

Message bodies, credentials, raw access tokens and unbounded external
identifiers are excluded from ordinary logs and metrics.

## 15. Testing Strategy

Implementation follows red-green-refactor cycles.

Unit tests cover:

- SourceReference construction and provider-family validation;
- query capability declaration and operation semantics;
- native `has_more` and `page_token` preservation;
- opaque cursor binding, expiry and substitution rejection;
- current/future/deleted/cross-conversation filtering;
- empty and filtered-page behavior;
- Agent transcript accumulation across two or more query calls;
- separate query invocation/byte budgets;
- independent facet configuration and startup;
- Channel behavior when Message Provider is disabled or unavailable.

Integration tests cover:

- Feishu Channel to Handoff without synchronous history materialization;
- Agent first-page query followed by a second-page query;
- mixed-topic evidence where only the Agent selects relevant content;
- email-origin Handoff followed by Feishu document creation with Feishu Channel
  disabled;
- Feishu Channel enabled with Document Provider disabled;
- provider retry and recovery without duplicate final replies;
- existing ContextBundle Handoff compatibility.

An opt-in real-service smoke test verifies:

1. the user sends a Feishu message referring to earlier content;
2. the Agent invokes Feishu history read;
3. the Agent requests another page only when needed;
4. the Agent sends one semantic reply through the original Channel;
5. no Handoff IDs, cursor values or internal state messages appear in chat.

## 16. Acceptance Criteria

The change is accepted when:

1. no mandatory Context Manager or Context Orchestrator is introduced;
2. `Feishu Integration` exists only as a grouping/composition concept;
3. Channel, Message Provider, Document Provider and Directory Provider can be
   independently enabled and registered;
4. no feature module imports another feature module;
5. Feishu Channel offers a trusted SourceReference and does not synchronously
   fetch history in the Agent-driven mode;
6. Feishu Message Provider dynamically declares a read-only conversation
   history capability;
7. native pagination state is preserved and continuation cursors are opaque
   and authority-bound;
8. the Agent can make multiple bounded history calls and receives the complete
   current-run invocation transcript;
9. relevance, sufficiency and final wording remain exclusively Agent-owned;
10. email/WeCom Channels can use Feishu document capabilities without Feishu
    Channel or Message Provider;
11. existing ContextBundle reads and explicitly configured bootstrap behavior
    remain compatible during migration;
12. focused, integration and full repository verification pass.

## 17. Superseded Decisions

This document supersedes the following target-architecture decisions in
`2026-07-28-feishu-conversation-context-design.md`:

- synchronous Channel-owned invocation of `ConversationContextMaterializer` as
  the primary path;
- fixed one-page materialization as the final conversation-context model;
- deferral of Agent-initiated on-demand retrieval.

The previous implementation remains documented as migration history and a
temporary compatibility path. Its security requirements for provenance,
audience, digest, bounded decoding and untrusted evidence remain applicable.

## 18. Out of Scope

- semantic long-term memory;
- a central retrieval planner;
- vector search or provider-independent relevance ranking;
- copying all external messages into Work Fabric;
- attachment transcription;
- user OAuth implementation;
- automatic target selection or scheduling inside Fabric Core;
- changing Handoff responsibility semantics;
- forcing each provider facet into a separate production process.
