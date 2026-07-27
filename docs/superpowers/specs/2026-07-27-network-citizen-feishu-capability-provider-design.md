# Work Fabric Network Citizens and Feishu Capability Provider Design

**Status:** Design complete, awaiting written-spec review
**Date:** 2026-07-27

## 1. Purpose

Work Fabric is a collaboration exchange for humans, Agents and connected
systems. It connects participants, transfers responsibility, exposes durable
state and carries results. It is not an Agent brain, an external-system tool
runner or an automation workflow engine.

This design establishes a technology-neutral **Network Citizen** model for
modules that attach to Work Fabric, then uses that model to add a Feishu
Capability Provider. The Provider lets the Daily Assistant request bounded
Feishu message and document operations without importing Feishu into Exchange
Core or giving the Agent Feishu credentials.

The first release supports:

- sending one text message to the current conversation or one explicitly
  authorized user/chat target;
- creating a simple Feishu Docx document;
- reading a bounded authorized Docx document;
- replacing the managed simple content of a document;
- appending simple content to a document;
- deleting a document created and owned by the same tenant's Provider, after
  explicit user confirmation.

## 2. Architectural invariants

The following requirements are project-wide and mandatory:

1. Work Fabric Core handles connection, discovery, Authority, Handoff,
   responsibility, state, events, Result and audit. It does not choose tools,
   call Feishu or execute Agent reasoning.
2. Work is executed by an external network participant. The framework only
   carries the assignment and its observable lifecycle.
3. Every module closes its own responsibilities. A channel does not become an
   Agent tool, an Agent Runtime does not become a Feishu adapter, and a
   Capability Provider does not become a decision brain.
4. Core depends on public protocols and SPIs, never on YAML, Feishu, Agently,
   MCP or a concrete storage engine.
5. Runtime capability declarations are dynamic facts. Configuration enables a
   trusted module and sets safety ceilings; it does not enumerate the module's
   live capabilities.
6. Declaring a capability never grants Authority to execute it.
7. Human-visible language is produced by the responsible decision body. A
   Capability Provider returns typed facts and stable errors, not conversational
   copy.
8. Secrets remain in the Provider's Credential Provider. They never enter a
   Handoff, Result, Manifest, event, Console payload or log.
9. Ordinary assistant replies continue through the Channel's canonical Result
   delivery path. The Agent requests `feishu.message.send` only when the user
   explicitly asks it to send an additional notification or message.

## 3. Scope and non-scope

### 3.1 Included

- Network Citizen classification and project-level conformance rules.
- A dynamic Citizen Catalog with progressive disclosure.
- Language-neutral Citizen descriptors and TypeScript reference SPIs.
- Leased software-Citizen runtime foundations and Factory registration.
- Dynamic, versioned Capability Contracts with immutable Schema digests.
- An Agent Runtime capability-invocation port and bounded two-phase Agently
  decision loop.
- An external Feishu Capability Provider using application identity
  (`tenant_access_token`).
- A separate Feishu document Context Provider Citizen backed by the same
  internal OpenAPI backend.
- Message send and simple document CRUD/append contracts.
- Durable Provider execution state, resource ownership and confirmation
  challenge state behind replaceable storage SPIs.
- Authority, confirmation, idempotency, restart recovery, observability,
  documentation and end-to-end tests.

### 3.2 Excluded

- Calendar, task, approval, spreadsheet, Bitable and Wiki mutation abilities.
- Batch messaging, recipient search, inferred recipients or unrestricted
  broadcast.
- Images, embedded files, tables, tasks, calendars, Bitable blocks or arbitrary
  Docx block trees.
- User OAuth and `user_access_token`.
- Agent access to App ID, App Secret or tenant tokens.
- Direct Agent-to-Feishu SDK calls.
- Direct Agent-to-MCP calls that bypass Work Fabric.
- Replacing a Handoff responsibility transfer with an internal workflow
  engine.
- Treating SQLite, PostgreSQL, YAML, HTTP, SSE, NATS, SDKs or caches as network
  citizens.

## 4. Network Citizen model

### 4.1 Orthogonal identity dimensions

Actor type and Citizen kind answer different questions:

```text
Actor type:
  human | agent | system
  "Who collaborates?"

Citizen kind:
  decision-body | capability-provider | channel | context-provider |
  governance-provider | observer
  "What responsibility does this network-facing module or participant have?"
```

Examples:

| Entity | Actor type | Citizen kind |
|---|---|---|
| Feishu employee | `human` | `decision-body` |
| Daily Assistant | `agent` | `decision-body` |
| Feishu action executor | `system` | `capability-provider` |
| Feishu collaboration adapter | none as a business recipient | `channel` |
| Feishu document context resolver | `system` service identity | `context-provider` |
| Confirmation/Authority service | `system` service identity | `governance-provider` |
| Console or audit exporter | `system` service identity | `observer` |

A software package or process may host multiple Citizen registrations. One
registration has exactly one `citizen_kind`. A combined Feishu process may
therefore share token acquisition internally while exposing:

```text
feishu-document-actions  -> capability-provider
feishu-document-context  -> context-provider
```

The registrations remain independently authorized, leased, disabled, scaled
and audited.

### 4.2 Citizen kinds

#### Decision body

A human, Agent or external scheduling brain that may choose, delegate, request
capabilities and interpret results. A software decision body uses an Actor and
Endpoint. A human is represented through an authorized Channel and does not
implement software lifecycle methods.

#### Capability Provider

A deterministic task-responsible participant that declares executable
Capability Contracts, claims or accepts a matching Handoff, performs work
outside Core and returns a typed Result.

#### Channel

An ingress/egress boundary for an external communication system. It verifies
transport trust, performs Admission and representation, creates authorized
Handoffs, and delivers canonical events/results. It does not understand user
intent and cannot become responsible for business work.

#### Context Provider

An authorized, version-aware source of bounded context or resource content. It
does not accept responsibility for the consuming Handoff. Reads may also be
exposed as explicit capabilities, but contextual access retains separate
provenance, freshness and Authority semantics.

#### Governance Provider

A fail-closed provider for Identity, Admission, Authority, delegation,
confirmation or policy evidence. It does not produce business work results.

#### Observer

A read-only subscriber such as Console, audit export, metrics or event
integration. It cannot mutate Handoffs or represent another participant.

### 4.3 Classification rules

- A component that chooses an executor is a decision body. A purely mechanical
  deterministic router remains infrastructure and does not introduce a new
  Citizen kind.
- An Agent that both decides and performs work remains a decision body and
  declares its executable abilities through Capability Contracts.
- A database, transport, SDK or cache is an implementation dependency, not a
  Citizen.
- A new network-facing module must document its Citizen kind, identity,
  declarations, Authority boundary and responsibility closure before merge.

## 5. Citizen descriptors and progressive disclosure

### 5.1 Base descriptor

The language-neutral descriptor is JSON-compatible:

```ts
type NetworkCitizenKind =
  | "decision-body"
  | "capability-provider"
  | "channel"
  | "context-provider"
  | "governance-provider"
  | "observer";

interface NetworkCitizenDescriptor {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly version: string;
  readonly identity: CitizenIdentity | null;
  readonly protocol: CitizenProtocolSupport;
  readonly declarations: CitizenDeclarations;
  readonly availability: CitizenAvailability;
  readonly extensions: JsonObject;
}
```

Descriptors never contain credentials, internal storage locations, private
network URLs, executable paths or SDK-specific types.

### 5.2 Progressive disclosure

The Catalog exposes four authorized levels:

1. Citizen list: ID, kind, version and aggregate availability.
2. Citizen detail: identity binding, protocol support and declaration
   summaries.
3. Declaration list: Capability/Context/Channel/Policy summary contracts.
4. Declaration detail: complete Schema references, constraints, risk,
   confirmation, idempotency and Authority requirements.

The public routes are:

```text
GET /v1/citizens
GET /v1/citizens/:citizen_id
GET /v1/citizens/:citizen_id/declarations
GET /v1/citizens/:citizen_id/declarations/:declaration_id
```

List/detail operations are separately authorized. A caller that can discover a
summary is not automatically allowed to read a full sensitive contract or
invoke it.

## 6. Dynamic registration and availability

### 6.1 Configuration is bootstrap, not runtime truth

Configuration contains only trusted deployment inputs:

```yaml
citizens:
  instances:
    feishu-primary:
      type: capability-provider.feishu
      enabled: true
      config:
        credential_ref: feishu-primary
        backend: openapi
        governance_policy_ref: external-actions-default
        runtime_state:
          provider: sqlite
          location: ./var/feishu-capability-runtime.db
        resource_ownership:
          provider: sqlite
          location: ./var/feishu-resource-ownership.db
```

It does not enumerate `feishu.document.create` or other live abilities.

### 6.2 Trust provisioning

An administrative provisioning record binds:

- `citizen_id`;
- allowed `citizen_kind`;
- authenticating `principal_id`;
- allowed Actor/Endpoint binding when the Citizen is task-responsible;
- allowed declaration namespaces;
- maximum risk class;
- Governance policy reference;
- administrative state and registration revision.

Provisioning establishes what the workload may register. It does not state
what the workload currently provides.

### 6.3 Software-Citizen sessions

A software Citizen opens a leased session with its current descriptor and
declarations. The server binds the authenticated Principal and refuses
identity claims outside the provisioning record.

```text
POST /v1/citizens/:citizen_id/sessions
POST /v1/citizens/:citizen_id/sessions/:session_id/heartbeat
PUT  /v1/citizens/:citizen_id/sessions/:session_id/declarations
POST /v1/citizens/:citizen_id/sessions/:session_id/close
```

The session carries a monotonic fencing token. Declaration replacement uses:

- `expected_registration_version`;
- the session fencing token;
- a canonical descriptor digest;
- a strictly increasing registration version.

Heartbeat refreshes availability and the last declared digest. Declaration
updates use the dedicated CAS operation rather than hiding large dynamic
updates inside heartbeat.

### 6.4 Declaration validation

The Catalog validates:

- bounded canonical IDs and semantic versions;
- supported protocol and interaction modes;
- immutable Schema URI plus `sha256` digest pairs;
- bounded media types, fields, constraints, depth and total bytes;
- declaration count per Citizen;
- risk and confirmation values;
- provisioned namespace and maximum risk;
- Actor/Endpoint identity consistency;
- registration revision, session and fencing token.

The same Schema URI/version cannot be rebound to different bytes. The Schema
registry stores or resolves immutable content by digest.

### 6.5 Availability lifecycle

```text
declared -> validated -> available -> degraded -> draining
         -> unavailable -> expired
```

- `draining` prevents new Handoffs but permits already claimed work to finish.
- Session expiry removes declarations from eligible discovery.
- Administrative disable immediately prevents new work and causes active
  executions to follow their configured cancellation/recovery policy.
- Dynamic declaration does not modify Authority grants.

### 6.6 Binding at claim/accept

Discovery is not an execution guarantee. When a Capability Handoff is claimed
or resolved, the binding freezes:

```json
{
  "citizen_id": "feishu-document-actions",
  "endpoint_id": "endpoint-feishu-capability-provider",
  "capability_id": "feishu.document.create",
  "capability_version": "1.0.0",
  "contract_digest": "sha256:...",
  "fencing_token": 8
}
```

The Provider must execute against this exact contract. A later declaration
update cannot change an in-flight Handoff.

## 7. Reference SPIs and base runtimes

### 7.1 Runtime-neutral contracts

`network-citizen-spi` contains only:

- descriptor and classification types;
- declaration contracts;
- Catalog, session and storage ports;
- `NetworkCitizenFactory`;
- per-kind SPIs;
- validation helpers for wire-level data.

It has no YAML, HTTP, storage or vendor dependencies.

### 7.2 Software runtime

```ts
interface NetworkCitizenRuntime {
  readonly descriptor: NetworkCitizenDescriptor;
  start(context: CitizenRuntimeContext): Promise<void>;
  health(): Promise<CitizenHealth>;
  close(): Promise<void>;
}

abstract class LeasedNetworkCitizenRuntime
  implements NetworkCitizenRuntime {
  // registration, session, heartbeat, lease, fencing,
  // declaration CAS, health, configuration revision and shutdown
}
```

This base class is optional convenience for TypeScript implementations. The
wire protocol remains the real base contract, so Python, Java and remote
services remain first-class.

### 7.3 Capability runtime

```ts
interface CapabilityExecutor {
  describeCapabilities(): readonly CapabilityContract[];
  execute(
    request: CapabilityExecutionRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult>;
}

abstract class CapabilityProviderRuntime
  extends LeasedNetworkCitizenRuntime {
  // Delivery persistence, dedupe, contract validation, Authority evidence,
  // confirmation, Accept, Status, execution, Result and restart recovery
}
```

The base runtime closes protocol and reliability responsibilities. A vendor
executor implements only its bounded external operations.

### 7.4 Factory registration

```ts
interface NetworkCitizenFactory<TConfig = unknown> {
  readonly type: string;
  readonly citizen_kind: NetworkCitizenKind;
  validate(config: unknown): TConfig;
  create(
    config: TConfig,
    context: CitizenFactoryContext,
  ): Promise<NetworkCitizenRuntime>;
}
```

The composition root uses a registry keyed by trusted stable type. Core must
not contain vendor-specific type switches. Backends are injected through
composition, not by overriding security-sensitive runtime methods.

## 8. Feishu Citizen topology

The deployment registers:

```text
Citizen: daily-assistant
  kind: decision-body
  Actor: actor-intake-agent (agent)

Citizen: feishu-primary-channel
  kind: channel

Citizen: feishu-document-actions
  kind: capability-provider
  Actor: actor-feishu-capability-provider (system)
  Endpoint: endpoint-feishu-capability-provider

Citizen: feishu-document-context
  kind: context-provider

Citizen: external-actions-governance
  kind: governance-provider
```

The existing Feishu Channel remains responsible only for ingress, Admission,
representation and result delivery. It does not expose its SignalAdapter as an
Agent tool.

## 9. Agent capability-invocation loop

### 9.1 Responsibility model

The Daily Assistant remains responsible for the original Handoff while it
requests a Feishu ability. It must not use Handoff `transfer`, because transfer
relinquishes parent responsibility.

The Assistant creates an auxiliary Capability Handoff in the same thread:

```text
Original Handoff (Daily Assistant remains responsible)
  -> auxiliary Capability Handoff
  -> Provider Result
  -> Assistant resumes
  -> original Handoff Result
```

The auxiliary Handoff is correlated by `thread_id`, `correlation_id`,
`causation_id` and `invocation_id`. Its work reference uses a stable
Work-Fabric URI derived from the original Handoff and invocation ID. It is not
a responsibility-transfer child.

### 9.2 Agent Runtime port

```ts
interface CapabilityInvocationPort {
  discover(
    requirement: CapabilityRequirement,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]>;

  invoke(
    request: CapabilityInvocationRequest,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationResult>;
}
```

The implementation:

1. queries the dynamic Catalog;
2. loads the authorized complete contract;
3. validates the model-produced input;
4. requests a down-scoped invocation grant from the Governance Provider;
5. offers a capability-targeted Handoff through the public SDK;
6. waits on a dedicated canonical Subscription;
7. validates the returned Result against the bound contract;
8. returns normalized facts to the Agent Driver.

### 9.3 Agently worker protocol

The Agently worker protocol gains a versioned decision union:

```ts
type AssistantTurn =
  | {
      kind: "final";
      response: AssistantFinalResponse;
    }
  | {
      kind: "capability_request";
      request: {
        capability_id: string;
        version_constraint: string;
        input: JsonObject;
        reason: string;
      };
    };
```

The TypeScript Driver, not the Python worker, owns network invocation. After a
Capability Result it starts a bounded continuation turn with the original task,
the request and the normalized Result. No Feishu credential enters Python.

Limits:

- at most four capability invocations per original Handoff;
- sequential invocations only;
- a deadline bounded by the original Handoff;
- cancellation propagates to waits and active local execution;
- the Agent cannot invoke a capability absent from its granted namespace;
- a Provider Result is data, never an instruction to run arbitrary code.

The final user-facing response remains solely Agent-authored.

## 10. Delegation and confirmation

The Channel does not infer permissions from natural language. The original
Intake Handoff carries a Governance-issued scope that permits the Daily
Assistant to request down-scoped capability grants. The Governance Provider
evaluates each normalized invocation using:

- tenant and initiating Human Actor;
- original Handoff and immutable message reference;
- requested capability and bound contract risk;
- normalized input digest;
- explicit target/resource;
- deployment policy;
- confirmation evidence when required.

The invocation grant is narrower than the original scope and is bound to the
auxiliary Handoff idempotency tuple.

### 10.1 Delete confirmation

Delete uses a two-message deterministic challenge:

1. A delete request without confirmation receives
   `confirmation_required` and a bounded opaque challenge code.
2. The Assistant tells the same Human Actor to send the exact confirmation
   phrase containing that code.
3. A later Feishu Intake Handoff carries the raw message reference and same
   Human Actor.
4. The Governance Provider consumes the pending challenge and issues a
   single-use confirmation proof reference.
5. The Provider resolves and atomically consumes that proof through the
   Governance boundary before calling Feishu delete.

The confirmation proof binds:

```text
tenant_id
human_actor_id
capability_id
document_token
normalized_input_digest
challenge_id
expires_at
```

It cannot be reused across Actors, documents, operations or input changes.
The proof is an opaque, non-secret reference rather than a bearer credential.
The signed or otherwise authoritative confirmation evidence remains inside the
Governance Provider and is never serialized into a Handoff.

## 11. Capability Contracts

All inputs reject unknown fields and unsafe accessor/prototype values at trust
boundaries. Strings, arrays, content bytes and nested depth are bounded.

### 11.1 `feishu.message.send`

Input:

```ts
{
  target:
    | { kind: "current_conversation" }
    | { kind: "open_id"; id: string }
    | { kind: "chat_id"; id: string };
  content: { media_type: "text/plain"; text: string };
}
```

Output:

```ts
{
  message_id: string;
  target: JsonObject;
  sent_at: string;
}
```

One invocation sends one message to one target. `current_conversation` resolves
only from the trusted original Channel route. Explicit targets must appear in
the invocation grant. Recipient search and batch delivery are unsupported.
This capability is not used for the ordinary final reply to the Handoff that
triggered the Assistant. That reply remains a canonical Agent Result delivered
by the Channel, preventing duplicate messages and keeping response authorship
with the decision body.

### 11.2 `feishu.document.create`

Input:

```ts
{
  title: string;
  content: SimpleDocumentContent;
  folder_token?: string;
}
```

Output:

```ts
{
  document_token: string;
  url: string;
  title: string;
  revision: string;
}
```

Create persists a Resource Ownership record before returning success. The same
idempotency tuple must resolve to the same document.

### 11.3 `feishu.document.read`

Input:

```ts
{
  document: { kind: "docx"; token: string };
  max_bytes: number;
}
```

Output:

```ts
{
  document_token: string;
  title: string;
  content: SimpleDocumentContent;
  revision: string;
  provenance: JsonObject;
}
```

The application identity must have access to the existing document. Content is
bounded by both the contract and request maximum.

### 11.4 `feishu.document.update`

Input:

```ts
{
  document: { kind: "docx"; token: string };
  expected_revision: string;
  title?: string;
  content: SimpleDocumentContent;
}
```

The operation replaces the complete document body only when the current body
is representable without loss by `SimpleDocumentContent`. This applies to both
Provider-created and explicitly authorized existing documents. A document with
unsupported blocks returns `unsupported_document_shape` before any write.
Revision mismatch returns a conflict and does not overwrite concurrent edits.

### 11.5 `feishu.document.append`

Input:

```ts
{
  document: { kind: "docx"; token: string };
  expected_revision: string;
  content: SimpleDocumentContent;
}
```

The operation appends at the document end and returns the new revision. It does
not mutate existing blocks. The existing document must be readable and its
structure must permit a lossless append through the supported simple-content
mapping; otherwise the Provider returns `unsupported_document_shape`.

### 11.6 `feishu.document.delete`

Input:

```ts
{
  document: { kind: "docx"; token: string };
  expected_revision: string;
  confirmation_proof: string;
}
```

The Provider checks current revision, ownership and confirmation before
deletion. Only a document created by the same Provider Citizen for the same
Work Fabric tenant is deletable in this release.

### 11.7 Simple document content

```ts
{
  media_type: "text/plain" | "text/markdown";
  text: string;
}
```

The supported Markdown subset is:

- paragraphs and line breaks;
- headings levels one through three;
- ordered and unordered lists;
- ordinary links.

Tables, images, files, embedded task/calendar/Bitable blocks and raw arbitrary
Docx blocks are rejected. Unsupported syntax is never silently discarded.

## 12. Provider internals

### 12.1 Component boundaries

```text
CapabilityProviderRuntime
  -> FeishuCapabilityExecutor
       -> FeishuCapabilityBackend
            -> OpenAPI backend (first release)
            -> MCP backend (future, same public contracts)

  -> CapabilityRuntimeStateStore
  -> FeishuResourceOwnershipStore
  -> ConfirmationVerifier
  -> CredentialProvider
```

The existing low-level tenant-token and bounded HTTP components may be reused.
The event-oriented `FeishuSignalAdapter` is not reused as the Agent-facing
capability boundary.

### 12.2 Storage separation

`CapabilityRuntimeStateStore` contains Delivery receipts, execution leases,
idempotency, normalized input digests, external-call phase and durable Results.

`FeishuResourceOwnershipStore` contains:

- Work Fabric tenant;
- document token;
- creating Citizen and Endpoint;
- initiating Handoff and Actor;
- create idempotency tuple;
- created timestamp;
- last known revision;
- deletion timestamp or null.

`ConfirmationStore` contains challenge state and the internal single-use
confirmation evidence addressed by a non-secret proof reference.

Each has Memory and SQLite implementations in the first release and a
technology-neutral SPI. PostgreSQL or a remote service can replace them
without changing the Provider or contracts.

## 13. Failure and idempotency model

### 13.1 Typed outcomes

After the Provider accepts responsibility, every terminal execution produces a
typed Result:

```ts
type CapabilityOutcome =
  | { outcome: "succeeded"; data: JsonObject; artifacts: readonly JsonObject[] }
  | { outcome: "rejected"; code: string; message: string; retryable: false }
  | {
      outcome: "failed";
      code: string;
      message: string;
      retryable: boolean;
      retry_after?: string;
    };
```

Schema, Authority, target, ownership and confirmation failures prevent the
external call. An accepted execution that cannot succeed still returns a typed
failure Result so the decision body can close the user conversation.

### 13.2 Stable errors

The Provider maps vendor errors to bounded stable codes including:

```text
invalid_input
authority_denied
confirmation_required
confirmation_invalid
target_not_allowed
document_not_owned
document_not_found
revision_conflict
unsupported_document_shape
feishu_permission_denied
feishu_rate_limited
feishu_temporarily_unavailable
external_outcome_unknown
deadline_exceeded
```

Vendor payloads and secrets are not copied into Results.

### 13.3 Write safety

The reliability tuple is:

```text
Work Fabric Handoff idempotency key
+ invocation_id
+ capability_id
+ normalized input digest
+ Provider durable execution record
+ Feishu message UUID / ownership record / expected revision
```

Before an external write the Provider stores its execution intent. After a
successful external response it stores the Result before returning it to Work
Fabric. A lost Work Fabric response replays the same Result.

If a vendor response is lost and external success cannot be proved safely, the
execution becomes `external_outcome_unknown`. It does not blindly repeat the
write.

## 14. Configuration and credentials

The existing Configuration Provider remains the sole configuration access
surface. YAML is one implementation and is not imported by Provider business
code.

The Provider configuration contains:

- enabled instance and trusted factory type;
- Citizen IDs and local Runtime identity references;
- Credential Provider reference;
- backend type;
- Governance policy reference;
- storage Provider references;
- request limits, timeouts, retry ceilings and state directories.

Capabilities are discovered from the backend and declared dynamically.

The first OpenAPI backend uses the existing App ID/App Secret through a
Credential Provider to obtain `tenant_access_token`. Existing documents must
grant the application appropriate document access. User OAuth is not stored or
requested in this release.

## 15. External API surface

The first backend uses Feishu server APIs:

- IM v1 send message for single-target messaging;
- Docx v1 document creation;
- Docx v1 block/content reads and bounded simple-content writes;
- Drive/Docx file deletion according to the current official API contract.

Exact vendor endpoints and permission scopes are documented in the deployment
guide and isolated inside the backend. They are not part of Work Fabric
Capability Contract identifiers.

Official references:

- <https://open.feishu.cn/document/server-docs/im-v1/introduction?lang=zh-CN>
- <https://open.feishu.cn/document/server-side-sdk/golang-sdk-guide/calling-server-side-apis?lang=zh-CN>
- <https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server?lang=zh-CN>

MCP may be added as an alternative backend only if it preserves the same
contracts, Authority, confirmation, idempotency and typed Result semantics.

## 16. Observability

The operational plane exposes:

- Citizen registration revision, session, lease and health;
- declaration count and digest;
- capability availability and draining state;
- invocation Handoff and bound contract digest;
- Provider execution phase and attempt;
- external latency category and stable error code;
- ownership and confirmation audit references;
- Result delivery state.

Raw document content, message text, tokens, credentials and vendor response
bodies are excluded from default operational views and logs.

## 17. Testing and release gates

### 17.1 Protocol and Catalog

- Citizen kind and Descriptor validation.
- Dynamic declaration validation, bounds and unknown-field rejection.
- Schema digest immutability.
- session open, heartbeat, CAS update, fencing, draining and expiry.
- progressive disclosure Authority.
- declaration does not create invocation Authority.

### 17.2 Runtime foundations

- Factory registry and configuration isolation.
- leased runtime start, rollback, health and close.
- Delivery persistence before Ack.
- execution lease, dedupe, result-ready recovery and cancellation.
- exact bound-contract validation.

### 17.3 Feishu executor

- message target rules;
- create/read/update/append/delete happy paths;
- simple Markdown subset conversion;
- content bounds;
- revision conflicts;
- application permission errors;
- ownership and tenant isolation;
- confirmation challenge and single-use proof;
- external outcome-unknown behavior.

### 17.4 Agent invocation

- final response without invocation;
- dynamic discovery and full contract load;
- one and multiple sequential calls;
- maximum-four enforcement;
- grant denial and confirmation-required response;
- Provider failed Result converted into Agent-authored user language;
- cancellation and restart while waiting;
- no credentials in worker input/output.

### 17.5 End-to-end

The deterministic release test uses SQLite, public HTTP/SSE, a real Python
worker, a loopback model fake and a Fake Feishu OpenAPI:

```text
Fake Feishu mention
-> Intake Handoff
-> Daily Assistant decision
-> dynamic Citizen/Capability discovery
-> auxiliary Capability Handoff
-> Feishu Provider claim and Result
-> Daily Assistant continuation
-> original Handoff Result
-> original Feishu conversation
```

The CRUD scenario creates, reads, updates, appends and confirms/deletes one
temporary document while asserting events, ownership, revisions and audit.

The opt-in live smoke test uses a dedicated test folder and temporary document.
It never deletes a document not created by that test run.

## 18. Project documentation requirements

The implementation updates:

- the root README positioning and architecture;
- the main architecture document;
- a dedicated `docs/architecture/network-citizens.md`;
- protocol/API documentation for Citizen registration and discovery;
- Feishu Provider configuration and permission guide;
- Agent Runtime capability-invocation guide;
- roadmap/status documentation.

The module contribution checklist requires every new network-facing module to
state:

1. Citizen kind.
2. Principal/Actor/Endpoint identity model.
3. Dynamic declarations.
4. Authority and delegation requirements.
5. responsibility accepted and terminal-result behavior.
6. state and idempotency ownership.
7. secret boundary.
8. health, lease and shutdown behavior.
9. observable events and sensitive-data exclusions.
10. conformance and end-to-end tests.

## 19. Migration and compatibility

- Existing Endpoint capability declarations continue to work while Citizen
  Catalog projections are introduced.
- The Catalog initially projects task-responsible Capability declarations from
  Endpoint sessions; providers migrate to the Citizen session API without
  changing Handoff contracts.
- Existing Feishu Channel configuration and behavior remain unchanged.
- Existing Agent Runtime Driver protocol v1 remains valid for non-tool Drivers.
  Capability-aware Drivers explicitly negotiate the new protocol version.
- Existing Handoff snapshots that predate claim fields remain readable through
  protocol defaults.
- No existing SQLite or PostgreSQL adapter name is embedded in a public module
  interface.

## 20. Resolved decisions

- Use a separate Feishu Capability Provider, not direct Agent tools.
- Use direct Feishu OpenAPI as the first backend.
- Permit a future MCP backend behind the same Provider contract.
- Use application identity (`tenant_access_token`) first.
- Support single-target message send and simple document CRUD/append.
- Require explicit confirmation for delete.
- Delete only documents created by the same tenant's Provider.
- Use dynamic registration as runtime truth; YAML is bootstrap only.
- Adopt six Citizen kinds with four core collaboration kinds and two
  supporting kinds.
- Keep Actor type and Citizen kind orthogonal.
- Provide protocol contracts plus optional TypeScript base runtimes.
- Keep the original Agent responsible while auxiliary Capability Handoffs run.
