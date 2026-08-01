# Feishu Calendar Capability Provider Design

**Status:** Approved for implementation planning
**Date:** 2026-07-29
**Scope:** Feishu application-owned shared-calendar scheduling
**Primary boundary:** Work Fabric connects and transfers responsibility; the
Daily Assistant decides, and the Feishu Calendar Provider executes.

## 1. Purpose

Add production-oriented Feishu calendar capabilities to the existing
collaboration network so an external Agent can:

- inspect bounded free/busy facts;
- create one event on an authorized shared calendar;
- invite authorized users or one authorized Feishu chat;
- read and update Provider-owned events;
- add or remove attendees;
- delete a Provider-owned event after explicit confirmation; and
- return typed facts that the Agent can turn into a semantic reply.

The first end-to-end scenario is:

> A user mentions the assistant in a Feishu group and asks it to find a common
> free hour tomorrow afternoon and schedule a project review for the group.

The Daily Assistant interprets the request, queries free/busy facts, selects a
time, invokes the calendar capability and writes the final human-facing reply.
Work Fabric transports Handoffs and Authority. The Calendar Provider validates
and performs Feishu operations. No scheduling brain enters Core or the
Provider.

## 2. Confirmed decisions

1. The organizer is the Feishu application/bot identity.
2. Events are created on an explicitly registered primary or shared calendar
   for which the application has `writer` or `owner` access.
3. Calendar is an independent `capability-provider` Citizen, parallel to the
   existing Message and Document Citizens.
4. Feishu Integration remains a virtual grouping. It is not a Citizen,
   runtime, identity or owner of combined state.
5. The Calendar Citizen may run in the existing Feishu Provider process and
   reuse credential/token and bounded OpenAPI infrastructure. Its declarations,
   executor, resources, state, authorization and tests remain independent.
6. Calendar aliases and external calendar IDs are dynamic Provider state, not
   hard-coded business resources in the global YAML configuration.
7. The first phase uses application identity only. User OAuth and
   `user_access_token` lifecycle are deferred.
8. Meeting-room booking, recurring events, video-conference creation, event
   webhooks and natural-language person-name lookup are deferred.
9. Core protocol schemas, Exchange state machines, Channel SPIs and Agent Host
   contracts do not acquire Feishu dependencies.
10. Expanding a trusted Feishu chat into user references is an IM operation.
    The Message Citizen exposes it as an independent capability; the Calendar
    Citizen never calls a Message or Channel implementation directly.

## 3. Alternatives considered

### 3.1 Add calendar methods to the aggregate Feishu executor

This is the smallest diff but makes Message, Document and Calendar share one
execution boundary and one growing backend interface. Independent enablement,
authorization, scaling and testing become difficult. Rejected.

### 3.2 Add an independent Calendar Facet/Citizen in the existing process

This reuses common Feishu credentials and HTTP reliability while preserving an
independent declaration set, executor, resource registry and runtime Citizen.
It matches the current Message/Document Facet model and can later be moved to a
separate process without changing its contracts. Selected.

### 3.3 Deploy a separate Calendar Provider service immediately

This provides maximum process isolation but duplicates configuration,
credentials, lifecycle and local deployment work before load or ownership
requires it. Deferred. The selected design must keep package and port
boundaries narrow enough to permit this deployment later.

## 4. Architectural placement

```text
Feishu Collaboration Channel
  -> Intake Handoff
  -> Daily Assistant decision and capability disclosure
  -> auxiliary Capability Handoff
  -> Feishu Calendar Capability Citizen
  -> Feishu Calendar OpenAPI
  -> typed Capability Result
  -> Daily Assistant continuation
  -> canonical Result
  -> Feishu Collaboration Channel
```

Responsibilities remain closed:

| Component | Owns | Does not own |
| --- | --- | --- |
| Feishu Channel | trusted conversation route, inbound transport, outbound rendering | calendar intent, scheduling, calendar API calls |
| Daily Assistant | intent interpretation, missing-information questions, time selection, capability invocation, semantic reply | Feishu credentials, provider idempotency, vendor response parsing |
| Work Fabric | identity, Authority, Handoff, Capability discovery and responsibility transfer | scheduling policy, provider execution, business automation |
| Calendar Citizen | contracts, validation, calendar resources, OpenAPI calls, idempotency, external outcome classification | natural-language interpretation, selecting a preferred time |
| Governance/confirmation source | confirmation proof issuance and consumption | event execution |

The Calendar Citizen communicates only through existing Network Citizen and
Capability Handoff contracts. Message and Document Citizens do not import its
implementation.

## 5. Citizen and configuration model

The Feishu Provider gains an optional facet:

```yaml
calendar_citizen:
  enabled: true
  citizen_id: citizen-feishu-calendar
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
```

This block enables a module identity; it does not enumerate calendars, events,
people or live abilities. Declarations are published dynamically by the
running Citizen through the existing leased session.

The Calendar Citizen:

- has `citizen_kind: capability-provider`;
- uses the `feishu` declaration namespace;
- has an independently calculated `maximum_risk`;
- is provisioned, leased, declared, authorized, observed and disabled
  independently;
- contributes only its own capabilities to the shared Provider Endpoint; and
- can later use a distinct Endpoint/process without changing capability IDs.

Legacy aggregate Provider configuration remains readable during the existing
compatibility window. New deployments use independent Message, Document and
Calendar Facets. Enabled Citizen IDs must be unique.

## 6. Dynamic calendar registry

Calendar placement is Provider-owned dynamic state behind a narrow port:

```ts
interface FeishuCalendarRegistry {
  bind(input: CalendarBinding): Promise<CalendarBinding>;
  getByAlias(tenantId: string, alias: string): Promise<CalendarBinding | null>;
  getByResourceUri(
    tenantId: string,
    resourceUri: string,
  ): Promise<CalendarBinding | null>;
  setDefault(
    tenantId: string,
    alias: string,
    expectedVersion: number,
  ): Promise<CalendarBinding>;
  list(input: CalendarBindingQuery): Promise<CalendarBindingPage>;
}
```

A binding contains:

- tenant ID;
- stable local alias;
- canonical calendar resource URI;
- external calendar ID;
- Feishu calendar type;
- observed application role;
- active/disabled state;
- whether it is the tenant default;
- monotonic registry version;
- registering principal and timestamp; and
- last successful permission-check timestamp.

Memory and SQLite implementations follow the same contract. SQLite owns an
additive migration. Secrets, access tokens and event content never enter the
registry.

### 6.1 Administrative bootstrap

Calendar registration is an explicit deployment operation, never an automatic
startup side effect.

Two administrative commands are supported:

1. `bind-existing`: validate an existing calendar and bind it to an alias.
2. `create-and-bind`: explicitly create an application-owned shared calendar,
   then bind the returned calendar ID.

The recommended first local setup is `create-and-bind --alias team --default`.
Both commands adapt a narrow `FeishuCalendarAdministrationPort`. The initial
CLI adapter is a deployment-local administrative boundary: it requires local
access to the Provider configuration, credentials and state, records the
operator principal supplied by the deployment, and cannot run through an
Agent capability. A future authenticated HTTP or Console adapter may wrap the
same port without changing registry or Calendar execution code.

The operation:

1. acquires a single administrative operation lease in Provider state;
2. obtains Feishu application credentials through the existing credential
   provider;
3. validates or creates the shared calendar;
4. verifies type is `primary` or `shared`;
5. verifies the application role is `writer` or `owner`; and
6. writes a versioned binding to Provider state.

Feishu shared-calendar creation does not expose the event creation idempotency
key. Therefore a network-ambiguous create is recorded as
`external_outcome_unknown` and is not blindly retried. The operator reconciles
by listing calendars and then uses `bind-existing`. Successful bindings are
idempotent by tenant and alias.

Administrative calendar creation is not exposed as an Agent capability.

## 7. Resource references

External Feishu identifiers are normalized at the Provider boundary:

```text
feishu://calendar/{percent-encoded-calendar-id}
feishu://calendar/{percent-encoded-calendar-id}/events/{percent-encoded-event-id}
feishu://user/open-id/{percent-encoded-open-id}
feishu://chat/{percent-encoded-chat-id}
```

Capability input may select:

- `{ "kind": "default_calendar" }`;
- `{ "kind": "calendar_alias", "alias": "team" }`; or
- `{ "kind": "resource_reference", "resource_uri": "feishu://..." }`.

The Provider resolves all three to a registered active binding. Callers cannot
send a raw `calendar_id` to bypass registry and Authority checks.

The trusted current Feishu conversation route may authorize its own
`feishu://chat/...` reference. Any other user, chat, calendar or event must
appear in capability Authority evidence. The Agent cannot manufacture an
authorized target by putting an external ID in natural-language content.

## 8. Capability declarations

All declarations use `application/json`, immutable schema digests, asynchronous
interaction and typed-facts-only output.

### 8.0 Supporting Message capability

The group scheduling scenario also adds
`feishu.conversation.members.list` version `1.0.0` to the independent Message
Citizen.

Input is one authorized current-conversation or `feishu://chat/...` reference,
a bounded page size and an opaque cursor. Output is a deterministic page of
Feishu user resource references plus provenance and a next cursor.

The capability:

- is a low-risk query with no confirmation;
- requires `conversation_members:read`;
- may only query a chat present in Authority evidence;
- calls Feishu IM chat-members APIs through a Message-owned backend port;
- filters bot members according to Feishu's API behavior;
- returns IDs and bounded display facts, not calendar data; and
- does not invoke free/busy or select attendees.

The Agent calls this capability only when a target such as “群里大家” must be
expanded for free/busy. It then passes the returned user references to the
Calendar Citizen. Inviting the group to the event can still use the authorized
chat reference directly. Phase 1 common-slot calculation is bounded to 100
human members; larger groups are rejected with `participant_limit_exceeded`
instead of being silently truncated.

### 8.1 `feishu.calendar.freebusy.query`

- Version: `1.0.0`
- Operation: query
- Risk: low
- Confirmation: none

Input:

- bounded RFC 3339 start/end;
- 1–100 authorized user references;
- whether external calendars are included; and
- whether only busy intervals are requested.

The Provider:

- rejects an interval longer than two weeks;
- resolves user references to one configured Feishu ID type;
- chunks Feishu requests into batches of at most ten users;
- uses a bounded concurrency limit;
- preserves participant-to-result correlation;
- returns deterministic ordering; and
- returns per-participant typed errors when Feishu provides a known partial
  result.

Output contains requested coverage, participant busy intervals, unresolved
participants and provenance. It does not select a meeting time.

### 8.2 `feishu.calendar.event.create`

- Version: `1.0.0`
- Operation: command
- Risk: medium
- Confirmation: none for the first phase

Input:

- registered calendar selector;
- title and optional bounded description;
- RFC 3339 start/end and IANA time-zone name;
- zero or more authorized user/chat attendees;
- visibility;
- attendee ability;
- bounded reminders; and
- notification preference.

The Provider validates `start < end`, duration and collection bounds. It
derives a Feishu event idempotency key from the Work Fabric invocation
idempotency key, creates the event, then adds attendees through the official
attendee API.

The execution record is durable across both steps. Replaying the same
invocation does not create a second event. The output contains:

- canonical event resource URI;
- calendar resource URI;
- event ID and URL when supplied by Feishu;
- organizer mode `application`;
- start/end/time zone;
- attendee outcome for each requested target;
- `completion_state: complete | partial`; and
- timestamps and Feishu provenance.

`succeeded + completion_state: partial` means the Provider has a fully known,
durable result but one or more attendee operations were rejected. The Agent
must report that fact and may invoke an explicit repair capability. A timeout
whose external effect is unknown is `failed/external_outcome_unknown`, never a
partial success. The Provider does not silently delete a created event because
participants may already have received notifications.

### 8.3 `feishu.calendar.event.read`

- Version: `1.0.0`
- Operation: query
- Risk: low
- Confirmation: none

Reads one authorized event and returns bounded metadata, timing, visibility,
organizer and attendees. Phase 1 does not return attachments or arbitrary
vendor extensions.

### 8.4 `feishu.calendar.event.update`

- Version: `1.0.0`
- Operation: command
- Risk: medium
- Confirmation: none

Only Provider-owned active events are mutable in phase 1. Input carries the
expected Provider event version and an explicit field mask. The Provider reads
current Feishu state, detects known external changes, applies the update and
increments its version.

Feishu does not provide Work Fabric's native compare-and-swap semantics. The
Provider therefore documents the check-then-write race, never claims strict
external CAS, and returns `external_concurrent_change` when it can prove the
precondition changed.

### 8.5 `feishu.calendar.attendees.add`

- Version: `1.0.0`
- Operation: command
- Risk: medium
- Confirmation: none

Adds bounded, authorized user or chat attendees to one Provider-owned event and
returns per-target results. Duplicate attendees are idempotent.

### 8.6 `feishu.calendar.attendees.remove`

- Version: `1.0.0`
- Operation: command
- Risk: medium
- Confirmation: none

Removes bounded attendees from one Provider-owned event. Organizer removal is
forbidden. Unknown/already removed attendees produce stable idempotent facts.

### 8.7 `feishu.calendar.event.delete`

- Version: `1.0.0`
- Operation: destructive
- Risk: destructive
- Confirmation: explicit

Deletion requires:

- a Provider-owned, same-tenant active event;
- expected Provider event version;
- `calendar_event:delete` delegation scope;
- an Authority-bound confirmation proof reference; and
- successful single-use proof consumption by a Governance/confirmation port.

The Provider records the tombstone. Replays return the existing deletion
result and never invoke Feishu twice.

## 9. Authority and identity

The original user remains the represented Actor. The application is the
external calendar organizer, not the represented human.

Calendar operations map to delegation scopes:

| Capability | Required scope |
| --- | --- |
| Free/busy query | `calendar_freebusy:read` |
| Event read | `calendar_event:read` |
| Event create/update | `calendar_event:write` |
| Attendee add/remove | `calendar_attendee:write` |
| Event delete | `calendar_event:delete` |

The supporting Message capability requires `conversation_members:read`.

Capability Authority evidence carries separate bounded collections for:

- allowed calendar/event resource references;
- allowed attendee target references;
- confirmation proof references; and
- trusted source reference.

Existing Message/Document evidence remains backward compatible. The local
Daily Assistant Authority builder gains explicit calendar mappings; it does
not grant every discovered Calendar capability automatically.

The initial participant resolution policy supports:

1. the current trusted Feishu chat; and
2. user references returned by an authorized Message Citizen members query;
   and
3. explicit Feishu user references already present in authorized structured
   context.

The second case is an evidence chain, not a trust-by-copy rule. The Agent must
pass the prior members-query auxiliary Handoff ID in the next capability
request's `authority_evidence.capability_result_handoff_ids`. The local
invocation Authority provider loads that Handoff through the public Query
port and verifies all of the following before adding any returned user
reference to `allowed_target_refs`:

- it belongs to the same tenant and names the current original Handoff in its
  canonical capability work-reference extension;
- it invoked `feishu.conversation.members.list` through a bound declaration;
- it reached a successful Capability Result; and
- every requested user reference is present in that typed Result.

An arbitrary user reference copied into model output or natural language
therefore grants nothing. The evidence rule lives in the Agent-side Authority
policy, while Message remains solely responsible for producing membership
facts and Calendar remains solely responsible for calendar operations. No
Message-to-Calendar dependency is introduced.

Resolving arbitrary names such as “张三” into users belongs to a Directory
Provider and is outside this phase.

## 10. Provider internal ports

Calendar implementation uses focused contracts:

```ts
interface FeishuCalendarBackend {
  getCalendar(...): Promise<CalendarFacts>;
  createSharedCalendar(...): Promise<CalendarFacts>;
  queryFreeBusy(...): Promise<FreeBusyFacts>;
  createEvent(...): Promise<EventFacts>;
  readEvent(...): Promise<EventFacts>;
  updateEvent(...): Promise<EventFacts>;
  addAttendees(...): Promise<AttendeeMutationFacts>;
  removeAttendees(...): Promise<AttendeeMutationFacts>;
  deleteEvent(...): Promise<DeleteEventFacts>;
}

interface FeishuCalendarExecutionStore {
  begin(...): Promise<ExecutionFence>;
  checkpoint(...): Promise<void>;
  complete(...): Promise<void>;
}

interface FeishuCalendarEventStore {
  putOwnership(...): Promise<void>;
  getOwnership(...): Promise<EventOwnership | null>;
  updateVersion(...): Promise<void>;
  markDeleted(...): Promise<void>;
}
```

The Calendar executor does not extend the existing document/message backend
interface. A small bounded Feishu request client and token provider can be
shared by composition through dependency injection.

Suggested code boundaries:

```text
packages/provider-feishu/
  calendar-contracts.ts
  calendar-declarations.ts
  calendar-validation.ts
  calendar-resource-adapter.ts
  calendar-executor.ts
  calendar-openapi-backend.ts
  calendar-registry.ts
```

Files may later move to a dedicated package without changing public contracts.

## 11. Persistence and idempotency

Provider state adds:

- calendar binding registry;
- calendar execution records and step checkpoints;
- event ownership/version records; and
- deletion tombstones.

Rules:

1. Input is normalized and digested before any external write.
2. Tenant, capability ID and idempotency key identify one execution.
3. Reusing a key with another normalized input is rejected.
4. Event creation passes a deterministic 32–128 character Feishu idempotency
   key.
5. Attendee step progress is checkpointed so process restart resumes without
   recreating the event.
6. A known Feishu rejection is stable and non-retryable unless documented
   otherwise.
7. HTTP 429 and bounded 5xx outcomes are retryable with provider-controlled
   backoff.
8. A write timeout after the request may have reached Feishu is
   `external_outcome_unknown`; automatic replay occurs only when Feishu or the
   Provider record proves it is safe.
9. Provider logs and stores never retain access tokens.

Memory and SQLite adapters pass the same contract suite. SQLite migrations are
additive and restart-safe.

## 12. Feishu permissions and deployment requirements

The initial application requests only enabled calendar scopes:

```text
calendar:calendar:create
calendar:calendar:read
calendar:calendar.event:create
calendar:calendar.event:read
calendar:calendar.event:update
calendar:calendar.event:delete
calendar:calendar.free_busy:read
```

The “current group common free time” scenario additionally requires:

```text
im:chat.members:read
```

The bot capability remains enabled because Feishu application-identity calendar
calls require it. The application must be inside its intended tenant data
scope. A bound calendar must be `primary` or `shared` and the application must
have `writer` or `owner` access.

References:

- [Create event](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create)
- [Create shared calendar](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/create)
- [Batch free/busy query](https://open.feishu.cn/document/calendar-v4/calendar/batch?lang=zh-CN)
- [Delete event](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/delete)
- [Calendar scopes](https://open.feishu.cn/document/server-docs/application-scope/scope-list)
- [List chat members](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get)

No public domain is required for application-identity outbound OpenAPI calls.
User OAuth callback and refresh-token storage are not part of this phase.

## 13. Error model

Stable Provider codes include:

| Code | Outcome | Retryable | Meaning |
| --- | --- | --- | --- |
| `calendar_not_registered` | rejected | no | selector has no active binding |
| `calendar_not_writable` | rejected | no | app is not writer/owner |
| `calendar_type_unsupported` | rejected | no | not primary/shared |
| `target_not_allowed` | rejected | no | attendee/resource is outside Authority |
| `participant_limit_exceeded` | rejected | no | free/busy target exceeds phase bounds |
| `invalid_time_range` | rejected | no | malformed, inverted or overlong range |
| `event_not_owned` | rejected | no | mutation targets a non-Provider event |
| `event_version_conflict` | rejected | no | Provider version changed |
| `external_concurrent_change` | rejected | no | a known Feishu change invalidated input |
| `confirmation_required` | rejected | no | delete proof missing |
| `confirmation_invalid` | rejected | no | proof invalid, expired or already used |
| `feishu_permission_denied` | rejected | no | Feishu rejected app authorization |
| `feishu_rate_limited` | failed | yes | bounded rate limit |
| `feishu_temporarily_unavailable` | failed | yes | retryable remote/server failure |
| `external_outcome_unknown` | failed | no | unsafe to replay automatically |

Provider errors are typed operational facts, not conversational messages. The
Daily Assistant authors the user-facing explanation.

## 14. Agent behavior

The Calendar capability is dynamically disclosed like every other Citizen.
The Agent:

1. asks for missing date, duration, time zone or participant details;
2. expands an authorized chat through the Message Citizen when user references
   are required;
3. uses free/busy only when the request requires a common slot;
4. selects a slot based on returned facts;
5. invokes create with explicit structured input;
6. handles `partial` attendee completion explicitly;
7. returns the canonical event link and meaningful outcome; and
8. does not invent success if the Provider returns rejected, failed or unknown.

The Agent prompt/role may describe how to use Calendar declarations, but no
Calendar special case enters Agent Host or Agently transport protocol.

## 15. Observability

Operations visibility must expose safe facts:

- Citizen session and declaration health;
- auxiliary Calendar Handoff and selected Citizen/Endpoint;
- invocation ID and capability ID;
- calendar alias/resource fingerprint, never credentials;
- idempotency/execution state;
- event resource URI;
- attendee counts by outcome;
- Feishu error classification and retry state; and
- event ownership/version/tombstone state.

Event titles, descriptions, attendee identifiers and free/busy intervals are
content and follow existing visibility/retention rules. They must not appear in
ordinary logs.

## 16. Test strategy

Implementation follows TDD.

### 16.1 Contract and validation tests

- every input/output schema accepts valid bounded examples;
- unknown fields and raw vendor IDs fail closed;
- time ranges, time zones, reminders and collection sizes are bounded;
- declarations have stable digests, risk and operation kinds;
- dynamic Facet enablement and unique Citizen IDs are enforced.

### 16.2 Backend tests

Using a deterministic fake Feishu server:

- correct Calendar v4 paths, query parameters and payloads;
- application token refresh and 401 retry;
- Feishu error classification;
- response byte limits and timeouts;
- batch free/busy chunking at ten users;
- event idempotency-key derivation;
- attendee add/remove and notification flags;
- no secret leakage.

### 16.3 Persistence contract tests

Memory and SQLite prove:

- binding CAS and default alias rules;
- execution idempotency and input conflict;
- event/attendee step checkpoint recovery;
- ownership/version/tombstone persistence;
- pagination and tenant isolation;
- migration/restart behavior.

### 16.4 Executor tests

- Authority scope and target/resource references are mandatory;
- free/busy returns typed facts and never selects a time;
- create records ownership and returns complete/partial attendee outcomes;
- restart resumes after event creation without creating another event;
- non-owned update/attendee/delete operations fail closed;
- deletion consumes one explicit confirmation proof;
- retryable, rejected and unknown outcomes remain distinct.

### 16.5 Composition tests

- Calendar Citizen provisions and declares independently;
- disabling it leaves Message, Document and Context unchanged;
- Capability ID maps to the Calendar Citizen;
- shared Endpoint session contains the correct union of capabilities;
- startup rollback closes already-started Citizens and state;
- legacy aggregate configuration remains valid.

### 16.6 Agent integration tests

- Calendar capabilities are progressively disclosed;
- the Message Citizen independently discloses bounded conversation-member
  lookup;
- local invocation Authority maps calendar scopes;
- a fake-model tool request reaches the Calendar Citizen through an auxiliary
  Handoff;
- Calendar typed output returns to the same Agent run;
- final semantic reply contains the event link;
- Provider failure never becomes a fabricated success.

### 16.7 End-to-end acceptance

With deterministic model and fake Feishu OpenAPI:

1. submit a trusted Feishu-group message requesting a common time;
2. Agent asks the Message Citizen for authorized group members;
3. Agent queries free/busy for the returned user references;
4. Agent selects a returned free slot;
5. Agent creates the event and group attendee;
6. Provider returns a typed event resource and URL;
7. Agent returns a Markdown link through the real Channel rendering path;
8. repeat the ingress and capability idempotency keys;
9. prove one Handoff result, one external event and no duplicate attendee
   mutation.

After deterministic E2E passes, a manually authorized local smoke test uses the
real Feishu tenant and a dedicated test calendar.

## 17. Acceptance criteria

The phase is complete only when:

1. Calendar is an independently enabled and discoverable Capability Citizen.
2. Core, Channel SPI and Agent Host contain no Feishu Calendar dependency.
3. A calendar can be explicitly created/bound and marked default without
   placing its external ID in canonical YAML.
4. The seven Calendar capabilities are versioned, schema-bound and routed to
   the Calendar Citizen; conversation-member lookup remains routed to the
   Message Citizen.
5. Free/busy batching obeys Feishu's ten-user and two-week bounds.
6. Application identity creates one Provider-owned event and authorized
   attendees with durable idempotency.
7. Update, attendee mutation and delete are limited to authorized
   Provider-owned events.
8. Delete requires a valid single-use explicit confirmation.
9. Agent-generated semantic replies remain owned by the Agent.
10. Memory/SQLite, configuration, declaration, backend, executor, composition,
    Agent integration and E2E tests pass.
11. Required Feishu permissions and local bootstrap/test steps are documented.
12. A real smoke test can create a test event and return a clickable Feishu
    event link without enabling user OAuth.

## 18. Deferred work

- per-user `user_access_token`, OAuth callback and refresh-token vault;
- user-as-organizer semantics;
- arbitrary employee-name directory resolution;
- meeting-room booking and approval limitations;
- Feishu video meeting creation;
- recurring-event series and instance mutation;
- event/calendar change subscriptions and reconciliation workers;
- cross-provider calendar federation;
- scheduling ranking or automatic policy inside Work Fabric;
- a separate Calendar Provider process.

Each item can extend or independently deploy the Calendar Citizen without
changing Exchange Core or the existing Channel contract.
