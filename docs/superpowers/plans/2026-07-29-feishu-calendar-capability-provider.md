# Feishu Calendar Capability Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an application-owned Feishu Calendar Capability Citizen that can query common availability and manage authorized shared-calendar events while keeping scheduling decisions in the Daily Assistant and keeping Exchange Core unchanged.

**Architecture:** Extend the existing Feishu Integration with an independently enabled Calendar Facet/Citizen, its own declarations, executor, OpenAPI backend and persistent resource state. Add one supporting `feishu.conversation.members.list` capability to the Message Citizen so the Agent, rather than Calendar, composes IM membership with free/busy queries. Reuse the existing Network Citizen, auxiliary Capability Handoff, Authority and Agent continuation paths.

**Tech Stack:** TypeScript 7, Node.js 22.20+, Node `fetch`, Node `sqlite`, AJV 8, Vitest 4, existing Work Fabric Network Citizen/Capability Provider/Agent Runtime SDKs, Feishu Calendar v4 and IM v1 OpenAPI.

## Global Constraints

- Work Fabric connects and transfers responsibility; the Daily Assistant decides; the Feishu Calendar Provider executes typed operations.
- Do not add Feishu Calendar dependencies to Exchange Core, protocol state machines, Channel SPI or Agent Host.
- Calendar is an independent `capability-provider` Citizen, parallel to Message and Document.
- Feishu Integration remains a virtual grouping and owns no combined identity, state or runtime.
- Application/bot identity is the organizer; user OAuth is outside this phase.
- Calendar IDs and aliases live in dynamic Provider state, never canonical YAML.
- Calendar must not read IM membership internally; `feishu.conversation.members.list` remains owned by Message Citizen.
- Common-slot calculation is limited to 100 human members, free/busy requests are chunked to ten users, and one query covers at most two weeks.
- All external writes are durably idempotent; unknown remote outcomes are never blindly replayed.
- Provider outputs typed facts only; the Agent owns every semantic user reply.
- Meeting rooms, recurring events, video meeting creation, event webhooks and arbitrary employee-name resolution are outside this phase.
- Implementation is test-driven: every behavior starts with a failing targeted test and every task ends with a focused verification and commit.

## File and ownership map

### Message Citizen

- Modify `packages/provider-feishu/src/declarations.ts`: add versioned conversation-member schemas and declaration.
- Create `packages/provider-feishu/src/conversation-members-executor.ts`: validate Authority, cursor and output for bounded membership pages.
- Create `packages/provider-feishu/src/conversation-members-openapi.ts`: own IM v1 chat-member API calls and pagination.
- Modify `packages/provider-feishu/src/executor-router.ts`: route the new Message capability without Calendar knowledge.

### Calendar Citizen

- Create `packages/provider-feishu/src/calendar-contracts.ts`: all Calendar backend, registry, execution and ownership ports.
- Create `packages/provider-feishu/src/calendar-declarations.ts`: seven Calendar Capability Contracts and schema documents.
- Create `packages/provider-feishu/src/calendar-validation.ts`: strict normalized input decoders.
- Create `packages/provider-feishu/src/calendar-resource-adapter.ts`: canonical Feishu calendar/event/user/chat URIs.
- Create `packages/provider-feishu/src/calendar-memory-store.ts`: deterministic in-memory registry/execution/event state.
- Create `packages/provider-feishu/src/calendar-sqlite-store.ts`: restart-safe SQLite implementation.
- Create `packages/provider-feishu/src/calendar-openapi-backend.ts`: Feishu Calendar v4 request mapping and error classification.
- Create `packages/provider-feishu/src/calendar-executor.ts`: Authority, ownership, idempotency, checkpoints and typed outcomes.
- Create `packages/provider-feishu/src/calendar-administration.ts`: create/bind/default-calendar administration service.

### Composition and operation

- Modify `packages/provider-feishu/src/config.ts`, `declarations.ts`, `schema-registry.ts`, `index.ts`.
- Modify `examples/feishu-capability-provider/src/configuration.ts`, `composition.ts`, `provision.ts`, `main.ts`.
- Create `tools/feishu-calendar-admin.ts` and add root npm scripts.
- Modify `examples/agently-agent-runtime/src/local-invocation-authority.ts` and role/capability fixtures.
- Modify `examples/config/local-feishu-assistant.bundle.yaml`, guides and permission documentation.

---

### Task 1: Add bounded Feishu conversation-member disclosure

**Files:**
- Modify: `packages/provider-feishu/src/declarations.ts`
- Create: `packages/provider-feishu/src/conversation-members-executor.ts`
- Create: `packages/provider-feishu/src/conversation-members-openapi.ts`
- Modify: `packages/provider-feishu/src/executor-router.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/conversation-members-executor.test.ts`
- Test: `packages/provider-feishu/test/conversation-members-openapi.test.ts`
- Test: `packages/provider-feishu/test/schema-registry.test.ts`

**Interfaces:**
- Consumes: existing `FeishuCapabilityExecutionRequest`, `FeishuCapabilityOutcome`, `FeishuOpenApiRequestClient`, HMAC cursor conventions and `feishu://chat/...` Authority target references.
- Produces:

```ts
export interface FeishuConversationMembersClient {
  list(input: {
    readonly chat_id: string;
    readonly page_size: number;
    readonly page_token?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly members: readonly {
      readonly open_id: string;
      readonly display_name?: string;
    }[];
    readonly next_page_token?: string;
    readonly has_more: boolean;
  }>;
}

export class FeishuConversationMembersExecutor
  implements FeishuCapabilityExecutorLike {
  execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome>;
}
```

- [ ] **Step 1: Write failing declaration and executor tests**

```ts
it("declares bounded conversation member lookup on the Message Citizen", () => {
  const declaration = feishuMessageCapabilityDeclarations().find(
    (item) => item.declaration_id === "feishu.conversation.members.list",
  );
  expect(declaration).toMatchObject({
    version: "1.0.0",
    risk: "low",
    constraints: {
      operation_kind: "query",
      provider_output: "typed_facts_only",
    },
  });
});

it("rejects a chat outside capability Authority", async () => {
  await expect(executor.execute(request({
    capability_id: "feishu.conversation.members.list",
    input: {
      conversation: {
        kind: "resource_reference",
        resource_uri: "feishu://chat/chat-2",
      },
      page_size: 50,
    },
    allowed_target_refs: ["feishu://chat/chat-1"],
  }))).resolves.toMatchObject({
    outcome: "rejected",
    code: "target_not_allowed",
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run \
  packages/provider-feishu/test/conversation-members-executor.test.ts \
  packages/provider-feishu/test/schema-registry.test.ts
```

Expected: FAIL because the declaration and executor do not exist.

- [ ] **Step 3: Add exact input/output schemas and declaration**

Add schema documents with these shapes:

```ts
const conversationMembersInput = objectSchema(
  ["conversation", "page_size"],
  {
    conversation: {
      oneOf: [
        objectSchema(["kind"], {
          kind: { const: "current_conversation" },
        }),
        objectSchema(["kind", "resource_uri"], {
          kind: { const: "resource_reference" },
          resource_uri: {
            type: "string",
            pattern: "^feishu://chat/[^/]+$",
            maxLength: 2_048,
          },
        }),
      ],
    },
    page_size: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string", minLength: 1, maxLength: 4_096 },
  },
);

const conversationMembersOutput = objectSchema(
  ["members", "has_more", "provenance"],
  {
    members: {
      type: "array",
      maxItems: 100,
      items: objectSchema(["resource_uri"], {
        resource_uri: {
          type: "string",
          pattern: "^feishu://user/open-id/[^/]+$",
        },
        display_name: { type: "string", maxLength: 255 },
      }),
    },
    has_more: { type: "boolean" },
    next_cursor: { type: "string", minLength: 1, maxLength: 4_096 },
    provenance: objectSchema(
      ["provider_family", "source", "source_reference"],
      {
        provider_family: { const: "feishu" },
        source: { const: "im.chat.members" },
        source_reference: { type: "string", format: "uri" },
      },
    ),
  },
);
```

Register `feishu.conversation.members.list` version `1.0.0`, low risk, query,
no confirmation, asynchronous mode.

- [ ] **Step 4: Implement the executor and OpenAPI client**

The OpenAPI client must call:

```text
GET /open-apis/im/v1/chats/{chat_id}/members
    ?member_id_type=open_id
    &page_size={1..100}
    [&page_token=...]
```

The executor must:

```ts
const requiredScope = "conversation:members:read";
const targetRef = `feishu://chat/${encodeURIComponent(chatId)}`;
if (!request.delegation_scopes.includes(requiredScope)) {
  return rejected("scope_not_granted", "Conversation members scope is absent");
}
if (!request.authority.allowed_target_refs.includes(targetRef)) {
  return rejected("target_not_allowed", "Conversation is not authorized");
}
```

Return percent-encoded `feishu://user/open-id/...` references, deterministic
order, safe provenance and an HMAC-wrapped opaque page cursor. Never return bot
members missing from Feishu's response and never infer calendar facts.

- [ ] **Step 5: Add 401/403/429, cursor and pagination tests**

Cover:

```ts
expect(requestedUrl.pathname).toBe(
  "/open-apis/im/v1/chats/chat-1/members",
);
expect(requestedUrl.searchParams.get("member_id_type")).toBe("open_id");
expect(result).toMatchObject({
  outcome: "succeeded",
  data: {
    members: [
      { resource_uri: "feishu://user/open-id/ou_1" },
    ],
    has_more: false,
  },
});
```

Classify 403 as `feishu_permission_denied`, 429 as retryable
`feishu_rate_limited`, invalid cursor as rejected `invalid_cursor`, and an
oversized response as retryable `feishu_response_invalid`.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/conversation-members-executor.test.ts \
  packages/provider-feishu/test/conversation-members-openapi.test.ts \
  packages/provider-feishu/test/schema-registry.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): expose conversation member capability"
```

### Task 2: Define Calendar contracts, schemas and resource URIs

**Files:**
- Create: `packages/provider-feishu/src/calendar-contracts.ts`
- Create: `packages/provider-feishu/src/calendar-declarations.ts`
- Create: `packages/provider-feishu/src/calendar-validation.ts`
- Create: `packages/provider-feishu/src/calendar-resource-adapter.ts`
- Modify: `packages/provider-feishu/src/schema-registry.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/calendar-declarations.test.ts`
- Test: `packages/provider-feishu/test/calendar-validation.test.ts`
- Test: `packages/provider-feishu/test/calendar-resource-adapter.test.ts`

**Interfaces:**
- Consumes: `CitizenDeclaration`, `canonicalCitizenDigest`,
  `CapabilityExecutionResult`, strict JSON and existing Provider error
  conventions.
- Produces:

```ts
export type CalendarSelector =
  | { readonly kind: "default_calendar" }
  | { readonly kind: "calendar_alias"; readonly alias: string }
  | {
      readonly kind: "resource_reference";
      readonly resource_uri: string;
    };

export interface CalendarEventOwnership {
  readonly tenant_id: string;
  readonly event_resource_uri: string;
  readonly calendar_resource_uri: string;
  readonly external_event_id: string;
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly original_handoff_id: string;
  readonly initiating_actor_id: string;
  readonly create_idempotency_key: string;
  readonly provider_version: number;
  readonly external_updated_at: string | null;
  readonly deleted_at: string | null;
}

export function feishuCalendarCapabilityDeclarations():
  readonly CitizenDeclaration[];
export function feishuCalendarSchemaDocuments():
  ReadonlyMap<string, unknown>;
```

- [ ] **Step 1: Write failing declaration and URI tests**

Assert exactly these capability IDs:

```ts
expect(feishuCalendarCapabilityDeclarations().map(
  (item) => item.declaration_id,
)).toEqual([
  "feishu.calendar.attendees.add",
  "feishu.calendar.attendees.remove",
  "feishu.calendar.event.create",
  "feishu.calendar.event.delete",
  "feishu.calendar.event.read",
  "feishu.calendar.event.update",
  "feishu.calendar.freebusy.query",
]);

expect(resources.calendar("x@y")).toBe("feishu://calendar/x%40y");
expect(resources.event("x@y", "event/1")).toBe(
  "feishu://calendar/x%40y/events/event%2F1",
);
expect(resources.parseEvent(
  "feishu://calendar/x%40y/events/event%2F1",
)).toEqual({ calendar_id: "x@y", event_id: "event/1" });
```

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-declarations.test.ts \
  packages/provider-feishu/test/calendar-validation.test.ts \
  packages/provider-feishu/test/calendar-resource-adapter.test.ts
```

Expected: FAIL because Calendar files and exports are absent.

- [ ] **Step 3: Define the seven contracts**

Use version `1.0.0`, asynchronous interaction, typed-facts-only output and:

| Capability | Risk | Operation | Confirmation |
| --- | --- | --- | --- |
| freebusy.query | low | query | none |
| event.read | low | query | none |
| event.create | medium | command | none |
| event.update | medium | command | none |
| attendees.add | medium | command | none |
| attendees.remove | medium | command | none |
| event.delete | destructive | destructive | explicit |

Schema bounds:

```ts
const rfc3339 = { type: "string", format: "date-time", maxLength: 128 };
const resourceUri = { type: "string", format: "uri", maxLength: 2_048 };
const attendeeRefs = {
  type: "array",
  maxItems: 100,
  uniqueItems: true,
  items: {
    type: "string",
    pattern: "^feishu://(?:user/open-id|chat)/[^/]+$",
  },
};
```

Create requires selector, title, start, end, time zone and attendees. Update
requires event resource, expected Provider version and a non-empty field mask.
Delete requires event resource, expected Provider version and confirmation
proof reference. Free/busy accepts 1–100 user references and at most a
two-week range. When its user references came from an earlier Capability
Result, the input also carries:

```ts
authority_evidence: {
  capability_result_handoff_ids: ["handoff-members-result-1"],
}
```

The list is bounded, contains opaque auxiliary Handoff IDs only and is
security evidence rather than Provider business input. The Calendar executor
receives only the resulting Authority target refs; it does not load or
interpret Message results.

- [ ] **Step 4: Implement strict decoders and canonical resources**

Create a `FeishuCalendarResourceAdapter` that percent-encodes individual path
segments, rejects credentials/query/fragment, rejects duplicate decoding and
only accepts the four canonical URI shapes from the Spec.

Export decoders:

```ts
export function parseCalendarExecutionInput(
  capabilityId: string,
  input: Record<string, unknown>,
): CalendarExecutionInput;

export function assertCalendarTimeRange(input: {
  readonly start_at: string;
  readonly end_at: string;
  readonly maximum_span_ms: number;
}): void;
```

Use `Intl.supportedValuesOf("timeZone")` or an equivalent `Intl.DateTimeFormat`
construction to reject unknown IANA time zones. Reject unknown fields,
untrimmed strings, invalid URI forms, duplicate attendees, `start >= end`,
free/busy spans over 14 days and more than 100 participants.

- [ ] **Step 5: Merge Calendar schemas without changing existing digests**

`feishuSchemaDocuments()` must return existing Message/Document/Context schema
documents plus Calendar documents. Existing schema URIs and digests must remain
byte-for-byte stable.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-declarations.test.ts \
  packages/provider-feishu/test/calendar-validation.test.ts \
  packages/provider-feishu/test/calendar-resource-adapter.test.ts \
  packages/provider-feishu/test/schema-registry.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): define calendar capability contracts"
```

### Task 3: Add Calendar registry, execution checkpoints and event ownership

**Files:**
- Create: `packages/provider-feishu/src/calendar-memory-store.ts`
- Create: `packages/provider-feishu/src/calendar-sqlite-store.ts`
- Modify: `packages/provider-feishu/src/calendar-contracts.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/calendar-store-contract.ts`
- Test: `packages/provider-feishu/test/calendar-memory-store.test.ts`
- Test: `packages/provider-feishu/test/calendar-sqlite-store.test.ts`

**Interfaces:**
- Consumes: normalized calendar/event records from Task 2.
- Produces:

```ts
export interface FeishuCalendarStore
  extends FeishuCalendarRegistry,
    FeishuCalendarExecutionStore,
    FeishuCalendarEventStore {
  close(): Promise<void>;
}

export interface CalendarExecutionRecord {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input_digest: `sha256:${string}`;
  readonly state:
    | "started"
    | "event_created"
    | "attendees_applied"
    | "completed";
  readonly event_resource_uri: string | null;
  readonly outcome: CapabilityExecutionResult | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
```

- [ ] **Step 1: Write one reusable store contract and RED tests**

The contract must prove:

```ts
const first = await store.bind(binding({ alias: "team", is_default: true }), 0);
await expect(store.bind(binding({ alias: "team" }), 0))
  .rejects.toThrow("calendar_binding_version_conflict");
expect(await store.getDefault("tenant-1")).toEqual(first);

const begun = await store.beginExecution(execution());
expect(begun.created).toBe(true);
await store.checkpoint({
  tenant_id: "tenant-1",
  idempotency_key: "idem-1",
  expected_version: begun.record.version,
  state: "event_created",
  event_resource_uri: "feishu://calendar/c/events/e",
});
```

Also test tenant isolation, deterministic alias pagination, only one default,
input digest conflict, checkpoint CAS, restart persistence, ownership
idempotency, version increment and deletion tombstone replay.

- [ ] **Step 2: Run both adapter tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-memory-store.test.ts \
  packages/provider-feishu/test/calendar-sqlite-store.test.ts
```

- [ ] **Step 3: Implement the serialized memory adapter**

Use one promise tail for mutation serialization, clone every input/output and
index records by JSON-encoded tenant/key tuples. `setDefault` must atomically
clear the old default and mark the expected alias version.

- [ ] **Step 4: Implement additive SQLite tables**

Create strict tables:

```sql
CREATE TABLE IF NOT EXISTS feishu_calendar_bindings (
  tenant_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  resource_uri TEXT NOT NULL,
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (tenant_id, alias),
  UNIQUE (tenant_id, resource_uri)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  feishu_calendar_one_default
ON feishu_calendar_bindings (tenant_id)
WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS feishu_calendar_executions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (tenant_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS feishu_calendar_events (
  tenant_id TEXT NOT NULL,
  event_resource_uri TEXT NOT NULL,
  create_idempotency_key TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (tenant_id, event_resource_uri),
  UNIQUE (tenant_id, create_idempotency_key)
) STRICT;
```

Use transactions for default changes, execution checkpoints and ownership
updates. Reject checksum-incompatible existing records instead of rewriting
them.

- [ ] **Step 5: Verify restart and concurrency behavior**

Open a file-backed store, write records, close, reopen and compare all facts.
Run two concurrent default updates and prove one wins by expected version. Run
two identical execution begins and prove one record; reuse the key with a new
digest and prove conflict.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-memory-store.test.ts \
  packages/provider-feishu/test/calendar-sqlite-store.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): persist calendar provider state"
```

### Task 4: Implement the bounded Feishu Calendar v4 backend

**Files:**
- Modify: `packages/provider-feishu/src/openapi-backend.ts`
- Create: `packages/provider-feishu/src/calendar-openapi-backend.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/calendar-openapi-backend.test.ts`

**Interfaces:**
- Consumes: exported `FeishuOpenApiRequestClient`, credential/token provider,
  Calendar backend contracts and resource adapter.
- Produces:

```ts
export class FeishuCalendarOpenApiBackend
  implements FeishuCalendarBackend {
  getCalendar(input: GetCalendarInput): Promise<CalendarFacts>;
  createSharedCalendar(input: CreateSharedCalendarInput):
    Promise<CalendarFacts>;
  queryFreeBusy(input: QueryFreeBusyInput): Promise<FreeBusyFacts>;
  createEvent(input: CreateCalendarEventInput): Promise<EventFacts>;
  readEvent(input: ReadCalendarEventInput): Promise<EventFacts>;
  updateEvent(input: UpdateCalendarEventInput): Promise<EventFacts>;
  addAttendees(input: MutateAttendeesInput):
    Promise<AttendeeMutationFacts>;
  removeAttendees(input: MutateAttendeesInput):
    Promise<AttendeeMutationFacts>;
  deleteEvent(input: DeleteCalendarEventInput): Promise<DeleteEventFacts>;
}
```

- [ ] **Step 1: Write request/response mapping tests first**

Use a deterministic fake fetch queue and assert these endpoints:

```text
GET    /open-apis/calendar/v4/calendars/{calendar_id}
POST   /open-apis/calendar/v4/calendars
POST   /open-apis/calendar/v4/freebusy/batch?user_id_type=open_id
POST   /open-apis/calendar/v4/calendars/{calendar_id}/events
GET    /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}
PATCH  /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}
POST   /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees
DELETE /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees
DELETE /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}
```

Verify create query includes a deterministic 64-character idempotency key and
`user_id_type=open_id`.

- [ ] **Step 2: Run backend tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-openapi-backend.test.ts
```

- [ ] **Step 3: Export and reuse the bounded request client**

Export `FeishuOpenApiRequestClient` from the existing backend without changing
document behavior. Add one optional error classifier callback:

```ts
type FeishuErrorClassifier = (input: {
  readonly status: number;
  readonly code: number | string | null;
  readonly path: string;
}) => FeishuProviderBackendError | null;
```

Default behavior must remain identical for Message/Document tests. Calendar
maps permission, not-found, version, rate-limit and temporary errors to stable
Calendar Provider codes.

- [ ] **Step 4: Implement free/busy chunking**

```ts
for (let offset = 0; offset < input.user_open_ids.length; offset += 10) {
  chunks.push(input.user_open_ids.slice(offset, offset + 10));
}
```

Run at most three chunk requests concurrently, merge results in the original
user order and preserve per-user known failures. Reject more than 100 users or
more than 14 days before fetching.

- [ ] **Step 5: Implement event and attendee mappings**

Encode time using Feishu `time_info` fields and preserve the requested time
zone. Allow only schema fields declared in Task 2. For descriptions, treat
input as plain bounded text in phase 1 and do not inject HTML. Set
`need_notification` explicitly. Parse event URL, ID and updated timestamp into
bounded typed facts.

- [ ] **Step 6: Add ambiguous-write and response-bound tests**

Abort/timeout after a write request starts must produce
`external_outcome_unknown` with `retryable: false`. A 429 before a known write
acceptance is `feishu_rate_limited` and retryable. 401 refreshes once. 403 is
`feishu_permission_denied`. Oversized or malformed responses are bounded and
never logged.

- [ ] **Step 7: Run all existing and Calendar backend tests**

```bash
npx vitest run \
  packages/provider-feishu/test/openapi-backend.test.ts \
  packages/provider-feishu/test/calendar-openapi-backend.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): implement calendar openapi backend"
```

### Task 5: Implement Calendar query/read execution with Authority

**Files:**
- Create: `packages/provider-feishu/src/calendar-executor.ts`
- Modify: `packages/provider-feishu/src/execution-adapter.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/calendar-executor-query.test.ts`
- Test: `packages/provider-feishu/test/execution-adapter.test.ts`

**Interfaces:**
- Consumes: Task 2 decoders, Task 3 store, Task 4 backend and existing
  Capability execution adapter.
- Produces:

```ts
export class FeishuCalendarCapabilityExecutor
  implements FeishuCapabilityExecutorLike {
  constructor(input: {
    readonly citizen_id: string;
    readonly endpoint_id: string;
    readonly backend: FeishuCalendarBackend;
    readonly store: FeishuCalendarStore;
    readonly confirmation: FeishuConfirmationVerifier;
    readonly clock?: () => string;
  });
  execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome>;
}
```

- [ ] **Step 1: Write Authority and free/busy RED tests**

```ts
await expect(executor.execute(calendarRequest({
  capability_id: "feishu.calendar.freebusy.query",
  scopes: [],
}))).resolves.toMatchObject({
  outcome: "rejected",
  code: "scope_not_granted",
});

expect(await executor.execute(calendarRequest({
  capability_id: "feishu.calendar.freebusy.query",
  scopes: ["calendar:freebusy:read"],
  allowed_target_refs: ["feishu://user/open-id/ou_1"],
}))).toMatchObject({
  outcome: "succeeded",
  data: {
    provenance: { source: "feishu.calendar.freebusy" },
  },
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-executor-query.test.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
```

- [ ] **Step 3: Extend Authority evidence compatibly**

Accept optional `allowed_resource_refs` while preserving
`allowed_target_refs`, `confirmation_proof_refs` and `source_reference`:

```ts
export interface FeishuInvocationAuthority {
  readonly allowed_resource_refs: readonly string[];
  readonly allowed_target_refs: readonly string[];
  readonly confirmation_proof_refs: readonly string[];
  readonly source_reference?: RuntimeJsonObject;
}
```

Missing `allowed_resource_refs` normalizes to `[]` for existing Message and
Document requests.

- [ ] **Step 4: Implement selector, scope and target checks**

Resolve aliases only through the registry. The default selector must fail with
`calendar_not_registered` when no default exists. Require:

```ts
const REQUIRED_SCOPE = {
  "feishu.calendar.freebusy.query": "calendar:freebusy:read",
  "feishu.calendar.event.read": "calendar:event:read",
} as const;
```

Every user reference in free/busy must exist in `allowed_target_refs`. Event
read requires its canonical event URI in `allowed_resource_refs`.

- [ ] **Step 5: Implement typed query/read outcomes**

Free/busy returns coverage, one ordered participant result per requested user,
unresolved results and provenance. It never returns a selected slot. Event
read returns bounded event facts. Backend errors map through existing
rejected/failed conventions without conversational wording.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-executor-query.test.ts \
  packages/provider-feishu/test/execution-adapter.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): execute calendar query capabilities"
```

### Task 6: Implement idempotent Calendar writes and recovery

**Files:**
- Modify: `packages/provider-feishu/src/calendar-executor.ts`
- Modify: `packages/provider-feishu/src/calendar-contracts.ts`
- Test: `packages/provider-feishu/test/calendar-executor-command.test.ts`
- Test: `packages/provider-feishu/test/calendar-executor-recovery.test.ts`

**Interfaces:**
- Consumes: execution checkpoints and event ownership from Task 3.
- Produces complete command behavior for create/update/attendee/delete.

- [ ] **Step 1: Write create replay and recovery RED tests**

```ts
const first = await executor.execute(createRequest);
const replay = await executor.execute(createRequest);
expect(first).toEqual(replay);
expect(backend.createEvent).toHaveBeenCalledTimes(1);

store.failAfterCheckpoint("event_created");
await expect(executor.execute(createRequest)).rejects.toThrow();
store.resume();
const resumed = await executor.execute(createRequest);
expect(backend.createEvent).toHaveBeenCalledTimes(1);
expect(backend.addAttendees).toHaveBeenCalledTimes(1);
expect(resumed).toMatchObject({
  outcome: "succeeded",
  data: { completion_state: "complete" },
});
```

- [ ] **Step 2: Run command tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-executor-command.test.ts \
  packages/provider-feishu/test/calendar-executor-recovery.test.ts
```

- [ ] **Step 3: Implement create checkpoints**

Execution sequence:

```text
started
  -> backend.createEvent(deterministic Feishu idempotency key)
  -> persist ownership
  -> checkpoint event_created + event_resource_uri
  -> backend.addAttendees(authorized targets)
  -> checkpoint attendees_applied
  -> complete typed outcome
```

Persist per-attendee outcomes. A fully known rejection yields
`outcome: succeeded` with `completion_state: partial`. Unknown write outcome
stops with non-retryable `external_outcome_unknown`; it is not completed or
replayed automatically.

- [ ] **Step 4: Implement update and attendee mutations**

Require Provider ownership, active state, expected Provider version and:

```ts
const WRITE_SCOPE = {
  "feishu.calendar.event.create": "calendar:event:write",
  "feishu.calendar.event.update": "calendar:event:write",
  "feishu.calendar.attendees.add": "calendar:attendee:write",
  "feishu.calendar.attendees.remove": "calendar:attendee:write",
} as const;
```

Read current Feishu state before update. Compare the last observed update
timestamp when present. Increment Provider version only after a known accepted
write. Duplicate add/remove operations return stable facts.

- [ ] **Step 5: Implement destructive delete proof consumption**

Require event ownership, active tombstone, expected version, delete scope,
Authority proof reference and:

```ts
const consumed = await confirmation.consume({
  tenant_id: request.tenant_id,
  human_actor_id: request.represented_actor_id,
  capability_id: "feishu.calendar.event.delete",
  event_resource_uri,
  normalized_input_digest,
  proof_reference,
});
```

If consumption fails, return `confirmation_invalid`. After Feishu accepts,
persist the tombstone before completing. A replay reads the stored deletion
result and never calls the backend.

- [ ] **Step 6: Cover conflict and ambiguous outcomes**

Tests must distinguish:

- `event_not_owned`;
- `event_version_conflict`;
- `external_concurrent_change`;
- `confirmation_required`;
- `confirmation_invalid`;
- retryable 429/5xx;
- non-retryable `external_outcome_unknown`; and
- a partial attendee result with the event URI preserved.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-executor-command.test.ts \
  packages/provider-feishu/test/calendar-executor-recovery.test.ts \
  packages/provider-feishu/test/calendar-executor-query.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/provider-feishu
git commit -m "feat(feishu): execute calendar write capabilities"
```

### Task 7: Compose and provision the Calendar Facet independently

**Files:**
- Modify: `packages/provider-feishu/src/config.ts`
- Modify: `examples/feishu-capability-provider/src/configuration.ts`
- Modify: `examples/feishu-capability-provider/src/composition.ts`
- Modify: `examples/feishu-capability-provider/src/provision.ts`
- Modify: `examples/feishu-capability-provider/src/main.ts`
- Test: `packages/provider-feishu/test/config.test.ts`
- Test: `examples/feishu-capability-provider/test/configuration.test.ts`
- Test: `examples/feishu-capability-provider/test/composition.test.ts`
- Test: `examples/feishu-capability-provider/test/provision.test.ts`

**Interfaces:**
- Consumes: `feishuCalendarCapabilityDeclarations`,
  `FeishuCalendarCapabilityExecutor`, Calendar backend/store and existing
  generic Citizen runtime.
- Produces:

```ts
export interface EnabledFeishuProviderFacet {
  readonly facet: "aggregate" | "message" | "document" | "calendar";
  readonly citizen: FeishuProviderCitizenConfig;
}
```

- [ ] **Step 1: Write Calendar Facet configuration RED tests**

```ts
expect(validateFeishuProviderConfig({
  ...facetedConfig(),
  calendar_citizen: {
    enabled: true,
    citizen_id: "citizen-feishu-calendar",
    principal_id: "principal-feishu-provider",
    actor_id: "actor-feishu-provider",
    endpoint_id: "endpoint-feishu-provider",
    registration_version: 1,
  },
})).toMatchObject({
  calendar_citizen: {
    enabled: true,
    citizen_id: "citizen-feishu-calendar",
  },
});
```

Also reject a duplicate Calendar/Message/Document/Context Citizen ID. A
disabled Calendar Facet must need no identity fields.

- [ ] **Step 2: Run configuration/composition tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/config.test.ts \
  examples/feishu-capability-provider/test/configuration.test.ts \
  examples/feishu-capability-provider/test/composition.test.ts \
  examples/feishu-capability-provider/test/provision.test.ts
```

- [ ] **Step 3: Extend configuration and provisioning**

Add `calendar_citizen` to new faceted configuration. For legacy aggregate
configuration, include Calendar declarations only when an explicit
compatibility flag is already present; do not silently alter old deployments.
For normal faceted configuration, Calendar is optional and independent.

Provision:

```ts
{
  citizen_kind: "capability-provider",
  allowed_declaration_namespaces: ["feishu"],
  maximum_risk: "destructive",
  administrative_state: "enabled",
}
```

Add the Calendar Citizen and all seven capabilities to the shared Endpoint
only when enabled.

- [ ] **Step 4: Compose independent Message/Document/Calendar routes**

Instantiate one Calendar store, backend and executor only for an enabled
Calendar Facet. Route `feishu.calendar.*` IDs to it. Message member lookup stays
on the Message route. Start and close Calendar Citizen through the existing
managed lifecycle list; one startup failure must roll back every started
Citizen, host and store.

- [ ] **Step 5: Verify dynamic declarations and health**

Assert health includes the Calendar Citizen ID only when enabled, session
declarations map each capability to its selected Citizen ID, and disabling
Calendar leaves existing Message/Document/Context snapshots unchanged.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/config.test.ts \
  examples/feishu-capability-provider/test/configuration.test.ts \
  examples/feishu-capability-provider/test/composition.test.ts \
  examples/feishu-capability-provider/test/provision.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/provider-feishu examples/feishu-capability-provider
git commit -m "feat(feishu): compose calendar provider citizen"
```

### Task 8: Add explicit calendar administration commands

**Files:**
- Create: `packages/provider-feishu/src/calendar-administration.ts`
- Create: `tools/feishu-calendar-admin.ts`
- Modify: `package.json`
- Test: `packages/provider-feishu/test/calendar-administration.test.ts`
- Test: `tools/feishu-calendar-admin.test.ts`

**Interfaces:**
- Consumes: Calendar registry/backend, Provider configuration and credential
  provider.
- Produces:

```ts
export interface FeishuCalendarAdministrationPort {
  bindExisting(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly external_calendar_id: string;
    readonly make_default: boolean;
    readonly operator_principal_id: string;
  }): Promise<CalendarBinding>;
  createAndBind(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly summary: string;
    readonly description?: string;
    readonly permissions: "private" | "show_only_free_busy" | "public";
    readonly make_default: boolean;
    readonly operator_principal_id: string;
  }): Promise<CalendarBinding>;
}
```

- [ ] **Step 1: Write bootstrap RED tests**

Verify `bindExisting` calls `getCalendar`, rejects non-primary/shared types,
rejects a role other than writer/owner and records the operator. Verify
`createAndBind` creates exactly one shared calendar on a known successful
response and sets the default by registry CAS.

- [ ] **Step 2: Run bootstrap tests and verify RED**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-administration.test.ts \
  tools/feishu-calendar-admin.test.ts
```

- [ ] **Step 3: Implement service with an administrative lease**

Acquire one state lease keyed by tenant and alias before external calls.
Identical completed binds replay. A timeout after shared-calendar create
returns `external_outcome_unknown`, releases no automatic retry and prints a
safe reconciliation instruction.

- [ ] **Step 4: Implement strict CLI parsing**

Commands:

```bash
npm run feishu-calendar:admin -- \
  bind-existing \
  --alias team \
  --calendar-id 'feishu.cn_x@group.calendar.feishu.cn' \
  --default

npm run feishu-calendar:admin -- \
  create-and-bind \
  --alias team \
  --summary '团队协作日历' \
  --permissions show_only_free_busy \
  --default

npm run feishu-calendar:admin -- list
```

Require `WORK_FABRIC_ENV_FILE`, `WORK_FABRIC_CONFIG` and
`WORK_FABRIC_ADMIN_PRINCIPAL_ID`. Never accept secrets as CLI flags. Output
only alias, canonical resource URI, type, role, default state and version.

- [ ] **Step 5: Run CLI tests and typecheck**

```bash
npx vitest run \
  packages/provider-feishu/test/calendar-administration.test.ts \
  tools/feishu-calendar-admin.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/provider-feishu tools/feishu-calendar-admin.ts package.json
git commit -m "feat(feishu): administer calendar bindings"
```

### Task 9: Authorize and teach the Daily Assistant to invoke Calendar

**Files:**
- Modify: `examples/agently-agent-runtime/src/local-invocation-authority.ts`
- Modify: `examples/agently-agent-runtime/src/capabilities.ts`
- Modify: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`
- Modify: `examples/agently-agent-runtime/test/agently-daily-assistant.e2e.test.ts`
- Modify: `runtimes/agently-worker/work_fabric_agently_runtime/worker.py`
- Modify: `runtimes/agently-worker/tests/test_worker.py`

**Interfaces:**
- Consumes: dynamic Capability Disclosure and Invocation Port; trusted Feishu
  source reference from the original Handoff.
- Produces Authority evidence for Message-members and Calendar invocations.

- [ ] **Step 1: Write Authority RED tests**

```ts
expect(authority.forCapability({
  capability_id: "feishu.calendar.freebusy.query",
  original: feishuGroupHandoff(),
  input: {
    participants: [
      "feishu://user/open-id/ou_1",
      "feishu://user/open-id/ou_2",
    ],
    authority_evidence: {
      capability_result_handoff_ids: ["handoff-members-result-1"],
    },
  },
})).toMatchObject({
  delegation_scopes: ["calendar:freebusy:read"],
  allowed_target_refs: [
    "feishu://user/open-id/ou_1",
    "feishu://user/open-id/ou_2",
  ],
});

expect(authority.forCapability({
  capability_id: "feishu.conversation.members.list",
  original: feishuGroupHandoff(),
})).toMatchObject({
  delegation_scopes: ["conversation:members:read"],
  allowed_target_refs: ["feishu://chat/chat-1"],
});
```

Also prove a non-Feishu/debug Handoff cannot manufacture a chat target.

- [ ] **Step 2: Run Agent tests and verify RED**

```bash
npx vitest run \
  examples/agently-agent-runtime/test/local-invocation-authority.test.ts \
  examples/agently-agent-runtime/test/agently-daily-assistant.e2e.test.ts
uv run --project runtimes/agently-worker pytest -q
```

- [ ] **Step 3: Add explicit scope mappings and trusted target derivation**

Map:

```ts
const OPERATION_SCOPE = {
  "feishu.conversation.members.list": "conversation:members:read",
  "feishu.calendar.freebusy.query": "calendar:freebusy:read",
  "feishu.calendar.event.read": "calendar:event:read",
  "feishu.calendar.event.create": "calendar:event:write",
  "feishu.calendar.event.update": "calendar:event:write",
  "feishu.calendar.attendees.add": "calendar:attendee:write",
  "feishu.calendar.attendees.remove": "calendar:attendee:write",
  "feishu.calendar.event.delete": "calendar:event:delete",
} as const;
```

Derive the current chat only from the signed/authorized original source
reference. Carry user refs from a preceding members Capability Result only
through a verified evidence chain. For every evidence Handoff, load it through
the existing public Query port and prove:

1. tenant equality;
2. canonical
   `workfabric.dev/original_handoff_id === request.original_handoff_id`;
3. a bound `feishu.conversation.members.list` target;
4. a successful `urn:work-fabric:schema:capability-result:1` payload; and
5. containment of every requested user resource reference.

Only then copy those refs into `allowed_target_refs`. Missing, cross-Handoff,
failed, wrong-capability or tampered evidence is denied. This is an Agent
Authority policy rule; Message and Calendar Citizens remain unaware of each
other.

Calendar aliases resolve only through the Provider registry. A default
selector is authorized by the calendar operation scope plus that trusted
registry; explicit calendar/event resource references require
`allowed_resource_refs`. Provider-owned event mutations additionally require
the stored initiating Actor to match `represented_actor_id`. Raw IDs created
by the model are never accepted.

- [ ] **Step 4: Teach the worker the multi-capability flow**

The worker instruction must express:

```text
For “current group” availability:
1. call feishu.conversation.members.list until the bounded group is complete;
2. call feishu.calendar.freebusy.query with returned user resource refs and
   the members-result auxiliary Handoff IDs as authority evidence;
3. choose a slot only from returned facts;
4. call feishu.calendar.event.create with the authorized chat attendee;
5. report complete/partial/failed facts and include event URL when present.
```

Do not hard-code a Feishu implementation in Agent Host or transport protocol.
The worker still uses dynamic summaries and schemas. It asks the user for
missing date, duration or time zone instead of guessing.

- [ ] **Step 5: Add deterministic worker and continuation tests**

Fake-model fixtures must issue member-list, free/busy and create calls in
sequence. Assert typed results from each auxiliary Handoff return to the same
run and final output is `text/markdown` with the event link. A Provider failure
must produce an honest semantic failure.

- [ ] **Step 6: Run full Agent verification**

```bash
npm run verify:agent-runtime
```

- [ ] **Step 7: Commit**

```bash
git add examples/agently-agent-runtime runtimes/agently-worker
git commit -m "feat(agent): invoke feishu calendar capabilities"
```

### Task 10: Configure and document local Calendar operation

**Files:**
- Modify: `examples/config/local-feishu-assistant.bundle.yaml`
- Modify: `examples/config/README.md`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/guides/feishu-collaboration-channel.md`
- Modify: `examples/feishu-connector/README.md`
- Modify: `docs/architecture/network-citizens.md`
- Modify: `README.md`
- Test: `examples/agently-agent-runtime/test/documentation-contract.test.ts`
- Test: `examples/feishu-capability-provider/test/configuration.test.ts`

**Interfaces:**
- Consumes: Calendar Facet config and administration CLI.
- Produces a runnable but disabled-by-default documented configuration.

- [ ] **Step 1: Write documentation/configuration contract RED tests**

Assert the canonical bundle contains:

```yaml
calendar_citizen:
  enabled: true
  citizen_id: citizen-feishu-calendar
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
```

Assert Work Fabric provisions/reads the Calendar Citizen and authority rules
for its session/declarations. Assert inbound delegation includes only the
calendar scopes intended for the trusted internal-member policy.

- [ ] **Step 2: Run contract tests and verify RED**

```bash
npx vitest run \
  examples/agently-agent-runtime/test/documentation-contract.test.ts \
  examples/feishu-capability-provider/test/configuration.test.ts
```

- [ ] **Step 3: Update the local bundle**

Add Calendar Citizen provisioning/read/session Authority records, enable the
Calendar Facet and add:

```yaml
delegation:
  scopes:
    - conversation:members:read
    - calendar:freebusy:read
    - calendar:event:read
    - calendar:event:write
    - calendar:attendee:write
    - calendar:event:delete
```

Deletion still requires independent confirmation proof and therefore remains
fail-closed in local application-identity mode unless a verifier is configured.
Do not place calendar IDs in YAML.

- [ ] **Step 4: Document permissions and bootstrap**

Document exact Feishu scopes:

```text
im:chat.members:read
calendar:calendar:create
calendar:calendar:read
calendar:calendar.event:create
calendar:calendar.event:read
calendar:calendar.event:update
calendar:calendar.event:delete
calendar:calendar.free_busy:read
```

Explain bot membership in the target group, application writer/owner calendar
role, the two administration commands, no-domain requirement, event ownership,
partial attendee results, deletion confirmation and OAuth deferral.

- [ ] **Step 5: Update architecture boundaries**

Record that Message owns group expansion, Calendar owns calendar operations,
Agent owns cross-capability sequencing and semantic replies, and Integration is
only a virtual grouping. Update roadmap/status only when tests in Task 11 pass.

- [ ] **Step 6: Run docs/config tests and typecheck**

```bash
npx vitest run \
  examples/agently-agent-runtime/test/documentation-contract.test.ts \
  examples/feishu-capability-provider/test/configuration.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add \
  examples/config \
  docs \
  README.md \
  examples/feishu-connector/README.md
git commit -m "docs(feishu): document calendar provider operation"
```

### Task 11: Prove deterministic end-to-end scheduling and release gates

**Files:**
- Modify: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `examples/agently-agent-runtime/test/feishu-long-connection.e2e.test.ts`
- Create: `packages/service-node/test/feishu-calendar-assistant.e2e.test.ts`
- Modify: `tools/local-feishu-stack.test.ts`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: complete Message/Calendar/Agent paths from Tasks 1–10.
- Produces release evidence for one trusted group schedule without real
external dependencies.

- [ ] **Step 1: Write the end-to-end RED test**

The test must run:

```text
Feishu group ingress
-> Intake Handoff
-> Daily Assistant accept
-> Message member auxiliary Handoff
-> Calendar free/busy auxiliary Handoff
-> Calendar create auxiliary Handoff
-> Agent Markdown Result
-> Feishu Channel post renderer
```

The fake Feishu server returns 3 human group members, busy intervals leaving
one common hour and an accepted event/group-attendee result.

- [ ] **Step 2: Run the E2E test and verify RED**

```bash
npx vitest run \
  packages/service-node/test/feishu-calendar-assistant.e2e.test.ts
```

Expected: FAIL at the first missing Calendar composition/Agent behavior.

- [ ] **Step 3: Complete deterministic fixture wiring**

Use real SQLite adapters, Connector worker, Exchange, Capability Handoffs,
Network Citizen sessions, Agent Runtime Host and Signal dispatcher. Replace
only Feishu/OpenAI external HTTP with deterministic local fixtures. Assert:

```ts
expect(observed.capabilities).toEqual([
  "feishu.conversation.members.list",
  "feishu.calendar.freebusy.query",
  "feishu.calendar.event.create",
]);
expect(observed.external_event_creates).toBe(1);
expect(observed.attendee_mutations).toBe(1);
expect(finalResult).toMatchObject({
  media_type: "text/markdown",
});
expect(finalResult.text).toContain("https://");
```

- [ ] **Step 4: Prove replay and recovery**

Replay the same ingress and invocation keys. Stop/restart after event creation
but before attendees, then resume. Assert one external event, one effective
attendee mutation, one canonical final result and no duplicated notification.

- [ ] **Step 5: Run targeted feature suites**

```bash
npx vitest run \
  packages/provider-feishu/test \
  examples/feishu-capability-provider/test \
  examples/agently-agent-runtime/test \
  packages/service-node/test/feishu-calendar-assistant.e2e.test.ts
npm run agent-runtime:test-python
```

- [ ] **Step 6: Run repository release gates**

```bash
npm run typecheck
npm test
npm run conformance
npm run check:plugin-boundaries
npm run check:sensitive-observability
git diff --check
```

Expected: every command exits 0, no skipped Calendar acceptance test, no
boundary or sensitive-observability violation.

- [ ] **Step 7: Update completion status and commit**

Only after Step 6 passes, mark the Calendar phase complete in
`docs/roadmap.md`, record deterministic E2E evidence and commit:

```bash
git add packages examples runtimes tools docs package.json README.md
git commit -m "test(feishu): verify calendar assistant end to end"
```

### Task 12: Run a manually authorized real Feishu smoke test

**Files:**
- No canonical code changes unless the smoke test finds a reproducible defect.
- Temporary resolved configuration and test requests live under `/private/tmp`
  with mode `0600`.

**Interfaces:**
- Consumes: real Feishu application scopes, bot in the test group, local
  environment file and a dedicated test calendar binding.
- Produces one visible test event and one Feishu reply for user inspection.

- [ ] **Step 1: Verify permissions without printing credentials**

Load the environment file, obtain a tenant token in memory and call safe
read-only calendar/group endpoints. Print only scope/result codes, bot group
membership, calendar type and application role.

- [ ] **Step 2: Create or bind the dedicated test calendar**

Use:

```bash
npm run feishu-calendar:admin -- \
  create-and-bind \
  --alias calendar-smoke \
  --summary 'Work Fabric 日历联调' \
  --permissions show_only_free_busy \
  --default
```

If the external create outcome is unknown, list calendars, identify the
dedicated name and use `bind-existing`; do not repeat create blindly.

- [ ] **Step 3: Start the local Feishu stack**

```bash
WORK_FABRIC_ENV_FILE=/Users/bottleliu/work/git/agently/work-fabric/feishu.env \
WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml" \
npm run local:feishu:start
```

Verify service, Provider, Daily Assistant, Message/Document/Calendar Citizens
and default calendar binding are healthy.

- [ ] **Step 4: Send one explicit test request**

Use a dedicated group and a bounded request such as:

```text
@AI助理 请在明天下午 14:00–17:00 找一个群内三位测试成员都空闲的 30 分钟，
创建“Work Fabric 日历联调”日程并邀请当前群。
```

Do not test deletion or broad employee targeting in the real smoke.

- [ ] **Step 5: Verify durable and external facts**

Confirm:

- one ingress completes;
- one original Handoff returns a semantic result;
- Message members, free/busy and create each use one auxiliary Handoff;
- one Provider-owned event exists;
- the current group is an attendee;
- Agent reply is a native Feishu `post` with a clickable event link; and
- each delivery attempt is accepted once.

- [ ] **Step 6: Stop and clean sensitive temporary state**

Stop the local stack, remove resolved configuration and temporary request
files, retain the visible test event for user inspection, and report its event
resource URI without exposing credentials or raw participant identifiers.
