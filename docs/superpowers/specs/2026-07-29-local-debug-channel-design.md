# Long-lived local Debug Channel

## Status

Approved in conversation on 2026-07-29.

The user explicitly requires this facility to remain useful for long-term local
development. It is therefore a supported development integration, not a
one-off test script or an in-process test backdoor.

## Problem

Work Fabric has a real Feishu Channel, a local Daily Assistant Runtime and
end-to-end tests, but local diagnosis still depends too heavily on a live
vendor channel. That makes it unnecessarily difficult to:

- inject a precise message without changing Feishu state;
- exercise every WFPP content representation and failure boundary;
- correlate ingress, Handoff, Agent Result, event delivery and channel output;
- reproduce an incident with a stable idempotency key;
- distinguish a Channel formatting failure from an Agent or Fabric failure;
- run the complete collaboration path deterministically in CI and offline.

Adding test-only routes to the primary Work Fabric HTTP service would make the
kernel or public binding responsible for fabricating external events. Calling
the Agent Runtime directly would skip the collaboration network being tested.
Neither is acceptable.

## Decision

Add a standard `collaboration-channel.debug` plugin with a loopback-only,
versioned HTTP transport.

The Debug Channel enters Work Fabric through the same plugin, Connector
Ingress, identity, Authority, Handoff, event subscription and Signal Adapter
boundaries as a real Channel. It does not call the Agent Runtime directly and
does not add a debug operation to Exchange Core or the primary HTTP service.

The plugin is a Network Citizen of kind `channel`. It closes only these
responsibilities:

1. accept a bounded, authenticated local representation of an external
   participant message;
2. normalize it into one Connector Ingress event;
3. persist the route needed to return events to the originating debug
   conversation;
4. losslessly capture outbound canonical events and expose them through the
   debug transport.

It does not understand intent, choose a receiver, claim or accept a Handoff,
run a model, author an answer, invoke a capability, or reinterpret another
module's failure.

## Alternatives

### A. Standard Debug Channel plugin — selected

This is reusable for manual development and automation, exercises real
boundaries, and preserves the rule that the kernel never learns about a vendor
or test transport.

### B. One-shot CLI driver

A CLI is useful as a client of the selected HTTP API, but is insufficient as
the transport itself. It makes asynchronous delivery capture and restart
recovery awkward and tends to bypass plugin lifecycle behavior.

### C. In-process fake adapter

Memory fakes remain appropriate for unit tests. They cannot validate process
lifecycle, configuration, HTTP authentication, durable ingress, routing or
restart behavior and therefore are not the long-lived solution.

## Architecture

```text
Local caller / CLI / test
        |
        | HTTP on 127.0.0.1 + Bearer token
        v
Debug Channel transport
        |
        | ConnectorIngressEnvelope
        v
Connector Ingress Store -> Connector Worker -> Command Sink
        |                                      |
        |                                      v
        |                              Identity / Authority
        |                                      |
        |                                      v
        |                                  Handoff
        |                                      |
        |                             external Decision Body
        |                              (human or Agent)
        |                                      |
        |                                      v
        |                                   Result
        |                                      |
        v                                      v
Debug submission status <- Event / Subscription / Signal Adapter
        |
        v
Durable Debug Channel capture -> HTTP query / CLI output
```

The selected package boundaries are:

- `@work-fabric/debug-channel-spi`: debug submission, capture and storage
  ports that contain no Node, SQLite or service composition dependency;
- `@work-fabric/adapter-debug-channel-memory`: deterministic unit-test
  storage;
- `@work-fabric/adapter-debug-channel-sqlite`: durable local storage using the
  deployment-owned SQLite session;
- `@work-fabric/plugin-channel-debug`: the plugin factory, mapper, receipt
  handler, route-aware Signal Adapter and loopback HTTP transport;
- `service-node`: composition only. It injects development mode, storage,
  clock, ingress, command sink, route store and signal registry capabilities;
- `tools/local-debug-*`: operator-facing startup, status, stop, send and E2E
  clients. Tools consume public/local contracts and contain no Fabric domain
  behavior.

Core, the protocol schemas, Agent Runtime and existing Channels do not depend
on these packages.

## Content model

“Any format” means every valid WFPP `ContentPart`, plus deliberately invalid
or unsupported representations used to test failure behavior. It does not
mean bypassing WFPP validation.

The message request accepts an ordered `content` array:

```ts
type DebugContentPart =
  | {
      readonly kind: "text";
      readonly media_type: string;
      readonly text: string;
      readonly language?: string;
      readonly extensions?: JsonObject;
    }
  | {
      readonly kind: "data";
      readonly schema_ref: string;
      readonly data: JsonValue;
      readonly extensions?: JsonObject;
    }
  | {
      readonly kind: "resource";
      readonly resource: ResourceRef;
      readonly extensions?: JsonObject;
    };
```

Examples include plain text, Markdown, an application-specific text media
type, typed JSON data and external resource references. The Debug Channel
preserves order and values and performs no semantic conversion.

Protocol-invalid requests fail at the HTTP boundary with a stable validation
error and never create ingress. A valid but unsupported media type or schema
continues through the normal target-eligibility and consumer behavior and
must expose the real rejection or failure. The Debug Channel must not silently
convert it to plain text.

The outbound capture stores the complete canonical `ProtocolEvent`. Because
the Debug Channel is a diagnostic sink rather than a vendor renderer, it can
losslessly accept protocol-valid JSON events without claiming that Feishu,
email or any other Channel can render those representations.

Capture is idempotent on tenant, plugin instance, event ID and destination ID.
A Signal retry returns the same capture record instead of appending a second
visible message.

## Versioned local HTTP API

The listener is independent from the primary Work Fabric HTTP listener.
Version 1 exposes:

| Operation | Method and path |
| --- | --- |
| Health | `GET /health` |
| Submit message | `POST /v1/conversations/{conversation_id}/messages` |
| Read submission | `GET /v1/submissions/{submission_id}` |
| List captured conversation events | `GET /v1/conversations/{conversation_id}/events` |
| Read captured event | `GET /v1/events/{capture_id}` |

All endpoints except health require:

```text
Authorization: Bearer <debug token>
```

Health returns bounded lifecycle facts and no configuration, identities,
content or token material.

### Submission request

```json
{
  "idempotency_key": "eda-summary-001",
  "participant_ref": "internal-user",
  "content": [
    {
      "kind": "text",
      "media_type": "text/markdown",
      "text": "请总结下面的 **EDA** 信息"
    },
    {
      "kind": "data",
      "schema_ref": "https://schemas.example.test/eda-note/v1",
      "data": {
        "topic": "event-driven architecture",
        "status": "draft"
      }
    }
  ]
}
```

The caller supplies a configured `participant_ref`, never a raw principal,
Actor, Endpoint, delegation or Authority claim. The plugin resolves the
reference from its trusted configuration and rejects unknown references.
Each fixture selects one of two normal identity paths:

- `static` uses a configured Actor/Endpoint tuple and the existing local
  Identity and Authority adapters;
- `admission` uses a configured external subject and policy ID, calls the
  shared `CollaborationAdmissionService`, and passes its scoped
  representation grant through the existing Connector command path.

The HTTP request cannot select the mode, policy, external subject or resolved
identity. This permits long-term tests of both a known local participant and a
new externally admitted participant without introducing a third identity
model.

The response is `202 Accepted` and includes:

- `submission_id`;
- `ingress_id`;
- `conversation_id`;
- current ingress state;
- links to the submission and captured event collection.

The same plugin instance, conversation and idempotency key with the same
canonical request returns the existing submission. Reuse with different
content returns `409 idempotency_conflict`.

### Submission status

The status resource correlates transport facts without inventing a new
workflow state machine:

- Debug request accepted;
- Connector ingress identifier and state;
- Handoff identifier and version after the accepted receipt is available;
- latest known Handoff lifecycle state when queryable;
- outbound capture identifiers;
- bounded failure code from the owning layer.

It does not collapse `accepted`, `result_returned`, event delivery and channel
capture into one ambiguous “success” flag.

### Event query

Captured events are ordered by `(captured_at, capture_id)` and use an opaque,
signed cursor. Queries require a bounded `limit`; content is returned only to
the authenticated local caller. Every response includes the canonical event
and delivery metadata, not a vendor-specific rendering.

The v1 API is backward-compatible. Breaking request or response changes use a
new path version. Additive fields are permitted.

## Configuration

The plugin is enabled through the existing global Configuration Provider:

```yaml
service:
  development_mode: true

plugins:
  instances:
    debug-local:
      type: collaboration-channel.debug
      enabled: true
      config:
        connector_id: debug-local
        external_tenant_id: debug-fixtures
        listen:
          host: 127.0.0.1
          port: 8791
        credentials:
          bearer_token: ${WORK_FABRIC_DEBUG_TOKEN}
        intake_target:
          actor_id: actor-daily-assistant
          endpoint_id: endpoint-daily-assistant-local
        participants:
          internal-user:
            mode: static
            external_subject_type: human
            external_subject_id: fixture-internal-user
            actor_id: actor-debug-user
            actor_type: human
            endpoint_id: endpoint-debug-user
          admitted-user:
            mode: admission
            external_subject_type: human
            external_subject_id: fixture-admitted-user
            policy_id: debug-local-admission
        limits:
          max_request_bytes: 262144
          max_content_parts: 32
          max_text_bytes: 131072
          max_json_depth: 32
          max_page_size: 100
        retention:
          max_age_days: 14
          cleanup_batch_size: 500
```

YAML is only the first Provider. Runtime code consumes a validated
configuration snapshot and secret references, so a database-backed Provider
can replace YAML without changing the plugin.

Static participant configuration binds local fixture names to already governed
network identities. Admission participants bind fixture names to external
subjects and normal Admission policies. Corresponding Identity, Admission and
Authority rules remain in the normal service configuration. The Debug Channel
does not grant them.

## Development-only safety

The plugin must fail to compose unless all of the following are true:

- `service.development_mode` is `true`;
- the listener host is an IP loopback address (`127.0.0.0/8` or `::1`);
- a non-empty secret reference resolves to a bounded token;
- an injected durable or memory Debug Channel Store is available;
- every configured participant and intake target is syntactically valid.

Hostnames such as `localhost` are not accepted for the binding because name
resolution can vary. `0.0.0.0`, LAN addresses, Unix wildcard sockets and
external URLs are forbidden in v1.

Authentication comparison is constant-time. Request bodies, content, tokens
and full Authorization headers are absent from logs, metrics, health and error
details. Rate, concurrency and body limits are enforced before JSON
materialization where possible.

The primary Work Fabric HTTP API never exposes these routes. Production
configuration containing an enabled Debug Channel fails closed instead of
silently ignoring it.

## Persistence, isolation and retention

`memory-demo` uses the memory adapter and explicitly loses debug history on
restart. `sqlite-local` uses the SQLite adapter and survives service restart.
No implicit fallback from SQLite to memory is allowed.

Debug records are private transport diagnostics, not authoritative
collaboration facts. The authoritative Handoff, event and delivery state
remains in existing Work Fabric stores. The debug store persists only:

- submission correlation and canonical request digest;
- ingress and Handoff references;
- captured canonical event and delivery metadata;
- bounded owning-layer failure codes;
- creation, update and expiry timestamps.

Records are isolated by tenant and plugin instance. Conversation identifiers
are scoped within the plugin instance and do not become global Thread IDs.
Cleanup is bounded and resumable. Expiry of a debug record never deletes a
Handoff, event, Agent state or external resource.

The store port permits a future PostgreSQL adapter, but no PostgreSQL debug
adapter is required for this local-development increment.

## Lifecycle and concurrency

The listener is owned by the plugin lifecycle:

- `prepare` validates configuration, registers the Signal Adapter and static
  subscription facts, and performs no listening;
- `start` binds the loopback listener and starts the Connector Worker;
- `health` distinguishes listener, worker and storage degradation;
- `stop` stops accepting requests, drains bounded active requests, stops the
  worker, closes the listener and unregisters the adapter.

Port conflicts fail startup. Multiple Debug Channel instances may run when
they use distinct ports and stores remain scoped by instance. Concurrent
submissions are isolated by idempotency identity and durable ingress fencing.

Inbound accepted receipts record the Handoff-to-conversation Channel Route.
Outbound events resolve that route before capture. Missing, conflicting or
cross-tenant routes fail explicitly and never fall back to another
conversation.

## Operator tooling

The supported local workflow includes:

```text
npm run local:debug:start
npm run local:debug:status
npm run local:debug:send -- --conversation demo --file request.json
npm run local:debug:stop
npm run local:debug:e2e
```

The startup tool composes Work Fabric, the Debug Channel and the configured
Agent Runtime through their public lifecycle boundaries. The send tool is an
HTTP client only. It accepts a JSON file so mixed content parts and arbitrary
safe JSON are not constrained by shell quoting.

Status reports child process liveness plus each component's real health
endpoint. It must not repeat the existing local-stack mistake of treating a
terminated package-manager wrapper PID as proof that a healthy child process
is dead.

## Observability

Every request receives a submission correlation identifier. Logs and metrics
may include tenant-safe digests, plugin instance, submission ID, ingress ID,
Handoff ID, capture ID, state, media type, byte count, duration and stable
failure code.

They must not include message text, typed data values, resource credentials,
bearer tokens, model prompts or Agent output.

The Console may later consume existing Work Fabric operational APIs plus the
local debug API, but Console is not required for message execution and the
Debug Channel does not depend on it.

## Deterministic end-to-end acceptance

The primary acceptance test runs without Feishu, a public network endpoint or
a paid model:

1. start the Node service with SQLite, the Debug Channel and a configured test
   participant;
2. start the real Daily Assistant Runtime boundary with its Agently Worker and
   a deterministic local OpenAI-compatible model fixture;
3. submit a mixed Markdown and typed-data message over the loopback debug API;
4. observe one durable Connector ingress record;
5. observe one authorized Handoff targeted to the assistant;
6. observe the assistant accept it and return one semantic
   `text/markdown` Result containing a labeled HTTPS link;
7. observe one routed canonical Result event captured by the same debug
   conversation;
8. restart the Node service and confirm that submission and capture queries
   still return the same identifiers and content digest;
9. resubmit the same idempotency key and confirm that no second Handoff or
   capture is created.

Additional tests must prove:

1. text, typed data and resource parts preserve order and values;
2. protocol-invalid content receives `400` and creates no ingress;
3. an unknown participant receives `403` and creates no ingress;
4. valid but unsupported content exposes the real target or consumer failure;
5. static and Admission-backed participants both use their normal identity
   path, and Admission denial creates no Handoff;
6. a missing Authority rule is rejected by the normal command path;
7. cross-tenant, cross-instance and cross-conversation reads are impossible;
8. wrong or missing tokens receive `401`;
9. non-loopback or production-mode configurations fail before listening;
10. oversized, over-depth and over-part-count input is rejected;
11. duplicate-identical and duplicate-conflicting submissions behave
    deterministically;
12. Signal retry preserves event identity and produces one successful capture;
13. plugin stop drains and releases its port;
14. memory and SQLite adapters pass the same store contract suite;
15. plugin boundary and sensitive-observability checks remain clean;
16. the full WFPP conformance suite and existing Feishu E2E tests do not
    regress.

An optional live-model smoke test may use the operator's configured model, but
it is not the deterministic release gate.

## Documentation deliverables

Implementation updates must include:

- an architecture note classifying the Debug Channel as a development-only
  `channel` Citizen;
- configuration reference with all limits and safe defaults;
- a local start/send/query/stop guide;
- example plain text, Markdown, typed data and resource requests;
- a troubleshooting table that separates HTTP, ingress, Authority, Handoff,
  Agent, Signal and capture failures;
- roadmap status and the exact deterministic E2E command.

## Non-goals

This increment does not:

- expose a production webhook or remote test service;
- provide a general-purpose message broker or API mocking platform;
- emulate Feishu, WeCom, Slack or email rendering;
- add Agent reasoning, routing or scheduling to the Channel;
- introduce a second workflow state machine;
- bypass protocol validation, Identity, Admission or Authority;
- make debug records an authoritative source of collaboration truth;
- promise that every target Agent can consume every valid WFPP content type.
