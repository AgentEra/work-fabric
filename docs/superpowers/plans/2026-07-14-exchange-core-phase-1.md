# Exchange Core Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transport-free Exchange Core reference implementation that proves WFPP Handoff correctness, pluggable SPI semantics, atomic in-memory persistence, deterministic replay, reliable projections, and at-least-once signal delivery.

**Architecture:** WFPP JSON Schemas remain the public protocol source of truth. `exchange-spi` exposes technology-neutral semantic ports; `exchange-core` implements the event-sourced Handoff domain and command application; `adapter-storage-memory` is the executable persistence reference; `exchange-runtime` consumes committed partition journals for projections and signals. External execution, PostgreSQL, HTTP, Feishu, A2A, MCP, Agent Runtime, and Codex integration remain outside this plan.

**Tech Stack:** Node.js `>=22.20.0`, npm workspaces, TypeScript `7.0.2`, ES modules with `NodeNext`, Vitest `4.1.10`, Ajv `8.20.0`, ajv-formats `3.0.1`, tsx `4.23.1`, JSON Schema Draft 2020-12.

## Global Constraints

- [ ] Follow `docs/superpowers/specs/2026-07-14-exchange-core-design.md`; record any intentional deviation in that specification before implementation.
- [ ] Preserve WFPP `spec_version` `1.0`, `snake_case` wire fields, lower-snake-case enums, and closed schemas with explicit `extensions`.
- [ ] Keep `Principal`, `Actor`, and `Endpoint` distinct; Payload cannot authenticate a Principal.
- [ ] Keep Handoff as the only authoritative responsibility aggregate; Assignment, latest status, inbox, and relation graph are projections.
- [ ] Keep external Work Items, Context bodies, Agent execution, code execution, and professional verification outside Exchange Core.
- [ ] Use `message_id` for the current request and Tenant-scoped `idempotency_key` plus Canonical Payload Digest for idempotency.
- [ ] Use `expected_version` for existing Handoff mutations and reject silent concurrent overwrite.
- [ ] Guarantee stream ordering, atomic same-Partition multi-stream append, immutable committed events, and idempotency/event atomicity.
- [ ] Keep `partition_position` internal; WFPP `wfsequence` expresses resource order and Subscription Cursor remains opaque.
- [ ] Model external delivery as at-least-once; a repeated `event_id` is valid and consumers deduplicate it.
- [ ] Do not perform external I/O inside persistence transactions.
- [ ] Do not add PostgreSQL, HTTP servers, Feishu SDKs, brokers, Agent runtimes, workflow engines, or UI dependencies.
- [ ] Use strict TypeScript without `any`; use `unknown` plus narrowing at trust boundaries.
- [ ] Write a focused failing test before every implementation slice, confirm the expected failure, add only the minimal implementation, then run focused and regression verification before committing.
- [ ] Keep every task commit independently reviewable and leave the worktree clean after each commit.

---

## Target Repository Layout

```text
package.json
package-lock.json
tsconfig.json
protocol/
├── schemas/v1/handoff/
├── spec/interaction-payloads.json
└── conformance/fixtures/
packages/
├── protocol-runtime/
│   ├── package.json
│   ├── src/
│   └── test/
├── exchange-spi/
│   ├── package.json
│   ├── src/
│   └── test/
├── exchange-conformance/
│   ├── package.json
│   ├── src/
│   └── test/
├── adapter-storage-memory/
│   ├── package.json
│   ├── src/
│   └── test/
├── adapter-identity-local/
├── adapter-context-memory/
├── adapter-signal-in-process/
├── exchange-core/
│   ├── package.json
│   ├── src/domain/
│   ├── src/application/
│   └── test/
└── exchange-runtime/
    ├── package.json
    ├── src/projection/
    ├── src/subscription/
    └── test/
```

## Stable Type and Dependency Map

```text
WFPP schemas ──loaded by──> @work-fabric/protocol-runtime ──> exchange-core

@work-fabric/exchange-spi
    ├── persistence/event contracts
    ├── identity/authority contracts
    ├── context contract
    ├── signal contract
    └── runtime state contracts
        ↓
@work-fabric/exchange-core ──> @work-fabric/exchange-runtime

Adapters ──depend only on──> exchange-spi
Conformance ──tests public contracts of──> protocol-runtime / SPI / Core / Runtime
```

The exact public names introduced below are stable within Phase 1. Later tasks must import them rather than creating aliases with different field names.

---

### Task 1: Close WFPP Handoff Payload and Context Schema Gaps

**Files:**

- Modify: `protocol/schemas/v1/handoff/handoff-snapshot.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-reference.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-cancel-command.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-status-command.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-result-command.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-verification-command.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-rework-command.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-transfer-command.schema.json`
- Create: `protocol/spec/interaction-payloads.json`
- Modify: `protocol/spec/interactions.md`
- Modify: `protocol/README.md`
- Modify: `protocol/conformance/fixtures/positive/core-schemas.json`
- Modify: `protocol/conformance/fixtures/negative/core-schemas.json`
- Modify: `tools/conformance/test/handoff-schemas.test.ts`
- Create: `tools/conformance/test/interaction-payloads.test.ts`

**Interfaces:**

- Consumes: existing `CommandEnvelope.message_type`, Handoff Offer, Status Update, Result Submission, Content Part, Evidence, and opaque ID definitions.
- Produces: normative `message_type -> payload_schema_id` mapping and closed payload schemas used by Task 9's `ProtocolCommandDecoder`.

- [ ] **Step 1: Add failing Context null-pair tests**

Extend the existing `HandoffSnapshot` test with a complete valid snapshot factory and these assertions:

```ts
function snapshot(context: {
  readonly context_bundle_id: string | null;
  readonly context_bundle_version: number | null;
}): unknown {
  return {
    handoff_id: "handoff_42",
    thread_id: "thread_01",
    resource_version: 1,
    lifecycle_state: "offered",
    current_responsible_actor: {
      actor_id: "actor_human_01",
      actor_type: "human",
    },
    package: {
      work_reference: offer.work_reference,
      target: offer.target,
      intent: offer.intent,
      ...context,
      authority_scope_id: "authority_01",
      acceptance_criteria_ids: ["tests-pass"],
      verifier_actor_id: "actor_pm_01",
      accept_by: "2026-07-13T09:00:00Z",
      result_due_at: "2026-07-14T08:00:00Z",
    },
    latest_status: null,
    result: null,
    parent_handoff_id: null,
    created_at: "2026-07-13T07:55:00Z",
    updated_at: "2026-07-13T08:00:00Z",
    extensions: {},
  };
}

it("allows an absent Context only as a null ID/version pair", () => {
  const withoutContext = snapshot({
    context_bundle_id: null,
    context_bundle_version: null,
  });
  expect(errors("handoff-snapshot", withoutContext)).toBeNull();

  expect(
    errors(
      "handoff-snapshot",
      snapshot({ context_bundle_id: "context_01", context_bundle_version: null }),
    ),
  ).not.toBeNull();
  expect(
    errors(
      "handoff-snapshot",
      snapshot({ context_bundle_id: null, context_bundle_version: 1 }),
    ),
  ).not.toBeNull();
});
```

- [ ] **Step 2: Add the failing interaction payload registry test**

Create `tools/conformance/test/interaction-payloads.test.ts`. Load `protocol/spec/interaction-payloads.json`, assert that every public Handoff interaction except internal `handoff.child_accepted` has one mapping, resolve every Schema ID through `loadSchemaRegistry`, and validate these exact minimal instances:

```ts
import { readFile } from "node:fs/promises";

interface NamedFixture {
  readonly name: string;
  readonly instance: unknown;
}

const fixtures = JSON.parse(
  await readFile("protocol/conformance/fixtures/positive/core-schemas.json", "utf8"),
) as readonly NamedFixture[];

function fixture(name: string): unknown {
  const found = fixtures.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(found.instance);
}

const validOffer = fixture("valid handoff offer");
const validStatusUpdate = fixture("valid status update");
const validResultSubmission = fixture("valid result submission");

const validPayloads: Readonly<Record<string, unknown>> = {
  "workfabric.handoff.offer.v1": validOffer,
  "workfabric.handoff.accept.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.decline.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.expire.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.cancel.v1": {
    handoff_id: "handoff_01",
    reason: [{ kind: "text", media_type: "text/plain", text: "Cancelled" }],
  },
  "workfabric.handoff.report_status.v1": {
    handoff_id: "handoff_01",
    status: validStatusUpdate,
  },
  "workfabric.handoff.return_result.v1": {
    handoff_id: "handoff_01",
    result: validResultSubmission,
  },
  "workfabric.handoff.verify.v1": {
    handoff_id: "handoff_01",
    satisfied_criterion_ids: ["tests-pass"],
    summary: [{ kind: "text", media_type: "text/plain", text: "Verified" }],
    evidence: [],
  },
  "workfabric.handoff.close.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.request_rework.v1": {
    handoff_id: "handoff_01",
    criterion_ids: ["tests-pass"],
    reason: [{ kind: "text", media_type: "text/plain", text: "Fix tests" }],
  },
  "workfabric.handoff.transfer.v1": {
    parent_handoff_id: "handoff_01",
    child_offer: validOffer,
  },
};
```

Also assert that no mapping exists for `workfabric.handoff.child_accepted.v1` and that an unmapped message type is rejected.

- [ ] **Step 3: Run the focused tests and confirm the expected failures**

Run:

```bash
npx vitest run tools/conformance/test/handoff-schemas.test.ts tools/conformance/test/interaction-payloads.test.ts
```

Expected: FAIL because the null Context pair is rejected and `interaction-payloads.json` plus the new payload schemas do not exist.

- [ ] **Step 4: Make Context optional end-to-end**

Change both Snapshot package properties to accept their original type or `null`, then add an object-level `oneOf` that permits only both values or both nulls:

```json
"oneOf": [
  {
    "properties": {
      "context_bundle_id": { "type": "null" },
      "context_bundle_version": { "type": "null" }
    }
  },
  {
    "properties": {
      "context_bundle_id": {
        "$ref": "urn:work-fabric:schema:v1:definitions#/$defs/opaque_id"
      },
      "context_bundle_version": {
        "$ref": "urn:work-fabric:schema:v1:definitions#/$defs/resource_version"
      }
    }
  }
]
```

Retain both fields in the package `required` list so absence is represented explicitly by the null pair.

- [ ] **Step 5: Add the seven closed payload schemas**

Use JSON Schema Draft 2020-12, `additionalProperties: false`, and these exact contracts:

```text
handoff-reference
  required: handoff_id

handoff-cancel-command
  required: handoff_id
  optional: reason: ContentPart[]

handoff-status-command
  required: handoff_id, status
  status: StatusUpdate

handoff-result-command
  required: handoff_id, result
  result: ResultSubmission

handoff-verification-command
  required: handoff_id, satisfied_criterion_ids, summary, evidence
  satisfied_criterion_ids: unique opaque IDs, minItems 1
  summary: ContentPart[], minItems 1
  evidence: unique Evidence[]

handoff-rework-command
  required: handoff_id, criterion_ids, reason
  criterion_ids: unique opaque IDs, minItems 1
  reason: ContentPart[], minItems 1

handoff-transfer-command
  required: parent_handoff_id, child_offer
  child_offer: HandoffOffer
```

Every schema has `extensions` using the shared extensions definition, but `extensions` remains optional for these command payloads.

- [ ] **Step 6: Add the normative interaction mapping**

Create this exact mapping structure in `protocol/spec/interaction-payloads.json`:

```json
{
  "spec_version": "1.0",
  "mappings": {
    "workfabric.handoff.offer.v1": "urn:work-fabric:schema:v1:handoff-offer",
    "workfabric.handoff.accept.v1": "urn:work-fabric:schema:v1:handoff-reference",
    "workfabric.handoff.decline.v1": "urn:work-fabric:schema:v1:handoff-reference",
    "workfabric.handoff.expire.v1": "urn:work-fabric:schema:v1:handoff-reference",
    "workfabric.handoff.cancel.v1": "urn:work-fabric:schema:v1:handoff-cancel-command",
    "workfabric.handoff.report_status.v1": "urn:work-fabric:schema:v1:handoff-status-command",
    "workfabric.handoff.return_result.v1": "urn:work-fabric:schema:v1:handoff-result-command",
    "workfabric.handoff.verify.v1": "urn:work-fabric:schema:v1:handoff-verification-command",
    "workfabric.handoff.close.v1": "urn:work-fabric:schema:v1:handoff-reference",
    "workfabric.handoff.request_rework.v1": "urn:work-fabric:schema:v1:handoff-rework-command",
    "workfabric.handoff.transfer.v1": "urn:work-fabric:schema:v1:handoff-transfer-command"
  }
}
```

Document that `handoff.child_accepted` is internal, index every new Schema ID in `protocol/README.md`, and add positive and negative fixtures for the null pair, verification, rework, and transfer contracts.

- [ ] **Step 7: Verify and commit the protocol closure**

Run:

```bash
npm run typecheck
npx vitest run tools/conformance/test/handoff-schemas.test.ts tools/conformance/test/interaction-payloads.test.ts
npm test
npm run conformance
```

Expected: TypeScript passes; all focused and regression tests pass; conformance reports every fixture passed.

Commit:

```bash
git add protocol tools/conformance/test
git commit -m "feat(protocol): complete handoff command payloads"
```

---

### Task 2: Bootstrap Workspaces and Stable SPI Foundations

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `packages/exchange-spi/package.json`
- Create: `packages/exchange-spi/src/json.ts`
- Create: `packages/exchange-spi/src/capabilities.ts`
- Create: `packages/exchange-spi/src/index.ts`
- Create: `packages/exchange-spi/test/capabilities.test.ts`

**Interfaces:**

- Consumes: Node/TypeScript versions and module conventions from the root project.
- Produces: `JsonValue`, `JsonObject`, `CapabilityManifest`, `CapabilityRequirement`, and `assertCapabilities` for every later package.

- [ ] **Step 1: Write the failing capability test**

```ts
import { describe, expect, it } from "vitest";

import {
  assertCapabilities,
  type CapabilityManifest,
} from "../src/index.js";

const manifest: CapabilityManifest = {
  profile: "exchange.persistence.v1",
  adapter: "memory",
  capabilities: {
    atomic_multi_stream_append: true,
    partitioned_journal: true,
    immutable_events: true,
  },
};

describe("CapabilityManifest", () => {
  it("accepts an adapter that satisfies every required capability", () => {
    expect(() =>
      assertCapabilities(manifest, [
        "atomic_multi_stream_append",
        "partitioned_journal",
      ]),
    ).not.toThrow();
  });

  it("rejects a missing or false required capability", () => {
    expect(() =>
      assertCapabilities(manifest, ["tenant_isolation"]),
    ).toThrow("Missing required capability: tenant_isolation");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm package resolution fails**

Run:

```bash
npx vitest run packages/exchange-spi/test/capabilities.test.ts
```

Expected: FAIL because `packages/exchange-spi` and its exports do not exist.

- [ ] **Step 3: Configure npm workspaces without changing dependency versions**

Add `"workspaces": ["packages/*"]` to the root package and extend TypeScript `include` to:

```json
[
  "tools/**/*.ts",
  "packages/**/*.ts"
]
```

Create `packages/exchange-spi/package.json`:

```json
{
  "name": "@work-fabric/exchange-spi",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts"
}
```

Run `npm install` to refresh workspace links and `package-lock.json`; do not upgrade pinned dependencies.

- [ ] **Step 4: Implement JSON and capability primitives**

Use these exact public types and function:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface CapabilityManifest {
  readonly profile: string;
  readonly adapter: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export type CapabilityRequirement = readonly string[];

export interface ExchangeAdapter {
  readonly manifest: CapabilityManifest;
}

export function assertCapabilities(
  manifest: CapabilityManifest,
  required: CapabilityRequirement,
): void {
  for (const capability of required) {
    if (manifest.capabilities[capability] !== true) {
      throw new Error(`Missing required capability: ${capability}`);
    }
  }
}
```

Export both files from `src/index.ts` using `.js` specifiers.

- [ ] **Step 5: Verify and commit the workspace foundation**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-spi/test/capabilities.test.ts
npm test
```

Expected: focused test and all protocol regression tests pass.

Commit:

```bash
git add package.json package-lock.json tsconfig.json packages/exchange-spi
git commit -m "build: add exchange workspace foundation"
```

---

### Task 3: Define the Persistence and Runtime-State SPI

**Files:**

- Create: `packages/exchange-spi/src/events.ts`
- Create: `packages/exchange-spi/src/persistence.ts`
- Create: `packages/exchange-spi/src/runtime-state.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Create: `packages/exchange-spi/test/persistence-contract.test.ts`

**Interfaces:**

- Consumes: `JsonObject`, `JsonValue`, and `CapabilityManifest` from Task 2.
- Produces: `EventRecord`, `ProposedEvent`, `StreamAppend`, `AtomicCommitRequest`, `AtomicCommitResult`, `EventJournal`, `CommandDeduplication`, `ExchangeTransaction`, `SnapshotRepository`, `ProjectionCheckpointStore`, and `DeliveryStateStore`.

- [ ] **Step 1: Write failing contract-shape and capability tests**

Test that the required profile is frozen to this exact list and that an event record distinguishes stream order from partition order:

```ts
expect(PERSISTENCE_REQUIRED_CAPABILITIES).toEqual([
  "expected_stream_version",
  "ordered_streams",
  "atomic_multi_stream_append",
  "transactional_idempotency",
  "partitioned_journal",
  "immutable_events",
]);

const record: EventRecord = {
  event_id: "event_01",
  event_type: "workfabric.handoff.offered.v1",
  schema_version: "1.0",
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  partition_id: "partition_01",
  partition_position: 7,
  stream_id: "handoff_01",
  stream_version: 2,
  commit_id: "commit_01",
  commit_ordinal: 0,
  request_message_id: "message_01",
  idempotency_key: "offer-01",
  thread_id: "thread_01",
  handoff_id: "handoff_01",
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  visibility: "participants",
  visible_actor_ids: ["actor_01", "verifier_01"],
  visible_endpoint_ids: ["endpoint_01"],
  occurred_at: "2026-07-14T00:00:00Z",
  domain_data: { handoff_id: "handoff_01", lifecycle_state: "offered" },
  protocol_data: {
    resource_version: 2,
    change: { change_type: "created", from_state: null, to_state: "offered" },
    receipt: null,
  },
};

expect(record.stream_version).toBe(2);
expect(record.partition_position).toBe(7);
```

- [ ] **Step 2: Run the focused test and confirm missing exports**

Run:

```bash
npx vitest run packages/exchange-spi/test/persistence-contract.test.ts
```

Expected: FAIL because the persistence contracts are not exported.

- [ ] **Step 3: Define immutable event and commit types**

Implement these exact contracts in `events.ts` and `persistence.ts`:

```ts
export interface ProposedEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: "1.0";
  readonly exchange_id: string;
  readonly request_message_id: string;
  readonly idempotency_key: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly thread_id: string;
  readonly handoff_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly visibility: "tenant" | "participants" | "restricted" | "public";
  readonly visible_actor_ids: readonly string[];
  readonly visible_endpoint_ids: readonly string[];
  readonly occurred_at: string;
  readonly domain_data: JsonObject;
  readonly protocol_data: JsonObject;
}

export interface EventRecord extends ProposedEvent {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly partition_position: number;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly commit_id: string;
  readonly commit_ordinal: number;
}

export interface StreamAppend {
  readonly stream_id: string;
  readonly expected_version: number;
  readonly events: readonly ProposedEvent[];
}

export interface NormalizedOperationOutcome {
  readonly operation_status:
    | "accepted"
    | "rejected"
    | "conflict"
    | "temporarily_unavailable";
  readonly resource: JsonObject | null;
  readonly receipt: JsonObject | null;
  readonly error: JsonObject | null;
}

export interface AtomicCommitRequest {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly commit_id: string;
  readonly idempotency_key: string;
  readonly payload_digest: string;
  readonly request_message_id: string;
  readonly outcome: NormalizedOperationOutcome;
  readonly appends: readonly StreamAppend[];
}

export type AtomicCommitResult =
  | { readonly kind: "committed"; readonly events: readonly EventRecord[] }
  | { readonly kind: "replayed"; readonly outcome: NormalizedOperationOutcome }
  | { readonly kind: "idempotency_key_reused" }
  | {
      readonly kind: "version_conflict";
      readonly current_versions: Readonly<Record<string, number>>;
    };
```

Empty `appends` are allowed only for persisting deterministic eventless outcomes. A `temporarily_unavailable` outcome must never be persisted.

- [ ] **Step 4: Define semantic persistence ports**

```ts
export const PERSISTENCE_REQUIRED_CAPABILITIES = [
  "expected_stream_version",
  "ordered_streams",
  "atomic_multi_stream_append",
  "transactional_idempotency",
  "partitioned_journal",
  "immutable_events",
] as const;

export interface CommandRecord {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly payload_digest: string;
  readonly first_request_message_id: string;
  readonly outcome: NormalizedOperationOutcome;
}

export interface EventJournal {
  readStream(streamId: string, fromVersion?: number): Promise<readonly EventRecord[]>;
  readPartition(
    partitionId: string,
    afterPosition: number,
    limit: number,
  ): Promise<readonly EventRecord[]>;
}

export interface CommandDeduplication {
  findCommand(tenantId: string, idempotencyKey: string): Promise<CommandRecord | null>;
}

export interface ExchangeTransaction {
  commitAtomically(request: AtomicCommitRequest): Promise<AtomicCommitResult>;
}

export interface SnapshotRecord {
  readonly stream_id: string;
  readonly stream_version: number;
  readonly schema_version: string;
  readonly state: JsonObject;
}

export interface SnapshotRepository {
  loadSnapshot(streamId: string): Promise<SnapshotRecord | null>;
  saveSnapshot(snapshot: SnapshotRecord): Promise<void>;
  deleteSnapshot(streamId: string): Promise<void>;
}

export interface ExchangePersistence
  extends EventJournal,
    CommandDeduplication,
    ExchangeTransaction,
    SnapshotRepository {
  readonly manifest: CapabilityManifest;
}
```

- [ ] **Step 5: Define checkpoint, delivery, and dead-letter state ports**

`runtime-state.ts` must export:

```ts
export interface ProjectionCheckpointStore {
  loadProjectionCheckpoint(projectorId: string, partitionId: string): Promise<number>;
  advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  resetProjectionCheckpoint(projectorId: string, partitionId: string): Promise<void>;
}

export interface DeliveryAttempt {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly attempt: number;
  readonly attempted_at: string;
  readonly outcome: "accepted" | "retryable_failure" | "permanent_failure";
  readonly detail: string | null;
}

export interface DeadLetterRecord {
  readonly subscription_id: string;
  readonly event: EventRecord;
  readonly attempts: number;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface DeliveryStateStore {
  loadDeliveryPosition(subscriptionId: string, partitionId: string): Promise<number>;
  recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;
  advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  putDeadLetter(record: DeadLetterRecord): Promise<void>;
}
```

- [ ] **Step 6: Verify and commit the SPI contracts**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-spi/test/persistence-contract.test.ts
npm test
```

Expected: all tests pass with no adapter implementation imported by `exchange-spi`.

Commit:

```bash
git add packages/exchange-spi
git commit -m "feat(spi): define exchange persistence contracts"
```

---

### Task 4: Build the Persistence Conformance Suite and Memory Reference Adapter

**Files:**

- Create: `packages/exchange-conformance/package.json`
- Create: `packages/exchange-conformance/src/persistence-profile.ts`
- Create: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/persistence-profile.test.ts`
- Create: `packages/adapter-storage-memory/package.json`
- Create: `packages/adapter-storage-memory/src/memory-exchange-persistence.ts`
- Create: `packages/adapter-storage-memory/src/index.ts`
- Create: `packages/adapter-storage-memory/test/memory-exchange-persistence.test.ts`

**Interfaces:**

- Consumes: all persistence and runtime-state contracts from Task 3.
- Produces: `verifyPersistenceProfile(factory)` and `MemoryExchangePersistence`, the executable reference used by Core and Runtime tests.

- [ ] **Step 1: Write the failing Memory Adapter tests**

Create focused tests for one commit, replay, key reuse, version conflict, partition reading, snapshots, checkpoints, and returned-data immutability. The atomicity test must use this shape:

```ts
const result = await store.commitAtomically({
  tenant_id: "tenant_01",
  partition_id: "partition_01",
  commit_id: "commit_01",
  idempotency_key: "transfer-01",
  payload_digest: "sha256:transfer",
  request_message_id: "message_01",
  outcome: acceptedOutcome,
  appends: [
    { stream_id: "parent", expected_version: 1, events: [parentTransferred] },
    { stream_id: "child", expected_version: 1, events: [childAccepted] },
  ],
});

expect(result.kind).toBe("committed");
expect(await store.readStream("parent")).toHaveLength(2);
expect(await store.readStream("child")).toHaveLength(2);
```

Add a second commit where one expected version is wrong and assert that neither stream changes.

- [ ] **Step 2: Write the failing reusable profile test**

The adapter test must invoke the same exported verifier that third-party adapters will run:

```ts
it("passes exchange.persistence.v1", async () => {
  await expect(
    verifyPersistenceProfile(() => new MemoryExchangePersistence()),
  ).resolves.toBeUndefined();
});
```

Also create a deliberately non-conforming test double whose manifest sets `atomic_multi_stream_append` to `false`; assert that the verifier rejects it before behavior scenarios run.

- [ ] **Step 3: Run tests and confirm the packages are missing**

Run:

```bash
npx vitest run packages/adapter-storage-memory/test packages/exchange-conformance/test
```

Expected: FAIL because both workspace packages are absent.

- [ ] **Step 4: Implement the reusable persistence profile verifier**

Create package manifests depending only on `@work-fabric/exchange-spi`. Export:

```ts
export type ExchangePersistenceFactory = () => ExchangePersistence &
  ProjectionCheckpointStore &
  DeliveryStateStore;

export async function verifyPersistenceProfile(
  factory: ExchangePersistenceFactory,
): Promise<void>;
```

Use `node:assert/strict` and fresh stores per scenario. The function must execute all of these named scenarios and throw a message containing the scenario name on failure:

```text
required capabilities
single stream append and read
expected version conflict
same stream concurrent append has one winner
same key and same digest replays outcome
same key and different digest is rejected
multi-stream append is atomic
cross-partition stream append is rejected
partition positions are stable and increasing
stream versions are stable and increasing
failed transaction leaves no events or command record
returned values cannot mutate stored events
snapshot round trip and delete
projection checkpoint compare-and-advance and explicit reset
delivery position compare-and-advance
```

The verifier must not import the Memory Adapter or Vitest.

- [ ] **Step 5: Implement `MemoryExchangePersistence` with atomic staging**

The class implements `ExchangePersistence`, `ProjectionCheckpointStore`, and `DeliveryStateStore`. Use private Maps for streams, partitions, commands, snapshots, projection checkpoints, delivery positions, attempts, and dead letters.

Serialize commits with this exact lock pattern:

```ts
private commitTail: Promise<void> = Promise.resolve();

private async withCommitLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = this.commitTail.then(operation, operation);
  this.commitTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
```

Inside the lock, apply this order:

1. reject `temporarily_unavailable` outcomes;
2. check existing Tenant/idempotency key before versions;
3. return `replayed` for equal digest and `idempotency_key_reused` otherwise;
4. reject streams previously assigned to a different Partition;
5. collect every current stream version and return one `version_conflict` result if any mismatch;
6. build cloned `EventRecord` arrays in local variables, assigning contiguous Partition Positions and Stream Versions;
7. only after every validation succeeds, replace maps and record the command outcome;
8. return cloned committed records.

Use `structuredClone` on every value entering or leaving the adapter. Validate positive integer `limit`, non-negative positions/versions, unique stream IDs per commit, at least one event per `StreamAppend`, unique Event IDs, and zero-based `commit_ordinal` across the entire commit.

- [ ] **Step 6: Implement state-store methods**

Checkpoint and delivery advancement return `false` when the stored position differs from `expectedPosition`; they never move backwards. Add read-only test helpers for attempts and dead letters:

```ts
getDeliveryAttempts(): readonly DeliveryAttempt[];
getDeadLetters(): readonly DeadLetterRecord[];
```

These helpers are specific to the Memory Adapter and are not added to the SPI.

- [ ] **Step 7: Run focused, profile, concurrent, and regression tests**

Run:

```bash
npm run typecheck
npx vitest run packages/adapter-storage-memory/test packages/exchange-conformance/test
npm test
```

Expected: the Memory Adapter passes every profile scenario, including the one-winner concurrency and atomic rollback tests.

- [ ] **Step 8: Commit the reference persistence layer**

```bash
git add packages/exchange-conformance packages/adapter-storage-memory package-lock.json
git commit -m "feat(storage): add memory persistence reference"
```

---

### Task 5: Define Identity, Authority, Context, and Signal SPI with Local Adapters

**Files:**

- Create: `packages/exchange-spi/src/identity.ts`
- Create: `packages/exchange-spi/src/authority.ts`
- Create: `packages/exchange-spi/src/context.ts`
- Create: `packages/exchange-spi/src/signal.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Create: `packages/exchange-conformance/src/adapter-profiles.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/adapter-profiles.test.ts`
- Create: `packages/adapter-identity-local/package.json`
- Create: `packages/adapter-identity-local/src/local-identity-provider.ts`
- Create: `packages/adapter-identity-local/src/local-authority-policy.ts`
- Create: `packages/adapter-identity-local/src/index.ts`
- Create: `packages/adapter-identity-local/test/local-identity-authority.test.ts`
- Create: `packages/adapter-context-memory/package.json`
- Create: `packages/adapter-context-memory/src/memory-context-repository.ts`
- Create: `packages/adapter-context-memory/src/index.ts`
- Create: `packages/adapter-context-memory/test/memory-context-repository.test.ts`
- Create: `packages/adapter-signal-in-process/package.json`
- Create: `packages/adapter-signal-in-process/src/in-process-signal-adapter.ts`
- Create: `packages/adapter-signal-in-process/src/index.ts`
- Create: `packages/adapter-signal-in-process/test/in-process-signal-adapter.test.ts`

**Interfaces:**

- Consumes: `JsonObject`, `JsonValue`, and the Canonical `ProtocolEvent` contract from `exchange-spi`.
- Produces: stable identity, authority, context-availability, and single-delivery contracts; four reusable Profile verifiers; deterministic test adapters.

- [ ] **Step 1: Write failing human, Agent, system, fail-closed, Context, and Signal tests**

Cover these exact behaviors:

```text
known authentication evidence resolves one Principal
unknown authentication evidence is unauthenticated
one Runtime Principal may represent two configured Agent Actors
an unconfigured Actor representation is denied
human, agent, and system Actor types remain distinct
authority has no implicit allow rule
missing optional Context is available
known visible Context is available with matching digest
unknown, hidden, or digest-mismatched Context is unavailable
in-process signal preserves Event ID and destination
configured signal outcomes return retryable and permanent failures
```

- [ ] **Step 2: Run tests and confirm missing SPI exports**

Run:

```bash
npx vitest run packages/adapter-identity-local/test packages/adapter-context-memory/test packages/adapter-signal-in-process/test
```

Expected: FAIL because the interfaces and adapters do not exist.

- [ ] **Step 3: Add the exact identity and authority contracts**

```ts
export interface ResolvedPrincipal {
  readonly principal_id: string;
  readonly tenant_id: string;
  readonly actor_claims: readonly {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
    readonly endpoint_ids: readonly string[];
  }[];
  readonly attributes: JsonObject;
}

export interface IdentityProvider extends ExchangeAdapter {
  resolve(authenticationEvidence: JsonObject): Promise<ResolvedPrincipal | null>;
}

export interface AuthorityRequest {
  readonly principal: ResolvedPrincipal;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id: string;
  readonly delegation_id: string | null;
  readonly action: string;
  readonly resource_id: string | null;
}

export type AuthorityDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export interface AuthorityPolicy extends ExchangeAdapter {
  authorize(request: AuthorityRequest): Promise<AuthorityDecision>;
}
```

- [ ] **Step 4: Add Context and Signal contracts**

```ts
export interface ContextReference {
  readonly context_id: string;
  readonly version: number;
  readonly digest: string | null;
}

export interface ContextAccessRequest {
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly reference: ContextReference | null;
}

export type ContextAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ContextRepository extends ExchangeAdapter {
  putBundle(tenantId: string, bundle: JsonObject): Promise<ContextReference>;
  checkAvailability(request: ContextAccessRequest): Promise<ContextAvailability>;
}

export interface ProtocolEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly dataschema: string;
  readonly wftenant?: string;
  readonly wfexchange?: string;
  readonly wfthread?: string;
  readonly wfhandoff?: string;
  readonly wfactor?: string;
  readonly wfendpoint?: string;
  readonly wfcorrelation?: string;
  readonly wfcausation?: string;
  readonly wfsequence: number;
  readonly wfvisibility?: "tenant" | "participants" | "restricted" | "public";
  readonly data: JsonObject;
}

export interface SignalDestination {
  readonly destination_id: string;
  readonly binding: string;
  readonly configuration: JsonObject;
}

export type SignalDeliveryResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "retryable_failure"; readonly detail: string }
  | { readonly kind: "permanent_failure"; readonly detail: string };

export interface SignalAdapter extends ExchangeAdapter {
  deliver(event: ProtocolEvent, destination: SignalDestination): Promise<SignalDeliveryResult>;
}
```

- [ ] **Step 5: Implement deterministic local adapters**

`LocalIdentityProvider` receives immutable evidence-to-Principal records and exposes Profile `exchange.identity.v1`. `LocalAuthorityPolicy` receives explicit allow rules keyed by Tenant, Principal, Actor, Endpoint, action, and optional resource and exposes `exchange.authority.v1`. Missing evidence or rule denies; do not implement wildcard allow.

`MemoryContextRepository` stores cloned, validated WFPP Context Bundles by Tenant, Context ID, and Version. Normalize the wire Digest `{ algorithm, value }` to the `ContextReference.digest` string `<algorithm>:<value>` (for example `sha-256:abc123`); preserve `null` as `null`, and reject any other Digest shape. `putBundle` is idempotent for the same Digest and rejects a different body at the same version. A null reference returns `available`; every non-null reference must exist and match the normalized Digest when supplied. Visibility requires at least one declared audience; a non-empty Actor list must contain the Actor and a non-empty Endpoint list must contain the Endpoint.

`InProcessSignalAdapter` records cloned `{event, destination}` deliveries. For deterministic Profile fixtures, a Destination may use adapter-specific `configuration.outcome` (`accepted`, `retryable_failure`, or `permanent_failure`) and `configuration.detail`; these fields are not part of WFPP or the Signal SPI. The existing Event-specific outcome hook takes precedence. It exposes test-only methods:

```ts
setOutcome(eventId: string, result: SignalDeliveryResult): void;
deliveries(): readonly {
  readonly event: ProtocolEvent;
  readonly destination: SignalDestination;
}[];
```

Use these required Profile/capability pairs:

```text
exchange.identity.v1
  authenticated_principal, trusted_actor_claims, tenant_binding
exchange.authority.v1
  explicit_decision, default_deny, resource_scoping
exchange.context.v1
  immutable_versions, digest_verification, visibility_enforcement
exchange.signal.v1
  event_id_preservation, outcome_classification, payload_isolation
```

- [ ] **Step 6: Add reusable peripheral Adapter Profile verifiers**

Export these functions from `exchange-conformance`:

```ts
export interface IdentityProfileFixtures {
  readonly known_evidence: JsonObject;
  readonly unknown_evidence: JsonObject;
  readonly expected_principal: ResolvedPrincipal;
}

export interface AuthorityProfileFixtures {
  readonly allowed_request: AuthorityRequest;
  readonly denied_request: AuthorityRequest;
}

export interface ContextProfileFixtures {
  readonly tenant_id: string;
  readonly bundle: JsonObject;
  readonly allowed_request: ContextAccessRequest;
  readonly denied_request: ContextAccessRequest;
}

export interface SignalProfileFixtures {
  readonly event: ProtocolEvent;
  readonly accepted_destination: SignalDestination;
  readonly retryable_destination: SignalDestination;
  readonly permanent_destination: SignalDestination;
  readonly observe_deliveries: () => Promise<readonly {
    readonly event: ProtocolEvent;
    readonly destination: SignalDestination;
  }[]>;
}

export async function verifyIdentityProfile(
  adapter: IdentityProvider,
  fixtures: IdentityProfileFixtures,
): Promise<void>;

export async function verifyAuthorityProfile(
  adapter: AuthorityPolicy,
  fixtures: AuthorityProfileFixtures,
): Promise<void>;

export async function verifyContextProfile(
  adapter: ContextRepository,
  fixtures: ContextProfileFixtures,
): Promise<void>;

export async function verifySignalProfile(
  adapter: SignalAdapter,
  fixtures: SignalProfileFixtures,
): Promise<void>;
```

The shared scenarios verify, respectively: known/unknown evidence and Actor type preservation; explicit allow/default deny; immutable versioned Context plus visibility/digest checks; Event ID/Destination preservation through the Fixture's read-only Delivery Probe and all three delivery outcomes. The three Signal Destinations must be preconfigured by the Adapter test environment to produce their named outcomes; the verifier does not interpret Adapter-specific configuration. Each verifier first checks the exact Profile name and required capability booleans.

- [ ] **Step 7: Verify package dependency direction and all Adapter Profiles**

Run:

```bash
rg -n "adapter-|postgres|kafka|nats|feishu|http" packages/exchange-spi/src
```

Expected: no matches.

Then run:

```bash
npm run typecheck
npx vitest run packages/exchange-conformance/test/adapter-profiles.test.ts packages/adapter-identity-local/test packages/adapter-context-memory/test packages/adapter-signal-in-process/test
npm test
```

Expected: all focused and regression tests pass.

- [ ] **Step 8: Commit the peripheral SPI and adapters**

```bash
git add packages/exchange-spi packages/exchange-conformance packages/adapter-identity-local packages/adapter-context-memory packages/adapter-signal-in-process package-lock.json
git commit -m "feat(spi): add local exchange adapters"
```

---

### Task 6: Implement the Event-Sourced Handoff State and Replay Model

**Files:**

- Create: `packages/exchange-core/package.json`
- Create: `packages/exchange-core/src/domain/handoff-types.ts`
- Create: `packages/exchange-core/src/domain/handoff-events.ts`
- Create: `packages/exchange-core/src/domain/handoff-reducer.ts`
- Create: `packages/exchange-core/src/domain/handoff-state-codec.ts`
- Create: `packages/exchange-core/src/domain/index.ts`
- Create: `packages/exchange-core/src/index.ts`
- Create: `packages/exchange-core/test/handoff-reducer.test.ts`

**Interfaces:**

- Consumes: JSON and Context reference types from `exchange-spi`; WFPP lifecycle names from the protocol specification.
- Produces: `HandoffState`, `HandoffPackage`, `HandoffEvent`, `evolveHandoff`, `replayHandoff`, strict State/Event JSON codecs for Tasks 7–11.

- [ ] **Step 1: Write failing deterministic replay tests**

Cover:

```text
offered -> accepted -> result_returned -> verified -> closed
offered -> declined
offered -> expired
accepted -> cancelled
result_returned -> rework_requested -> accepted
status_reported leaves lifecycle and responsibility unchanged
replaying the same event list twice produces deeply equal state
an event before offered is rejected
an event after a terminal state is rejected
stream versions with a gap are rejected
Handoff state converts to JSON and back without type assertions
```

The normal path assertion must verify responsibility moves Initiator → Recipient → Verifier → none.

- [ ] **Step 2: Run the focused test and confirm the Core package is missing**

Run:

```bash
npx vitest run packages/exchange-core/test/handoff-reducer.test.ts
```

Expected: FAIL because `@work-fabric/exchange-core` has not been created.

- [ ] **Step 3: Define Handoff values and state**

Use these stable public fields:

```ts
export type ActorType = "human" | "agent" | "system";

export interface ActorRef {
  readonly actor_id: string;
  readonly actor_type: ActorType;
}

export type HandoffTarget =
  | { readonly actor_id: string }
  | { readonly endpoint_id: string }
  | { readonly capability_requirement: JsonObject };

export interface AcceptanceCriterion {
  readonly criterion_id: string;
  readonly description: string;
  readonly required: boolean;
  readonly result_schema_ref: string | null;
  readonly required_evidence_types: readonly string[];
  readonly extensions?: JsonObject;
}

export interface AuthorityScope {
  readonly delegation_id: string;
  readonly scopes: readonly string[];
  readonly resource_refs: readonly string[];
  readonly expires_at: string;
  readonly may_redelegate: boolean;
  readonly extensions?: JsonObject;
}

export type HandoffLifecycleState =
  | "offered"
  | "accepted"
  | "result_returned"
  | "verified"
  | "rework_requested"
  | "closed"
  | "declined"
  | "expired"
  | "cancelled"
  | "transferred";

export interface HandoffPackage {
  readonly work_reference: JsonObject;
  readonly target: HandoffTarget;
  readonly intent: readonly JsonObject[];
  readonly context: ContextReference | null;
  readonly authority_scope: AuthorityScope;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly verifier: ActorRef;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
}

export interface HandoffState {
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly resource_version: number;
  readonly lifecycle_state: HandoffLifecycleState;
  readonly initiator: ActorRef;
  readonly recipient: ActorRef | null;
  readonly verifier: ActorRef;
  readonly current_responsible_actor: ActorRef | null;
  readonly package: HandoffPackage;
  readonly result: JsonObject | null;
  readonly parent_handoff_id: string | null;
  readonly child_handoff_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
```

- [ ] **Step 4: Define the closed Handoff event union**

`HandoffEvent` is a discriminated union over these exact `event_type` values and required data:

```text
workfabric.handoff.offered.v1
  handoff_id, thread_id, initiator, package, parent_handoff_id
workfabric.handoff.accepted.v1
  handoff_id, recipient
workfabric.handoff.declined.v1
  handoff_id
workfabric.handoff.expired.v1
  handoff_id
workfabric.handoff.cancelled.v1
  handoff_id, reason
workfabric.handoff.status_reported.v1
  handoff_id, status
workfabric.handoff.result_returned.v1
  handoff_id, result
workfabric.handoff.verified.v1
  handoff_id, satisfied_criterion_ids, summary, evidence
workfabric.handoff.closed.v1
  handoff_id
workfabric.handoff.rework_requested.v1
  handoff_id, criterion_ids, reason
workfabric.handoff.transferred.v1
  handoff_id, child_handoff_id
```

Every union member also carries `occurred_at`. Do not add internal execution-step events.

- [ ] **Step 5: Implement the reducer and replay guards**

Export:

```ts
export function evolveHandoff(
  state: HandoffState | null,
  event: HandoffEvent,
  streamVersion: number,
): HandoffState;

export function replayHandoff(
  events: readonly {
    readonly stream_version: number;
    readonly event: HandoffEvent;
  }[],
): HandoffState | null;
```

`evolveHandoff` must enforce event/state compatibility, Handoff ID equality, terminal immutability, contiguous positive stream versions, and these responsibility changes:

```text
offered -> initiator
accepted -> recipient
result_returned -> verifier
verified -> verifier
rework_requested -> verifier
closed/declined/expired/cancelled/transferred -> null
```

Status events only update `resource_version` and `updated_at`; the full latest status remains a projection concern.

Add a strict JSON boundary codec:

```ts
export function handoffStateToJson(state: HandoffState): JsonObject;
export function handoffStateFromJson(value: JsonObject): HandoffState;
export function handoffEventToJson(event: HandoffEvent): JsonObject;
export function handoffEventFromJson(value: JsonObject): HandoffEvent;
```

The decoders check every required scalar, enum, Actor shape, Package/Event shape, nullable relationship, and Resource Version. They throw `Invalid stored Handoff state: <field>` or `Invalid stored Handoff event: <field>` on corruption; callers must treat that as a poison projection or corrupted snapshot, never cast a `JsonObject` to a Domain type.

- [ ] **Step 6: Verify deterministic replay and commit**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-core/test/handoff-reducer.test.ts
npm test
```

Expected: all replay, gap, terminal, and responsibility assertions pass.

Commit:

```bash
git add packages/exchange-core package-lock.json
git commit -m "feat(core): add handoff event replay"
```

---

### Task 7: Implement Pure Handoff Command Decisions

**Files:**

- Create: `packages/exchange-core/src/domain/handoff-commands.ts`
- Create: `packages/exchange-core/src/domain/domain-error.ts`
- Create: `packages/exchange-core/src/domain/handoff-decider.ts`
- Modify: `packages/exchange-core/src/domain/index.ts`
- Create: `packages/exchange-core/test/handoff-decider.test.ts`

**Interfaces:**

- Consumes: Handoff state, package, Actor, and event types from Task 6.
- Produces: `HandoffCommand`, `HandoffDecisionContext`, `DomainDecision`, and `decideHandoff` for the Application and Transfer Coordinator.

- [ ] **Step 1: Write the failing transition matrix tests**

Use table tests to cover every lifecycle transition in `protocol/spec/handoff-lifecycle.json`, then add explicit negative cases for wrong Actor, wrong state, missing Context, early expiry, incomplete criteria, expired Authority Scope, and terminal mutation.

The test for external status must assert:

```ts
const decision = decideHandoff(acceptedState, {
  kind: "report_status",
  handoff_id: "handoff_01",
  actor: recipient,
  status: { execution_status: "completed" },
}, allowedContext);

expect(decision).toMatchObject({ kind: "accepted" });
expect(decision.kind === "accepted" && decision.events[0]?.event_type).toBe(
  "workfabric.handoff.status_reported.v1",
);
expect(
  decision.kind === "accepted"
    ? evolveHandoff(acceptedState, decision.events[0]!, 3).lifecycle_state
    : null,
).toBe("accepted");
```

- [ ] **Step 2: Run the focused test and confirm missing decider exports**

Run:

```bash
npx vitest run packages/exchange-core/test/handoff-decider.test.ts
```

Expected: FAIL because the command union and decider do not exist.

- [ ] **Step 3: Define the closed command union**

```ts
export type HandoffCommand =
  | {
      readonly kind: "offer";
      readonly handoff_id: string;
      readonly thread_id: string;
      readonly actor: ActorRef;
      readonly package: HandoffPackage;
      readonly parent_handoff_id: string | null;
    }
  | { readonly kind: "accept"; readonly handoff_id: string; readonly actor: ActorRef }
  | { readonly kind: "decline"; readonly handoff_id: string; readonly actor: ActorRef }
  | { readonly kind: "expire"; readonly handoff_id: string; readonly actor: ActorRef }
  | {
      readonly kind: "cancel";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly reason: readonly JsonObject[];
    }
  | {
      readonly kind: "report_status";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly status: JsonObject;
    }
  | {
      readonly kind: "return_result";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly result: JsonObject;
    }
  | {
      readonly kind: "verify";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly satisfied_criterion_ids: readonly string[];
      readonly summary: readonly JsonObject[];
      readonly evidence: readonly JsonObject[];
    }
  | { readonly kind: "close"; readonly handoff_id: string; readonly actor: ActorRef }
  | {
      readonly kind: "request_rework";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly criterion_ids: readonly string[];
      readonly reason: readonly JsonObject[];
    };

export interface HandoffDecisionContext {
  readonly now: string;
  readonly recipient_authorized: boolean;
  readonly verifier_authorized: boolean;
  readonly policy_allows_cancel: boolean;
  readonly context_available: boolean;
  readonly authority_valid: boolean;
}
```

Transfer remains outside this union and is implemented by Task 10 because it coordinates two streams.

- [ ] **Step 4: Define deterministic decisions and errors**

```ts
export interface DomainError {
  readonly code:
    | "invalid_argument"
    | "permission_denied"
    | "not_found"
    | "invalid_state_transition"
    | "precondition_failed"
    | "expired"
    | "context_unavailable";
  readonly message: string;
  readonly retryable: false;
}

export type DomainDecision =
  | { readonly kind: "accepted"; readonly events: readonly HandoffEvent[] }
  | { readonly kind: "rejected"; readonly error: DomainError };

export function decideHandoff(
  state: HandoffState | null,
  command: HandoffCommand,
  context: HandoffDecisionContext,
): DomainDecision;
```

Return values replace thrown exceptions for expected domain rejection. Throw only for programmer-invalid values that passed neither protocol validation nor command decoding.

- [ ] **Step 5: Implement all lifecycle rules**

Apply these exact checks:

```text
offer: state is null
accept: offered or rework_requested; recipient_authorized; Context available
decline: offered; recipient_authorized
expire: offered; now >= accept_by
cancel: offered or accepted; command Actor is Initiator; policy allows
report_status: accepted; command Actor is current Recipient
return_result: accepted; command Actor is current Recipient; Authority valid
verify: result_returned; command Actor is Verifier; all required criterion IDs included
close: verified; command Actor is Verifier
request_rework: result_returned; command Actor is Verifier; criterion IDs belong to Package
```

For every accepted decision, create exactly one event with `occurred_at = context.now`. Events do not generate IDs, receipts, stream versions, or partition metadata; those belong to the Application.

- [ ] **Step 6: Verify all transition and rejection tests**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-core/test/handoff-decider.test.ts packages/exchange-core/test/handoff-reducer.test.ts
npm test
```

Expected: every authoritative lifecycle transition and negative invariant passes.

- [ ] **Step 7: Commit the pure domain decisions**

```bash
git add packages/exchange-core
git commit -m "feat(core): decide handoff lifecycle commands"
```

---

### Task 8: Add a Shared WFPP Runtime Validator and Protocol Codecs

**Files:**

- Create: `packages/protocol-runtime/package.json`
- Create: `packages/protocol-runtime/src/schema-registry.ts`
- Create: `packages/protocol-runtime/src/interaction-registry.ts`
- Create: `packages/protocol-runtime/src/command-validator.ts`
- Create: `packages/protocol-runtime/src/index.ts`
- Create: `packages/protocol-runtime/test/command-validator.test.ts`
- Modify: `tools/conformance/src/schema-registry.ts`
- Modify: `tools/conformance/src/fixture-runner.ts`
- Modify: `tools/conformance/test/schema-registry.test.ts`
- Modify: `packages/exchange-core/package.json`
- Create: `packages/exchange-core/src/application/protocol-types.ts`
- Create: `packages/exchange-core/src/application/canonical-json.ts`
- Create: `packages/exchange-core/src/application/handoff-codec.ts`
- Create: `packages/exchange-core/test/handoff-codec.test.ts`

**Interfaces:**

- Consumes: WFPP schemas and interaction mapping from Task 1, Domain events from Tasks 6–7, and Proposed Event types from Task 3.
- Produces: reusable `WfppSchemaValidator`, `WfppCommandValidator`, canonical idempotency digest material, `decodeHandoffCommand`, and `encodeHandoffEvents` for Tasks 9 and 12.

- [ ] **Step 1: Write failing shared-validator tests**

Test:

```text
valid Envelope and matching mapped Payload are accepted
invalid Envelope is rejected before Payload lookup
unknown message_type returns unsupported_version/invalid_argument classification
mapped invalid Payload reports Ajv field violations
handoff.child_accepted has no client mapping
every mapping resolves to a registered Schema
```

The public result is:

```ts
export type ValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly errors: readonly {
        readonly field: string;
        readonly description: string;
      }[];
    };

export interface WfppSchemaValidator {
  validate(schemaId: string, value: unknown): ValidationResult;
}

export interface WfppCommandValidator {
  validate(envelope: unknown): ValidationResult;
  payloadSchemaId(messageType: string): string | null;
}

export function loadWfppSchemaValidator(
  schemaRoot: string,
): Promise<WfppSchemaValidator>;

export function loadWfppCommandValidator(
  schemas: WfppSchemaValidator,
  interactionRegistryPath: string,
): Promise<WfppCommandValidator>;
```

- [ ] **Step 2: Write failing codec and digest tests**

Assert that two Envelopes differing only in `message_id`, `sent_at`, trace, correlation, or causation produce the same digest material; changing Actor, Endpoint, Delegation, expected version, message type, or Payload changes it.

Assert that encoding an Accepted domain event at expected stream version 1 creates Event Data with resource version 2 and a `responsibility_accepted` Receipt summary, while Status Report creates no Receipt and keeps lifecycle state `accepted` in its change details.

- [ ] **Step 3: Run focused tests and confirm missing packages/codecs**

Run:

```bash
npx vitest run packages/protocol-runtime/test packages/exchange-core/test/handoff-codec.test.ts
```

Expected: FAIL because the protocol runtime and codecs do not exist.

- [ ] **Step 4: Move schema loading into `protocol-runtime` without behavior change**

Move the existing deterministic `findJsonFiles` and `loadSchemaRegistry` implementation into the package. Keep `tools/conformance/src/schema-registry.ts` as a compatibility re-export:

```ts
export {
  findJsonFiles,
  loadSchemaRegistry,
} from "@work-fabric/protocol-runtime";
```

`loadWfppSchemaValidator(schemaRoot)` loads the Schema registry once and validates any known public Schema ID. `loadWfppCommandValidator(schemaValidator, interactionRegistryPath)` loads the interaction mapping, validates the Command Envelope, then validates `envelope.payload` using the mapped Schema ID. Return normalized Ajv `instancePath` and message pairs; do not expose Ajv types in the public API.

- [ ] **Step 5: Define protocol application types**

```ts
export interface CommandEnvelope {
  readonly spec_version: "1.0";
  readonly message_id: string;
  readonly message_type: string;
  readonly sent_at: string;
  readonly tenant_id: string;
  readonly exchange_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly delegation_id?: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly idempotency_key: string;
  readonly expected_version?: number;
  readonly payload: JsonObject;
}

export interface OperationResult {
  readonly spec_version: "1.0";
  readonly request_message_id: string;
  readonly operation_status:
    | "accepted"
    | "rejected"
    | "conflict"
    | "temporarily_unavailable";
  readonly resource: JsonObject | null;
  readonly receipt: JsonObject | null;
  readonly error: JsonObject | null;
}
```

The wire Schema does not carry `actor_type`. Do not add it. `ProtocolCommandDecoder` receives Actor type from `ResolvedPrincipal.actor_claims` and builds the Domain `ActorRef`; keep Actor type in the separate `AuthenticatedCommandContext` introduced in Task 9.

- [ ] **Step 6: Implement canonical idempotency material**

Export a deterministic JSON serializer that recursively sorts object keys and preserves array order. Reject non-JSON numbers and values. Define digest material exactly as:

```ts
export function idempotencyMaterial(envelope: CommandEnvelope): JsonObject {
  return {
    tenant_id: envelope.tenant_id,
    exchange_id: envelope.exchange_id,
    actor_id: envelope.actor_id,
    endpoint_id: envelope.endpoint_id,
    delegation_id: envelope.delegation_id ?? null,
    message_type: envelope.message_type,
    expected_version: envelope.expected_version ?? null,
    payload: envelope.payload,
  };
}
```

Hash its canonical UTF-8 JSON with Node `createHash("sha256")` and prefix the lowercase hex output with `sha256:`.

- [ ] **Step 7: Implement command decoding and event encoding**

`decodeHandoffCommand(envelope, actor, generatedHandoffId, contextReference)` maps every Task 1 single-stream message type represented by the Task 7 union. Offer uses `generatedHandoffId` and the immutable `contextReference` returned by Context Repository; existing-resource commands take their Handoff ID from Payload. It explicitly rejects both `handoff.transfer` and internal `handoff.child_accepted`. The Validator still validates the public Transfer mapping; Task 10 adds the dedicated `decodeHandoffTransfer` boundary before invoking the multi-stream coordinator.

`encodeHandoffEvents` receives Domain events, current stream version, Envelope metadata, generated Event IDs, generated Receipt IDs, and current time. Each Proposed Event stores `domain_data` for replay and separately stores Schema-valid `protocol_data` for public delivery. It must:

- assign Event Data `resource_version = currentVersion + eventIndex + 1`;
- map Domain event type to `change_type`, `from_state`, `to_state`, and changed fields;
- place only routing-safe `work_reference_uri`, `capability_ids`, and resulting `lifecycle_state` in `change.details` when available;
- include only Receipt summary in Event Data;
- produce full Operation Receipt for accepted, result returned, and verified transitions;
- keep large Context and Result bodies out of Event Data snapshots;
- keep the complete Domain event only in `domain_data`, which Signal code never exposes;
- store deduplicated Initiator, Recipient, Verifier, and authorized Endpoint IDs in internal `visible_actor_ids` / `visible_endpoint_ids` for delivery policy checks, never in the public CloudEvent;
- return Proposed Events plus the final full Receipt or null.

- [ ] **Step 8: Verify no conformance behavior regressed**

Run:

```bash
npm run typecheck
npx vitest run packages/protocol-runtime/test packages/exchange-core/test/handoff-codec.test.ts tools/conformance/test
npm run conformance
```

Expected: shared validator and codecs pass; all existing conformance behavior remains green.

- [ ] **Step 9: Commit the protocol runtime and codecs**

```bash
git add packages/protocol-runtime packages/exchange-core tools/conformance package-lock.json
git commit -m "feat(core): add wfpp validation and codecs"
```

---

### Task 9: Implement the Single-Stream Exchange Application Pipeline

**Files:**

- Create: `packages/exchange-core/src/application/application-dependencies.ts`
- Create: `packages/exchange-core/src/application/protocol-error.ts`
- Create: `packages/exchange-core/src/application/exchange-application.ts`
- Create: `packages/exchange-core/src/application/index.ts`
- Modify: `packages/exchange-core/src/index.ts`
- Create: `packages/exchange-core/test/exchange-application.test.ts`

**Interfaces:**

- Consumes: protocol validator/codecs, pure Domain decisions, Persistence, Identity, Authority, Context, Clock, and ID sources.
- Produces: `ExchangeApplication.handle(envelope, authenticationEvidence)` for every single-stream client Handoff interaction. Task 10 adds the public Transfer command and the child-Accept cross-stream path.

- [ ] **Step 1: Write failing end-to-end Application tests**

Using Memory and local adapters, cover:

```text
valid human Offer creates offered stream and Operation Result
Agent Accept moves responsibility and returns responsibility_accepted Receipt
message_id can change on same-key replay while resource/Receipt remain identical
same key with changed Payload returns idempotency_key_reused
wrong expected_version returns version_conflict
unauthenticated evidence returns unauthenticated
Actor representation without Authority returns permission_denied
missing Context returns context_unavailable before commit
invalid Payload returns invalid_argument field violations
Status Report does not change lifecycle
Result Return, Verify, Close complete normal path
deterministic rejection creates no event
temporary persistence failure returns temporarily_unavailable and is not deduplicated
```

- [ ] **Step 2: Run the focused test and confirm the Application is missing**

Run:

```bash
npx vitest run packages/exchange-core/test/exchange-application.test.ts
```

Expected: FAIL because `ExchangeApplication` is not exported.

- [ ] **Step 3: Define deterministic dependencies and authenticated context**

```ts
export interface Clock {
  now(): string;
}

export interface IdGenerator {
  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery"): string;
}

export interface AuthenticatedCommandContext {
  readonly principal: ResolvedPrincipal;
  readonly actor: ActorRef;
}

export interface ExchangeApplicationDependencies {
  readonly persistence: ExchangePersistence;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly context: ContextRepository;
  readonly validator: WfppCommandValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
```

The Identity Adapter must provide Actor type as a trusted `actor_claims` entry associated with `(tenant_id, actor_id, endpoint_id)` rather than trusting Payload.

- [ ] **Step 4: Implement the pipeline in this exact order**

```text
validate Envelope and mapped Payload
resolve Principal from Authentication Evidence
ensure Principal Tenant equals Envelope Tenant
resolve trusted Actor type for Envelope Actor ID
authorize Principal/Actor/Endpoint/action/resource
compute idempotency digest
return saved same-digest Outcome before loading streams
reject saved different-digest key
decode command
for Offer, persist the validated immutable Context Bundle through ContextRepository and replace it with ContextReference
load and replay target stream
check expected_version for existing resources
check Context availability for Accept
decide Domain events
encode Proposed Events and Receipt
commit outcome and events atomically
map commit result to current request_message_id
```

If validation or authentication fails, return a WFPP Operation Result without persistence. Domain rejections return `rejected`; expected-version conflicts return `conflict`; infrastructure exceptions return `temporarily_unavailable` with `retryable: true` and are not persisted.

- [ ] **Step 5: Normalize replayed outcomes correctly**

Persist `NormalizedOperationOutcome` without `request_message_id`. Both newly committed and replayed responses are created by:

```ts
function toOperationResult(
  requestMessageId: string,
  outcome: NormalizedOperationOutcome,
): OperationResult {
  return {
    spec_version: "1.0",
    request_message_id: requestMessageId,
    ...outcome,
  };
}
```

Return the originally persisted resource version and Receipt ID on replay. Never generate a second Event ID or Receipt ID.

- [ ] **Step 6: Map errors only to existing ProtocolError fields**

Create helpers for the exact Schema fields:

```ts
function protocolError(
  code: ProtocolErrorCode,
  message: string,
  retryable: boolean,
  options?: {
    readonly retry_after_seconds?: number | null;
    readonly current_resource_version?: number | null;
    readonly field_violations?: readonly FieldViolation[];
    readonly details?: JsonValue;
  },
): JsonObject;
```

Do not expose internal error category, stack, SQL, or Adapter details.

- [ ] **Step 7: Verify the single-stream application**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-core/test/exchange-application.test.ts packages/exchange-core/test/handoff-decider.test.ts packages/exchange-core/test/handoff-reducer.test.ts
npm test
```

Expected: all single-stream interactions, idempotency, Authority, Context, and conflict tests pass.

- [ ] **Step 8: Commit the Application pipeline**

```bash
git add packages/exchange-core packages/adapter-identity-local
git commit -m "feat(core): execute handoff commands"
```

---

### Task 10: Implement Atomic Parent/Child Handoff Transfer

**Files:**

- Create: `packages/exchange-core/src/domain/handoff-transfer-coordinator.ts`
- Modify: `packages/exchange-core/src/domain/index.ts`
- Modify: `packages/exchange-core/src/application/handoff-codec.ts`
- Modify: `packages/exchange-core/src/application/exchange-application.ts`
- Create: `packages/exchange-core/test/handoff-transfer-coordinator.test.ts`
- Create: `packages/exchange-core/test/exchange-transfer.test.ts`

**Interfaces:**

- Consumes: Handoff Domain, Event codecs, Application pipeline, and atomic multi-stream persistence.
- Produces: `DecodedHandoffTransfer`, `decodeHandoffTransfer`, pure `offerChildHandoff`, pure `acceptChildAndTransferParent`, and complete handling of `workfabric.handoff.transfer.v1` plus child Accept.

- [ ] **Step 1: Write failing pure coordinator tests**

Assert:

```text
only current Recipient can initiate Transfer
parent must be accepted
Authority Scope may_redelegate must be true
child Offer receives parent_handoff_id
child Offer stays offered and parent stays accepted
child Accept returns child accepted plus parent transferred events
wrong parent/child relation is rejected
already transferred parent cannot transfer again
```

- [ ] **Step 2: Write failing atomic Application tests**

Create parent and child streams through the Application. On child Accept, assert that one Memory commit contains both stream appends, both versions advance, the child becomes `accepted`, and the parent becomes `transferred`.

Inject a stale parent version before child Accept and assert:

```ts
expect(result.operation_status).toBe("conflict");
expect((await store.readStream(childId)).at(-1)?.event_type).toBe(
  "workfabric.handoff.offered.v1",
);
expect((await store.readStream(parentId)).at(-1)?.event_type).not.toBe(
  "workfabric.handoff.transferred.v1",
);
```

- [ ] **Step 3: Run focused tests and confirm missing coordinator behavior**

Run:

```bash
npx vitest run packages/exchange-core/test/handoff-transfer-coordinator.test.ts packages/exchange-core/test/exchange-transfer.test.ts
```

Expected: FAIL because Transfer is not implemented.

- [ ] **Step 4: Implement the pure coordinator**

```ts
export type TransferDecision =
  | {
      readonly kind: "accepted";
      readonly parent_events: readonly HandoffEvent[];
      readonly child_events: readonly HandoffEvent[];
    }
  | { readonly kind: "rejected"; readonly error: DomainError };

export function offerChildHandoff(
  parent: HandoffState,
  childId: string,
  childPackage: HandoffPackage,
  actor: ActorRef,
  now: string,
): TransferDecision;

export function acceptChildAndTransferParent(
  parent: HandoffState,
  child: HandoffState,
  recipient: ActorRef,
  context: HandoffDecisionContext,
): TransferDecision;
```

`offerChildHandoff` returns no parent event and one child Offered event. `acceptChildAndTransferParent` returns one parent Transferred event and one child Accepted event.

- [ ] **Step 5: Enforce same-Partition lineage in the Application**

Add a dedicated `decodeHandoffTransfer(envelope, actor, generatedChildHandoffId, childContextReference)` application-boundary codec. It consumes only an already validated `workfabric.handoff.transfer.v1` Payload, returns `DecodedHandoffTransfer` with the parent ID, generated child ID, trusted Actor, and decoded child Package, and rejects every other message type. Do not add Transfer to the single-stream `HandoffCommand` union.

Derive the root Partition ID once for a root Offer as `"partition:" + sha256(canonicalJson({ tenant_id, root_handoff_id }))`. Persist the stream-to-Partition assignment in the storage adapter. Every child Offer inherits the parent's Partition ID; never hash the child independently. Persist a validated Child Offer Context Bundle through Context Repository before creating the child event, using the same immutable/idempotent semantics as a root Offer.

On child Accept, load parent and child, encode each stream with its own expected version, and send both `StreamAppend` values in one `commitAtomically` request. The Receipt belongs to the child Accepted event; the parent Transferred event has no Receipt.

- [ ] **Step 6: Verify atomic responsibility transfer**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-core/test/handoff-transfer-coordinator.test.ts packages/exchange-core/test/exchange-transfer.test.ts packages/adapter-storage-memory/test
npm test
```

Expected: successful child Accept transfers responsibility atomically; every injected conflict leaves both streams unchanged.

- [ ] **Step 7: Commit Transfer support**

```bash
git add packages/exchange-core packages/adapter-storage-memory
git commit -m "feat(core): transfer handoff responsibility atomically"
```

---

### Task 11: Build Idempotent Handoff and Assignment Projections

**Files:**

- Create: `packages/exchange-spi/src/projection.ts`
- Modify: `packages/exchange-spi/src/runtime-state.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Modify: `packages/adapter-storage-memory/src/memory-exchange-persistence.ts`
- Create: `packages/exchange-conformance/src/projection-profile.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/projection-profile.test.ts`
- Create: `packages/exchange-runtime/package.json`
- Create: `packages/exchange-runtime/src/projection/handoff-read-model.ts`
- Create: `packages/exchange-runtime/src/projection/memory-handoff-read-model-store.ts`
- Create: `packages/exchange-runtime/src/projection/handoff-projector.ts`
- Create: `packages/exchange-runtime/src/projection/index.ts`
- Create: `packages/exchange-runtime/src/index.ts`
- Create: `packages/exchange-runtime/test/handoff-projector.test.ts`

**Interfaces:**

- Consumes: partition Journal, projection checkpoints, Domain reducer/decoder, and committed `domain_data`.
- Produces: `HandoffReadModelStore`, `HandoffProjector`, rebuildable Handoff views, and derived Assignment views.

- [ ] **Step 1: Write failing projection and recovery tests**

Cover:

```text
empty Partition produces no work
Offer creates a Handoff read model and Initiator Assignment
Accept replaces Assignment responsibility with Recipient
Status Report updates latest_status without changing lifecycle
Result and Verify move responsibility to Verifier
Close removes active Assignment
processing the same Event twice is idempotent
projection write followed by failed checkpoint safely replays
stream-version gap blocks the Projector and records a failure
clear and rebuild produces deeply equal read models
```

- [ ] **Step 2: Run the focused test and confirm Runtime is missing**

Run:

```bash
npx vitest run packages/exchange-runtime/test/handoff-projector.test.ts
```

Expected: FAIL because the Runtime package and projection contracts do not exist.

- [ ] **Step 3: Define semantic read-model and failure-store contracts**

```ts
export interface HandoffReadModel {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly state: JsonObject;
  readonly latest_status: JsonObject | null;
}

export interface AssignmentView {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly work_reference: JsonObject;
  readonly responsible_actor: JsonObject;
  readonly lifecycle_state: string;
  readonly accept_by: string;
  readonly result_due_at: string;
  readonly latest_status: JsonObject | null;
}

export interface HandoffReadModelStore extends ExchangeAdapter {
  getHandoff(handoffId: string): Promise<HandoffReadModel | null>;
  putHandoff(model: HandoffReadModel): Promise<void>;
  listHandoffs(partitionId: string): Promise<readonly HandoffReadModel[]>;
  clearPartition(partitionId: string): Promise<void>;
}

export interface ProjectionFailureRecord {
  readonly projector_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly position: number;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface ProjectionFailureStore {
  putProjectionFailure(failure: ProjectionFailureRecord): Promise<void>;
  listProjectionFailures(
    projectorId: string,
    partitionId: string,
  ): Promise<readonly ProjectionFailureRecord[]>;
}
```

`MemoryExchangePersistence` implements `ProjectionFailureStore`; `MemoryHandoffReadModelStore` implements the read-model contract with cloned values.

The read-model store exposes Profile `exchange.projection.v1` with required capabilities `idempotent_upsert`, `partition_reset`, and `immutable_reads`. Export `verifyProjectionProfile(factory)` from `exchange-conformance`; it verifies repeated same-version writes, cloned reads, Partition isolation, list behavior, and clear/rebuild behavior against any third-party Projection Adapter.

- [ ] **Step 4: Implement the Projector one committed event at a time**

```ts
export type ProjectionRunResult =
  | { readonly kind: "idle"; readonly position: number }
  | { readonly kind: "advanced"; readonly position: number; readonly processed: number }
  | {
      readonly kind: "blocked";
      readonly position: number;
      readonly event_id: string;
      readonly reason: string;
    };

export class HandoffProjector {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: ProjectionCheckpointStore,
    private readonly failures: ProjectionFailureStore,
    private readonly models: HandoffReadModelStore,
    private readonly clock: Clock,
  ) {}

  runPartition(partitionId: string, limit: number): Promise<ProjectionRunResult>;
  rebuildPartition(partitionId: string, batchSize: number): Promise<void>;
}
```

For each record:

1. load the current model;
2. decode only `record.domain_data` into a `HandoffEvent` and decode existing JSON state with `handoffStateFromJson`;
3. if model version is already at or beyond the record stream version, treat it as an idempotent no-op;
4. otherwise require exactly the next stream version and call `evolveHandoff`;
5. copy Status Update into `latest_status` only for `status_reported`;
6. write the model;
7. compare-and-advance checkpoint from the record's previous Partition Position to its Position.

If decoding, gap validation, or model write fails, record `ProjectionFailureRecord`, do not advance checkpoint, and return `blocked`. Do not silently skip the Event.

`rebuildPartition` first clears the target read models, calls `resetProjectionCheckpoint` only for this Projector/Partition, and then repeatedly runs batches until idle. Reset is an explicit administrative rebuild action and is never used during normal consumption.

- [ ] **Step 5: Derive Assignment instead of storing a second truth**

Export:

```ts
export function assignmentFromHandoff(
  model: HandoffReadModel,
): AssignmentView | null;
```

Return null when `current_responsible_actor` is null. Otherwise derive all fields from the Handoff state and latest status. No method may write an Assignment independently.

- [ ] **Step 6: Verify replay, checkpoint failure, poison isolation, and rebuild**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-conformance/test/projection-profile.test.ts packages/exchange-runtime/test/handoff-projector.test.ts packages/exchange-core/test
npm test
```

Expected: all projection cases pass and a full rebuild equals the incrementally built view.

- [ ] **Step 7: Commit the projection runtime**

```bash
git add packages/exchange-spi packages/exchange-conformance packages/adapter-storage-memory packages/exchange-runtime package-lock.json
git commit -m "feat(runtime): project handoff responsibility views"
```

---

### Task 12: Build Durable Subscription Filtering and At-Least-Once Signal Dispatch

**Files:**

- Create: `packages/exchange-spi/src/subscription.ts`
- Modify: `packages/exchange-spi/src/runtime-state.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Modify: `packages/adapter-storage-memory/src/memory-exchange-persistence.ts`
- Create: `packages/exchange-conformance/src/subscription-profile.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Create: `packages/exchange-conformance/test/subscription-profile.test.ts`
- Modify: `packages/exchange-runtime/package.json`
- Create: `packages/exchange-runtime/src/subscription/subscription-filter.ts`
- Create: `packages/exchange-runtime/src/subscription/memory-subscription-store.ts`
- Create: `packages/exchange-runtime/src/subscription/default-delivery-policy.ts`
- Create: `packages/exchange-runtime/src/subscription/protocol-event-builder.ts`
- Create: `packages/exchange-runtime/src/subscription/opaque-cursor-codec.ts`
- Create: `packages/exchange-runtime/src/subscription/cursor-pull-service.ts`
- Create: `packages/exchange-runtime/src/subscription/signal-dispatcher.ts`
- Create: `packages/exchange-runtime/src/subscription/index.ts`
- Modify: `packages/exchange-runtime/src/index.ts`
- Create: `packages/exchange-runtime/test/subscription-filter.test.ts`
- Create: `packages/exchange-runtime/test/cursor-pull-service.test.ts`
- Create: `packages/exchange-runtime/test/signal-dispatcher.test.ts`

**Interfaces:**

- Consumes: committed `protocol_data`, Subscription Schema fields, Signal Adapter, delivery positions, attempts, and dead letters.
- Produces: closed deterministic filters, Tenant/Visibility delivery policy, Canonical WFPP CloudEvents, mandatory Cursor Pull/Ack, per-subscription push delivery, retries, and dead-letter behavior.

- [ ] **Step 1: Write failing closed-filter tests**

Assert the exact semantics:

- an empty array is a wildcard for that field;
- values within one populated field are OR;
- populated fields are AND;
- event type, Actor, Endpoint, Thread, Handoff, work-reference URI, capability, and lifecycle filters are supported;
- scripts, regex, callbacks, arbitrary expressions, and unknown fields never enter the typed filter;
- Event filtering reads only Canonical Protocol Event fields and safe `data.change.details` values.

Add delivery-policy cases proving Tenant mismatch, non-participant, and restricted audience are denied after a filter match.

- [ ] **Step 2: Write failing dispatcher recovery tests**

Cover:

```text
unmatched Event advances only that Subscription position
accepted delivery records attempt and advances position
retryable failure records attempt and does not advance before retry threshold
exponential delay suppresses early retry
permanent failure records dead letter and advances
retry exhaustion records dead letter and advances
one failed Subscription does not block another
send success followed by simulated crash before position advance causes duplicate delivery on restart
duplicate delivery preserves the same CloudEvent ID
Signal Adapter never receives domain_data or partition_position
```

Add Cursor Pull/Ack cases:

```text
opaque cursor round-trips only through the server codec
tampered or cross-subscription cursor is rejected
pull skips unmatched events and returns at least one matched CloudEvent
pull stores pending Delivery but does not advance acknowledged position
acknowledged Ack advances to next cursor position
retry Ack leaves position unchanged
rejected Ack records dead letters and advances
expired visibility rejects Ack
repeating the same Ack is idempotent
Delivery Ack never changes a Handoff stream
```

- [ ] **Step 3: Run focused tests and confirm missing subscription runtime**

Run:

```bash
npx vitest run packages/exchange-runtime/test/subscription-filter.test.ts packages/exchange-runtime/test/cursor-pull-service.test.ts packages/exchange-runtime/test/signal-dispatcher.test.ts
```

Expected: FAIL because the subscription contracts and dispatcher do not exist.

- [ ] **Step 4: Define Subscription and attempt-query contracts**

```ts
export interface SubscriptionFilter {
  readonly event_types: readonly string[];
  readonly actor_ids: readonly string[];
  readonly endpoint_ids: readonly string[];
  readonly thread_ids: readonly string[];
  readonly handoff_ids: readonly string[];
  readonly work_reference_uris: readonly string[];
  readonly capability_ids: readonly string[];
  readonly lifecycle_states: readonly string[];
}

export interface RuntimeSubscription {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly owner: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly endpoint_id: string;
  readonly filter: SubscriptionFilter;
  readonly destination: SignalDestination;
  readonly delivery_mode: "cursor_pull" | "sse" | "webhook" | string;
  readonly state: "active" | "suspended" | "closed";
  readonly max_attempts: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SubscriptionStore extends ExchangeAdapter {
  getSubscription(subscriptionId: string): Promise<RuntimeSubscription | null>;
  listActiveSubscriptions(tenantId: string): Promise<readonly RuntimeSubscription[]>;
  putSubscription(subscription: RuntimeSubscription): Promise<void>;
}

export interface SubscriptionDeliveryPolicy extends ExchangeAdapter {
  authorizeDelivery(
    subscription: RuntimeSubscription,
    event: EventRecord,
  ): Promise<{ readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string }>;
}
```

`MemorySubscriptionStore` exposes Profile `exchange.subscription.v1` with required capabilities `tenant_isolation`, `state_filtering`, and `immutable_reads`. Export `verifySubscriptionProfile(factory)` from `exchange-conformance`; verify direct lookup, active-only listing, Tenant isolation, state transitions, replacement by Subscription ID, and cloned reads.

`DefaultSubscriptionDeliveryPolicy` exposes `exchange.subscription_delivery.v1` with required capabilities `tenant_isolation`, `audience_enforcement`, and `default_deny`. It denies by default, always requires Tenant equality, allows `public` and same-Tenant `tenant` visibility, and for `participants` or `restricted` requires the Subscription Owner Actor or Endpoint to appear in the internal visible audience. This policy runs after declarative filtering and before Event construction/delivery; neither visible-audience list is exposed to the Signal Adapter.

Export `verifySubscriptionDeliveryProfile(policy, fixtures)` from the same Conformance module. Its fixed scenarios cover public, same-Tenant, cross-Tenant, participant Actor, participant Endpoint, non-participant, and restricted audiences.

Extend `DeliveryAttempt` with `next_attempt_at: string | null`. Add `PendingDeliveryRecord` and replace the Task 3 `DeliveryStateStore` declaration with this superset:

```ts
export interface PendingDeliveryRecord {
  readonly delivery_id: string;
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly from_position: number;
  readonly to_position: number;
  readonly next_cursor: string;
  readonly events: readonly EventRecord[];
  readonly attempt: number;
  readonly delivered_at: string;
  readonly visibility_expires_at: string;
  readonly outcome: "pending" | "acknowledged" | "retry" | "rejected";
}

export interface DeliveryStateStore {
  loadDeliveryPosition(subscriptionId: string, partitionId: string): Promise<number>;
  recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;
  listDeliveryAttempts(
    subscriptionId: string,
    eventId: string,
  ): Promise<readonly DeliveryAttempt[]>;
  advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  putDeadLetter(record: DeadLetterRecord): Promise<void>;
  putPendingDelivery(delivery: PendingDeliveryRecord): Promise<void>;
  getDelivery(deliveryId: string): Promise<PendingDeliveryRecord | null>;
  completeDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    outcome: "acknowledged" | "retry" | "rejected",
  ): Promise<PendingDeliveryRecord>;
}
```

`completeDelivery` is compare-and-set: pending → requested outcome succeeds, the same already-completed outcome returns the stored record, and a different completed outcome rejects without changing state.

- [ ] **Step 5: Build Canonical Protocol Events without internal metadata leakage**

```ts
export function buildProtocolEvent(record: EventRecord): ProtocolEvent {
  return {
    specversion: "1.0",
    id: record.event_id,
    source: `urn:work-fabric:exchange:${record.exchange_id}`,
    type: record.event_type,
    subject: record.handoff_id,
    time: record.occurred_at,
    datacontenttype: "application/json",
    dataschema: "urn:work-fabric:schema:v1:event-data",
    wftenant: record.tenant_id,
    wfexchange: record.exchange_id,
    wfthread: record.thread_id,
    wfhandoff: record.handoff_id,
    wfactor: record.actor_id,
    wfendpoint: record.endpoint_id,
    ...(record.correlation_id === undefined
      ? {}
      : { wfcorrelation: record.correlation_id }),
    ...(record.causation_id === undefined
      ? {}
      : { wfcausation: record.causation_id }),
    wfsequence: record.stream_version,
    wfvisibility: record.visibility,
    data: structuredClone(record.protocol_data),
  };
}
```

Validate built events against `urn:work-fabric:schema:v1:protocol-event` in tests. `partition_id`, `partition_position`, `commit_id`, `idempotency_key`, `domain_data`, `visible_actor_ids`, and `visible_endpoint_ids` must not be present.

- [ ] **Step 6: Implement deterministic filtering**

Export `matchesSubscription(filter, event): boolean`. Read lifecycle from `event.data.change.to_state`, work URI and capabilities from `event.data.change.details`. Treat missing scalar metadata as no match for a populated filter. Never parse Context or fetch external resources during filtering.

- [ ] **Step 7: Implement opaque Cursor Pull and Delivery Ack**

```ts
export interface CursorPayload {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly position: number;
  readonly expires_at: string;
}

export class OpaqueCursorCodec {
  constructor(private readonly secret: Uint8Array) {}
  encode(payload: CursorPayload): string;
  decode(cursor: string, now: string): CursorPayload;
}

export interface EventDeliveryDocument {
  readonly delivery_id: string;
  readonly subscription_id: string;
  readonly attempt: number;
  readonly events: readonly ProtocolEvent[];
  readonly next_cursor: string;
  readonly delivered_at: string;
  readonly visibility_expires_at: string;
  readonly extensions?: JsonObject;
}

export type PullResult =
  | { readonly kind: "idle"; readonly cursor: string }
  | { readonly kind: "delivery"; readonly delivery: EventDeliveryDocument }
  | { readonly kind: "error"; readonly code: "invalid_argument" | "cursor_expired" | "precondition_failed"; readonly message: string };

export type AckResult =
  | { readonly kind: "acknowledged" | "retry" | "rejected"; readonly cursor: string }
  | { readonly kind: "error"; readonly code: "invalid_argument" | "not_found" | "precondition_failed" | "cursor_expired"; readonly message: string };

export class CursorPullService {
  constructor(
    private readonly journal: EventJournal,
    private readonly deliveryState: DeliveryStateStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly policy: SubscriptionDeliveryPolicy,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly cursors: OpaqueCursorCodec,
    private readonly schemas: WfppSchemaValidator,
    private readonly visibilityTimeoutSeconds: number,
  ) {}

  pull(
    subscriptionId: string,
    partitionId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PullResult>;

  acknowledge(ack: unknown): Promise<AckResult>;
}
```

`OpaqueCursorCodec` rejects secrets shorter than 32 bytes, serializes Canonical JSON as base64url, and appends an HMAC-SHA256 signature. `decode` uses `timingSafeEqual`, rejects malformed/tampered values, and returns `cursor_expired` semantics after `expires_at`; no client field is trusted before signature verification.

`pull` loads one active `cursor_pull` Subscription, requires a supplied Cursor to match the Subscription, Partition, and currently acknowledged position, then scans the Journal. It applies declarative filter and `SubscriptionDeliveryPolicy` before calling `buildProtocolEvent`. Unmatched/unauthorized positions can advance immediately because they are not deliverable to this Subscription. If no visible match exists, return `idle`; otherwise create a Schema-valid `EventDelivery` with at least one Event, persist `PendingDeliveryRecord`, and do not advance beyond the matched batch until Ack.

`acknowledge` first validates unknown input against `urn:work-fabric:schema:v1:delivery-ack`, then validates Delivery ID, Subscription ID, Outcome, optional Cursor, and visibility expiry against the stored Delivery. `acknowledged` compare-and-advances to `to_position`; `retry` leaves position unchanged; `rejected` creates a dead letter per Event then advances. Repeating the same Ack Outcome returns the stored result; a different repeated Outcome returns `precondition_failed`. It never appends or mutates a Handoff event stream.

- [ ] **Step 8: Implement one-batch push dispatch with explicit crash hook**

```ts
export interface RetryPolicy {
  readonly base_delay_seconds: number;
  readonly max_delay_seconds: number;
}

export interface DispatchObserver {
  afterDelivery(eventId: string, subscriptionId: string): Promise<void>;
}

export class SignalDispatcher {
  constructor(
    private readonly journal: EventJournal,
    private readonly deliveryState: DeliveryStateStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly policy: SubscriptionDeliveryPolicy,
    private readonly signal: SignalAdapter,
    private readonly clock: Clock,
    private readonly retry: RetryPolicy,
    private readonly observer?: DispatchObserver,
  ) {}

  dispatchPartition(partitionId: string, tenantId: string, limit: number): Promise<void>;
}
```

For each active non-`cursor_pull` Subscription, read from its own delivery position. Advance unmatched or unauthorized Events. For a matched and authorized Event, respect `next_attempt_at`, call Signal once, record the attempt, invoke `observer.afterDelivery` before advancing position, and then:

```text
accepted -> advance
retryable and attempts < max -> do not advance
retryable and attempts >= max -> dead-letter then advance
permanent -> dead-letter then advance
```

Calculate delay as `min(base * 2^(attempt - 1), max)` seconds. Use the injected Clock and ISO timestamps; do not sleep inside Runtime code.

- [ ] **Step 9: Verify Cursor, at-least-once, visibility, and isolation behavior**

Run:

```bash
npm run typecheck
npx vitest run packages/exchange-conformance/test/subscription-profile.test.ts packages/exchange-runtime/test/subscription-filter.test.ts packages/exchange-runtime/test/cursor-pull-service.test.ts packages/exchange-runtime/test/signal-dispatcher.test.ts packages/adapter-signal-in-process/test
npm test
npm run conformance
```

Expected: signed cursors reject tampering, Ack alone advances pulled deliveries, duplicate-after-crash preserves Event ID, Tenant/Visibility policy is enforced, failures are subscription-isolated, and every EventDelivery/CloudEvent validates.

- [ ] **Step 10: Commit the Subscription and Signal Runtime**

```bash
git add packages/exchange-spi packages/exchange-conformance packages/adapter-storage-memory packages/exchange-runtime package-lock.json
git commit -m "feat(runtime): deliver durable exchange subscriptions"
```

---

### Task 13: Prove the Complete Reference Flow and Enforce Architecture Boundaries

**Files:**

- Create: `packages/exchange-core/test/reference-flow.integration.test.ts`
- Create: `packages/exchange-core/test/concurrency.integration.test.ts`
- Create: `packages/exchange-runtime/test/recovery.integration.test.ts`
- Create: `packages/exchange-core/test/dependency-boundaries.test.ts`
- Modify: `packages/exchange-conformance/package.json`
- Create: `packages/exchange-conformance/src/reference-suite.ts`
- Modify: `packages/exchange-conformance/src/index.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `protocol/README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: every Phase 1 package and approved example semantics.
- Produces: one executable reference suite, architecture dependency guards, complete recovery evidence, and public documentation for the next PostgreSQL phase.

- [ ] **Step 1: Write the failing human → Agent → verifier reference flow**

Build this entirely in-process:

```text
Human Actor offers a Feishu-document WorkReference to a local Agent Actor
Agent receives offered Signal and explicitly accepts
Projection shows Agent responsibility
Agent reports in_progress, returns Result with Artifact/Evidence references
Human Verifier verifies and closes
Projection shows no active Assignment
all Signals validate as WFPP CloudEvents
replaying Journal reproduces the same final Handoff
```

Use fake Feishu URIs only as `ResourceRef`; do not call Feishu. Use the local Agent only as an Actor/Endpoint identity; do not execute Agent work inside Core.

- [ ] **Step 2: Write failing concurrency and recovery integration tests**

Cover exactly:

```text
two Actors concurrently Accept one Handoff -> one committed, one conflict
Accept and Cancel race -> only one valid next state commits
two Result Returns at one expected version -> one committed
child Accept and stale parent -> neither stream changes
Projection store cleared -> rebuild equals original
Projection write succeeds and checkpoint fails -> idempotent replay
Signal accepted and process crashes before position -> same Event ID redelivered
tampered Cursor -> rejected without position change
Cursor Pull + acknowledged Ack -> delivery position advances
non-participant Subscription -> filtered Event is not delivered
Context unavailable -> no accepted event
temporary persistence exception -> same key can retry successfully
poison domain_data -> failure isolated and checkpoint unchanged
```

- [ ] **Step 3: Write the failing dependency-boundary test**

Walk every `.ts` file under `packages/exchange-spi/src` and `packages/exchange-core/src`. Fail when Core imports an Adapter package or when either tree contains forbidden implementation imports/tokens:

```ts
const forbidden = [
  "adapter-storage",
  "adapter-identity",
  "adapter-context",
  "adapter-signal",
  "pg",
  "postgres",
  "kafka",
  "nats",
  "feishu",
  "express",
  "fastify",
  "@modelcontextprotocol",
];
```

The test may ignore documentation comments but must scan actual import specifiers and package dependencies.

- [ ] **Step 4: Run integration tests and confirm uncovered behavior fails**

Run:

```bash
npx vitest run packages/exchange-core/test/reference-flow.integration.test.ts packages/exchange-core/test/concurrency.integration.test.ts packages/exchange-runtime/test/recovery.integration.test.ts packages/exchange-core/test/dependency-boundaries.test.ts
```

Expected: FAIL on any remaining integration, recovery, or dependency-boundary gap; do not weaken assertions to make them pass.

- [ ] **Step 5: Add the executable reference conformance suite**

Export:

```ts
export interface ReferenceSuiteDependencies {
  readonly application: ExchangeApplication;
  readonly projector: HandoffProjector;
  readonly dispatcher: SignalDispatcher;
  readonly read_models: HandoffReadModelStore;
  readonly persistence: ExchangePersistence &
    ProjectionCheckpointStore &
    DeliveryStateStore &
    ProjectionFailureStore;
  readonly scenario: {
    readonly tenant_id: string;
    readonly exchange_id: string;
    readonly human_actor_id: string;
    readonly human_endpoint_id: string;
    readonly human_evidence: JsonObject;
    readonly agent_actor_id: string;
    readonly agent_endpoint_id: string;
    readonly agent_evidence: JsonObject;
  };
}

export async function verifyExchangeReferenceSuite(
  dependencies: ReferenceSuiteDependencies,
): Promise<void>;
```

The suite executes Offer, Accept, Status, Result, Verify, Close, Rework, Transfer, idempotent replay, conflict, projection rebuild, and signal retry scenarios. It imports public package exports only.

Add explicit workspace dependencies on `@work-fabric/exchange-core` and `@work-fabric/exchange-runtime` to `exchange-conformance`; this dependency direction is test/conformance → implementation and does not create a Core dependency on Conformance.

- [ ] **Step 6: Update root verification and public documentation**

Keep existing `verify` behavior and add a focused workspace script:

```json
"verify:exchange": "npm run typecheck && vitest run packages && npm run conformance"
```

Update README and architecture docs to state:

- Exchange Core Phase 1 is transport-free;
- execution remains external;
- Handoff is authoritative and Assignment is projected;
- Memory Adapter is a reference, not production storage;
- PostgreSQL is the next production Adapter, not a Core dependency;
- global subscription is logical and uses per-Partition recovery positions;
- public Protocol Event never exposes `domain_data` or storage cursor metadata.

- [ ] **Step 7: Run fresh full verification**

Run:

```bash
npm run verify
npm run verify:exchange
git diff --check
```

Expected:

```text
TypeScript: pass
Vitest: all test files pass with zero failures
WFPP conformance: all fixtures pass
Exchange reference suite: pass
git diff --check: no output
```

- [ ] **Step 8: Review scope and commit Phase 1 integration**

Before committing, verify:

```bash
rg -n "[T]ODO|[T]BD|[F]IXME" packages protocol docs README.md
rg -n "postgres|kafka|nats|feishu|express|fastify" packages/exchange-core/src packages/exchange-spi/src
git status --short
```

Expected: no unfinished markers in new Phase 1 code, no forbidden Core/SPI technology imports, and only intended files modified.

Commit:

```bash
git add package.json package-lock.json README.md docs protocol packages
git commit -m "feat: complete exchange core reference flow"
```

---

## Explicit Phase 1 Deferrals

These specification elements have stable seams in Phase 1 but intentionally receive no production implementation in this plan:

- PostgreSQL and other durable production storage Adapters;
- HTTP, SDK packaging, A2A, MCP, Feishu, Webhook, Kafka, and NATS Bindings/Adapters;
- Endpoint lease/discovery service and automated capability matching;
- continuously running deadline/expiry scheduler—the deterministic `handoff.expire` command is implemented and tested;
- event upcasters beyond Schema `1.0`—stored Schema Version is mandatory and unknown versions block replay visibly;
- Snapshot scheduling policy—the optional Snapshot SPI and reference behavior are implemented;
- background process supervision, cluster worker leases, partition migration, and autoscaling;
- performance-class thresholds and production benchmark baselines;
- Federation Profile and cross-Exchange responsibility transactions;
- UI Console, workflow engine, Agent Runtime, and external work execution.

Each deferral is excluded by the approved Phase 1 scope and must not be represented by a silent stub or false production-ready claim.

---

## Phase 1 Completion Gate

Do not declare Phase 1 complete until all of these are evidenced by fresh commands:

- [ ] Existing WFPP tests and fixture conformance still pass.
- [ ] Every client Handoff interaction has a mapped Payload Schema.
- [ ] Context absent/present pairing is Schema-valid and unambiguous.
- [ ] Memory Storage passes `exchange.persistence.v1` behavior conformance.
- [ ] Identity, Authority, Context, Signal, Projection, and Subscription reference Adapters pass their reusable Profiles.
- [ ] Same-key replay preserves resource/Receipt semantics without duplicate events.
- [ ] Same-key changed command returns `idempotency_key_reused`.
- [ ] Every Handoff lifecycle transition and illegal transition is tested.
- [ ] Parent/child responsibility transfer is atomic and same-Partition.
- [ ] Handoff replay is deterministic and projections rebuild equivalently.
- [ ] Assignment is derived and cannot be written independently.
- [ ] Signal delivery is at-least-once, restartable, and subscription-isolated.
- [ ] Cursor Pull/Ack uses signed opaque cursors and advances only after valid acknowledgement.
- [ ] Tenant, Visibility, and participant audience checks run after subscription filtering.
- [ ] Canonical Protocol Events contain no internal Domain data or cursor metadata.
- [ ] Poison projection events and exhausted deliveries are visible and recoverable.
- [ ] Core and SPI dependency guards exclude concrete storage, broker, Feishu, HTTP, MCP, and Agent Runtime implementations.
- [ ] No external participant work is executed inside Core or Runtime.
- [ ] Worktree is clean after the final commit.
