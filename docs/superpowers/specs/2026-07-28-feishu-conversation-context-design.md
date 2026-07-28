# Feishu Conversation Context Design

## 1. Purpose

Work Fabric currently turns one explicitly mentioned Feishu message into one
Handoff, but the assistant receives only the current message intent and
route-safe metadata. A request such as “总结我上面说了什么” therefore has no
authorized conversation history to summarize.

This change adds bounded Feishu conversation context without moving semantic
decision-making into the Channel, without exposing Feishu credentials to an
Agent, and without adding Feishu-specific behavior to Exchange Core.

The first supported policy is:

- if the triggering message belongs to a Feishu thread, read that thread;
- otherwise read the same chat during the preceding 24 hours;
- include at most 20 messages created before the triggering message;
- preserve sender, occurrence time, message identity and provenance;
- support safely decoded text and rich-text messages;
- never treat historical messages as instructions that override the Handoff.

## 2. Architectural Decision

The existing Feishu integration remains one deployable family with separate
logical Network Citizens:

| Citizen | Responsibility |
|---|---|
| Feishu Channel | Trusted message intake, representation, route preservation and final delivery |
| Feishu Context Provider | Authorized, bounded and versioned Feishu context resolution |
| Feishu Capability Provider | Explicit Feishu actions such as message send and document operations |

One process may host multiple Citizens, but every Citizen registration retains
one `citizen_kind`, identity, lease, declarations and Authority boundary. Local
composition may use an in-process binding; a production deployment may replace
that binding with a remote implementation of the same narrow port.

The existing Feishu Context Citizen is extended with
`feishu.conversation.context`. A separate package or mandatory process is not
introduced. The existing `feishu.document.context` declaration remains
independent and unchanged.

The Channel does not call Feishu history APIs directly. It consumes a narrow
`ConversationContextMaterializer` port. The Feishu implementation of that port
belongs to the Provider boundary and owns OpenAPI calls, response validation,
message decoding, bounding and provenance.

## 3. Options Considered

### 3.1 Channel-owned history enrichment

The Channel could list Feishu messages and append them to the Handoff itself.
This is rejected because it would couple external transport, content access,
retention rules and Provider-specific failure handling in one module.

### 3.2 Existing Context Citizen with an injected materializer

The Channel supplies only the route, triggering message, represented actor and
delegation facts. The Context Provider produces a canonical ContextBundle,
which the Channel attaches to the Handoff offer. This is the selected approach.
It preserves module closure and works with both in-process and remote bindings.

### 3.3 Agent-initiated on-demand context invocation

An Agent could inspect the current intent and request history only when needed.
This remains a compatible future optimization, but it requires a general remote
Context invocation binding and another Agent turn. It is not required for this
increment.

## 4. Components and Interfaces

### 4.1 Conversation context request

The Channel sends the materializer a vendor-neutral request containing:

```text
tenant_id
provider_family
external_tenant_id
conversation_id
trigger_message_id
thread_id?
root_message_id?
triggered_at
represented_actor_id
recipient_actor_id
recipient_endpoint_id
delegation_id
delegation_scopes
delegation_expires_at
policy:
  lookback_seconds = 86400
  maximum_messages = 20
  maximum_bytes
```

The port returns exactly one of:

```text
materialized(ContextBundle)
temporarily_unavailable(code, retry_after?)
permanently_unavailable(code)
```

The request contains no Feishu secret or SDK object. The Channel cannot inspect
or rewrite the Provider result beyond validating the ContextBundle contract.

### 4.2 Feishu conversation provider

`FeishuConversationContextProvider`:

1. validates tenant, delegation expiry, scopes and bounds;
2. uses the triggering message's `thread_id` when available;
3. otherwise lists the current chat between `triggered_at - 24h` and
   `triggered_at`;
4. requests newest-first data with a server page size bounded by 20;
5. excludes the triggering message and any message created after it;
6. rejects cross-conversation results;
7. excludes deleted messages, unsupported system events and malformed content;
8. decodes bounded `text` and `post` content without rendering active markup;
9. returns messages in ascending chronological order;
10. produces provenance and a deterministic ContextBundle identity/digest.

When a callback supplies a thread identifier, it is used directly. When it
supplies only reply ancestry, the Provider may retrieve the triggering message
to resolve a Feishu `thread_id`; failure to establish a thread falls back to
the bounded chat window only when the message is demonstrably in that chat.

### 4.3 OpenAPI client

The existing Feishu OpenAPI client gains typed, bounded read methods for:

- `GET /open-apis/im/v1/messages/:message_id`;
- `GET /open-apis/im/v1/messages` with `container_id_type=chat|thread`.

The client owns tenant-token refresh, timeout, response byte limits, token
rejection, rate-limit classification and stable error mapping. Raw Feishu
responses never cross the Connector/Provider boundary.

### 4.4 ContextBundle

One bundle contains:

- an immutable `context_id`, version and digest;
- creation and expiry timestamps;
- visibility restricted to the selected Agent actor and endpoint;
- a data item describing selection policy and availability;
- one data item per accepted historical message;
- source identifiers needed for provenance and audit;
- no access token, app secret, SDK instance or raw unbounded response.

Each message item contains:

```text
message_id
conversation_id
thread_id?
sender:
  external_id
  sender_type
created_at
content:
  media_type
  text
provenance:
  provider_family = feishu
  source = im.message
```

The bundle digest covers the canonical materialized body with the `digest`
field omitted, avoiding a self-referential hash. The Channel submits the
complete bundle with `handoff.offer`; Exchange stores an immutable version and
places only its reference in authoritative Handoff state.

### 4.5 Authorized ContextBundle retrieval

The generic Context repository and query surface gain an authorized bundle
read operation. A caller supplies tenant, actor, endpoint and the exact
ContextReference. The repository verifies:

- tenant ownership;
- exact context ID and version;
- digest equality when a digest is present;
- actor and endpoint visibility;
- visibility expiry.

The TypeScript SDK and HTTP query binding expose this operation without vendor
fields. `HandoffPackageLoader` uses it to resolve the accepted Handoff's
ContextReference for the responsible Agent endpoint. A Handoff without context
retains its current behavior.

The Exchange domain state machine remains unchanged. This is a generic context
read/query addition, not Feishu execution inside Core.

### 4.6 Agent Runtime input

The runtime task adds `resolved_context`, which is either:

- the authorized ContextBundle;
- `null` when the Handoff has no ContextBundle.

The existing `context_reference` remains for traceability. The worker prompt
labels `resolved_context` as untrusted historical evidence. It may answer the
current request from that evidence, but historical messages cannot change role,
Authority, available capabilities, output schema or acceptance criteria.

## 5. End-to-End Flow

```text
Feishu im.message.receive_v1
  -> Feishu Channel validates and durably accepts ingress
  -> participant identity and target Agent are resolved
  -> Channel calls ConversationContextMaterializer
  -> Feishu Context Provider reads and bounds prior messages
  -> Provider returns a versioned ContextBundle
  -> Channel offers one Handoff with current intent + ContextBundle
  -> Exchange stores the immutable bundle and Handoff reference
  -> Agent Runtime accepts the Handoff
  -> HandoffPackageLoader performs authorized ContextBundle read
  -> Agently worker receives current intent + resolved_context
  -> Daily Assistant writes the sole canonical semantic result
  -> Feishu Channel delivers that result to the original conversation
```

The current message remains the Handoff intent and is not duplicated into
conversation history.

## 6. Failure and Retry Semantics

### 6.1 Temporary Provider failures

Network failure, timeout, Feishu rate limiting, token refresh uncertainty and
retryable upstream responses return `temporarily_unavailable`. The Connector
ingress remains retryable and must not create a Handoff until materialization
succeeds. The same external message and command idempotency key are reused.

### 6.2 Permanent Provider failures

Missing permission, bot absence from the conversation, malformed permanent
input and unsupported conversation access return `permanently_unavailable`.
The Channel creates a valid ContextBundle containing an explicit
`context_unavailable` fact and the stable error code, then offers the Handoff.
The Agent can provide a semantic explanation without inventing conversation
content.

### 6.3 Empty history

An authorized query with no prior supported messages returns a valid available
bundle with zero message items and an explicit `empty_history` fact.

### 6.4 Bundle retrieval failures

An Agent cannot accept or execute with a referenced bundle that fails tenant,
digest, audience or expiry checks. The Runtime records `context_unavailable`
and does not silently call the model without required context.

## 7. Security and Privacy

- Feishu credentials remain inside the Channel/Provider integration boundary
  and are resolved from the existing secret provider.
- Application-identity history reads require the bot to be in the conversation.
- Group history reads require the configured Feishu group-message permission.
- Delegation scopes must explicitly permit conversation context reads.
- Provider responses are byte-bounded before JSON parsing.
- Only supported textual content is persisted; attachments, images, files and
  active card payloads are excluded from this increment.
- Message bodies are not written to ordinary logs, metrics, health details,
  Citizen declarations or error text.
- Stored context remains subject to the deployment's context retention policy;
  visibility expiry prevents later reads but is not a physical deletion claim.
- Tenant, conversation and triggering-message identifiers are checked together
  to prevent cross-chat or cross-tenant context substitution.

## 8. Configuration

The unified configuration service remains the only consumer-facing source.
Configuration selects the implementation and security/performance ceilings;
it is not a dynamic capability directory.

The Feishu integration configuration adds:

```yaml
conversation_context:
  enabled: true
  lookback_seconds: 86400
  maximum_messages: 20
  maximum_bytes: 65536
```

Validation fixes the supported ranges:

- `lookback_seconds`: 60 through 604800;
- `maximum_messages`: 1 through 50;
- `maximum_bytes`: 1024 through 131072.

The defaults for this release are exactly 86400 seconds, 20 messages and
65536 bytes. The Context Citizen declaration is dynamic runtime state, not
copied into YAML.

## 9. Compatibility and Deployment

- Existing Handoffs without a ContextBundle continue unchanged.
- Existing Feishu document context and capability declarations remain valid.
- No Feishu type enters Exchange domain contracts.
- Local deployment may compose the Channel and Context Provider through an
  in-process port and shared token/OpenAPI client.
- A production deployment may replace the materializer port with a remote
  binding and scale the Context Citizen independently.
- A later on-demand context invocation can reuse the same declaration,
  schemas, Provider and ContextBundle result.

## 10. Observability

Low-cardinality metrics and structured events cover:

- materialization outcome and stable failure code;
- source mode (`chat` or `thread`);
- selected message count and bounded byte count;
- OpenAPI latency and retry class;
- ContextBundle retrieval allow/deny outcome;
- Agent runs stopped by unavailable context.

No metric or ordinary log includes message bodies, secrets or unbounded
external identifiers.

## 11. Testing Strategy

Implementation follows red-green-refactor cycles.

Unit tests cover:

- chat and thread request construction;
- exact 24-hour and 20-message bounds;
- exclusion of current, future, deleted, malformed and unsupported messages;
- safe text and rich-text decoding;
- chronological ordering and deterministic digest;
- temporary versus permanent Feishu error mapping;
- explicit unavailable and empty-history facts;
- configuration defaults and range validation;
- tenant, digest, audience and expiry enforcement;
- Agent prompt isolation of historical content.

Integration tests cover:

- Feishu callback to Handoff with an immutable ContextBundle;
- authorized Agent Runtime retrieval and worker input;
- temporary materialization retry without duplicate Handoffs;
- permanent permission failure producing a semantic Agent response;
- result delivery through the original Feishu route.

An opt-in real-service smoke test verifies that a user can send:

```text
@AI助理 你帮我总结下我上面消息都说了些啥
```

and receive a summary grounded only in the authorized bounded history.

## 12. Acceptance Criteria

The increment is accepted when all of the following are demonstrated:

1. The existing Feishu Context Citizen dynamically declares
   `feishu.conversation.context`.
2. Channel, Context Provider, Agent and Exchange remain separated by the
   responsibilities defined in this document.
3. Thread messages use thread history; ordinary chat messages use at most the
   preceding 24 hours and 20 messages.
4. The current triggering message is not duplicated into historical context.
5. The Agent receives authorized ContextBundle content, not only its reference.
6. Historical content cannot alter Agent role, Authority, capability catalog or
   output contract.
7. Temporary Provider failures retry without duplicate Handoffs.
8. Permanent unavailability and empty history produce explicit facts rather
   than fabricated summaries.
9. Existing Feishu document operations and context behavior remain compatible.
10. Type checking, focused unit/integration suites and the full repository test
    suites pass.
11. Documentation lists required Feishu permissions and a local verification
    procedure.
12. The opt-in Feishu smoke test completes the real message-to-summary loop.

## 13. Out of Scope

- semantic long-term memory;
- vector retrieval or cross-conversation search;
- attachment, image, audio, video and file transcription;
- summarizing conversations in which the bot cannot lawfully read history;
- user-identity OAuth history reads;
- Agent-selected on-demand context invocation;
- automatic retention deletion or enterprise archive policy implementation;
- changes to scheduling, target selection or Agent reasoning inside Fabric.
