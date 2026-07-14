# Core Protocol Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the language-neutral WFPP v1 Core Protocol package: canonical JSON Schemas, a machine-readable Handoff lifecycle, golden conformance fixtures, a TypeScript conformance runner, and reference examples.

**Architecture:** JSON Schema Draft 2020-12 files under `protocol/schemas/v1` are the machine-readable source of truth. A small TypeScript CLI loads every schema into Ajv, validates positive and negative fixtures, and executes lifecycle scenarios against a declarative transition model. HTTP, SSE, Webhook, A2A, MCP, Exchange Server, SDK generation, and adapters remain outside this plan.

**Tech Stack:** Node.js `>=22.20.0`, npm, TypeScript `7.0.2`, Ajv `8.20.0`, ajv-formats `3.0.1`, Vitest `4.1.10`, tsx `4.23.1`, `@types/node` `22.20.1`, JSON Schema Draft 2020-12.

## Global constraints

- [ ] Follow `docs/superpowers/specs/2026-07-13-work-fabric-participation-protocol-v1-design.md` exactly; record any intentional deviation in that design before implementing it.
- [ ] Use protocol version `1.0` and schema IDs `urn:work-fabric:schema:v1:<schema-name>`.
- [ ] Use `snake_case` fields and lower-snake-case enum values.
- [ ] Default objects to `additionalProperties: false`; extensibility is explicit through an `extensions` object.
- [ ] Limit opaque identifiers to 128 characters and timestamps to RFC 3339 `date-time` strings.
- [ ] Keep credentials, secrets, binary payloads, transport URLs, A2A details, and MCP details out of core domain messages.
- [ ] Do not introduce `draft` as a wire-visible Handoff state.
- [ ] Keep external work status independent from Handoff lifecycle state.
- [ ] Model event delivery as at-least-once; consumers use event identity and sequence metadata for deduplication and ordering.
- [ ] Write a failing focused test before each implementation slice, then commit only after focused and regression tests pass.

## Target repository layout

```text
package.json
package-lock.json
tsconfig.json
protocol/
├── README.md
├── schemas/v1/
│   ├── common/
│   ├── identity/
│   ├── content/
│   ├── endpoint/
│   ├── handoff/
│   ├── messages/
│   ├── events/
│   └── subscriptions/
├── spec/
│   ├── core.md
│   ├── roles.md
│   ├── interactions.md
│   ├── events.md
│   ├── subscriptions.md
│   ├── security.md
│   ├── versioning.md
│   └── handoff-lifecycle.json
├── conformance/
│   ├── fixtures/positive/
│   ├── fixtures/negative/
│   ├── scenarios/
│   └── exchange-contract.json
└── examples/
    ├── human-to-agent/sequence.json
    ├── agent-to-agent/sequence.json
    └── system-agent-system/sequence.json
tools/conformance/
├── src/
│   ├── schema-registry.ts
│   ├── fixture-runner.ts
│   ├── lifecycle-runner.ts
│   ├── manifest-runner.ts
│   └── cli.ts
└── test/
```

## Task 1: Bootstrap the protocol validation toolchain

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tools/conformance/src/schema-registry.ts`
- Test: `tools/conformance/test/schema-registry.test.ts`

- [ ] **Step 1: Add the failing schema discovery test**

Create a temporary nested directory containing two `.json` files and one ignored text file. Assert that `findJsonFiles(root)` returns normalized absolute paths in lexical order. Add a second test asserting that `loadSchemaRegistry(emptyDirectory)` rejects because no schemas were found.

- [ ] **Step 2: Run the focused test and confirm the expected module-not-found failure**

```bash
npx vitest run tools/conformance/test/schema-registry.test.ts
```

- [ ] **Step 3: Add the pinned toolchain**

Use this package contract:

```json
{
  "name": "@work-fabric/core-protocol",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.20.0" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "conformance": "tsx tools/conformance/src/cli.ts",
    "verify": "npm run typecheck && npm test && npm run conformance"
  },
  "dependencies": {
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "tsx": "4.23.1",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Configure TypeScript with `module` and `moduleResolution` set to `NodeNext`, `target` set to `ES2023`, and strict checking enabled.

- [ ] **Step 4: Implement deterministic schema discovery and Ajv registration**

Export:

```ts
export async function findJsonFiles(root: string): Promise<string[]>;
export async function loadSchemaRegistry(root: string): Promise<Ajv2020>;
```

`loadSchemaRegistry` parses every JSON file, rejects duplicate or absent `$id` values, instantiates `Ajv2020` from `ajv/dist/2020.js`, enables `allErrors`, `strict`, and `validateFormats`, installs `ajv-formats`, and registers all schemas after discovery.

- [ ] **Step 5: Install, test, and commit**

```bash
npm install
npm run typecheck
npx vitest run tools/conformance/test/schema-registry.test.ts
git add package.json package-lock.json tsconfig.json tools/conformance
git commit -m "build: add protocol conformance toolchain"
```

## Task 2: Define foundational identity and content schemas

**Files:**

- Create: `protocol/schemas/v1/common/definitions.schema.json`
- Create: `protocol/schemas/v1/common/trace-context.schema.json`
- Create: `protocol/schemas/v1/identity/actor-ref.schema.json`
- Create: `protocol/schemas/v1/identity/endpoint-ref.schema.json`
- Create: `protocol/schemas/v1/identity/authority-scope.schema.json`
- Create: `protocol/schemas/v1/content/resource-ref.schema.json`
- Create: `protocol/schemas/v1/content/content-part.schema.json`
- Create: `protocol/schemas/v1/content/context-bundle.schema.json`
- Test: `tools/conformance/test/foundational-schemas.test.ts`

- [ ] **Step 1: Write failing validation cases**

Cover every Actor type (`human`, `agent`, `system`, `group`), an unknown Actor type, an overlength identifier, a valid text/data/resource content bundle, a context item without visibility, a binary-like content part, and suspicious secret fields such as `access_token`.

- [ ] **Step 2: Confirm schemas are missing**

```bash
npx vitest run tools/conformance/test/foundational-schemas.test.ts
```

- [ ] **Step 3: Implement reusable definitions and identity schemas**

Common definitions must include opaque ID, protocol version, RFC 3339 timestamp, non-empty string, metadata, and extensions. `ActorRef` carries `actor_id`, `actor_type`, and optional display/endpoint information. Authority scope expresses allowed action/resource pairs, not executable policy code.

- [ ] **Step 4: Implement content and context schemas**

`ContentPart` is a closed union of `text`, `data`, and `resource`. `ContextBundle` contains typed items with explicit visibility and provenance. Do not accept secret/credential fields or inline binary bodies.

- [ ] **Step 5: Run tests and commit**

```bash
npm run typecheck
npx vitest run tools/conformance/test/foundational-schemas.test.ts
npm test
git add protocol/schemas/v1 tools/conformance/test/foundational-schemas.test.ts
git commit -m "feat(protocol): add foundational schemas"
```

## Task 3: Define endpoint and capability discovery schemas

**Files:**

- Create: `protocol/schemas/v1/endpoint/binding-descriptor.schema.json`
- Create: `protocol/schemas/v1/endpoint/capability-descriptor.schema.json`
- Create: `protocol/schemas/v1/endpoint/endpoint-descriptor.schema.json`
- Test: `tools/conformance/test/endpoint-schemas.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Validate a Local Agent Runtime endpoint with declared capabilities and abstract binding names. Reject an undeclared binding type, an embedded bearer token, executable tool definitions, and duplicate capability IDs.

- [ ] **Step 2: Implement binding and capability descriptors**

Core describes binding identity and configuration metadata without defining transport semantics. Capabilities declare inputs, outputs, supported interaction names, constraints, and human-readable descriptions without embedding runtime code.

- [ ] **Step 3: Implement the endpoint descriptor**

Include endpoint identity, owning Actor, capabilities, binding descriptors, protocol versions, lifecycle/availability metadata, and explicit extensions. Use schema-level uniqueness where JSON Schema can enforce it and add semantic checks in the conformance runner where it cannot.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tools/conformance/test/endpoint-schemas.test.ts
npm test
git add protocol/schemas/v1/endpoint tools/conformance/test/endpoint-schemas.test.ts
git commit -m "feat(protocol): add endpoint capability schemas"
```

## Task 4: Define Handoff, result, status, and receipt schemas

**Files:**

- Create: `protocol/schemas/v1/handoff/acceptance-criterion.schema.json`
- Create: `protocol/schemas/v1/handoff/capability-requirement.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-target.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-offer.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-snapshot.schema.json`
- Create: `protocol/schemas/v1/handoff/status-update.schema.json`
- Create: `protocol/schemas/v1/handoff/artifact.schema.json`
- Create: `protocol/schemas/v1/handoff/evidence.schema.json`
- Create: `protocol/schemas/v1/handoff/result-submission.schema.json`
- Create: `protocol/schemas/v1/handoff/operation-receipt.schema.json`
- Test: `tools/conformance/test/handoff-schemas.test.ts`

- [ ] **Step 1: Write failing domain tests**

Cover Actor, Endpoint, and capability-query targets; every authoritative Handoff state; invalid `draft`; an external status update that does not mutate lifecycle state; progress boundaries; result artifacts/evidence; and rejection of inline binary payloads.

- [ ] **Step 2: Implement offer and target schemas**

`HandoffOffer` must carry work identity, source, one target form, requested capabilities, acceptance criteria, optional context references, expiry, idempotency metadata, and tracing. Assignment remains unresolved until acceptance.

- [ ] **Step 3: Implement snapshot and status schemas**

Use exactly these authoritative states: `offered`, `accepted`, `result_returned`, `verified`, `rework_requested`, `closed`, `declined`, `expired`, `cancelled`, `transferred`. External work status has its own namespace and cannot substitute for lifecycle transitions.

- [ ] **Step 4: Implement artifact, evidence, result, and receipt schemas**

Artifacts and evidence use content/resource references. Results correlate to a Handoff and acceptance criteria. Receipts report protocol processing, not business completion.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tools/conformance/test/handoff-schemas.test.ts
npm test
git add protocol/schemas/v1/handoff tools/conformance/test/handoff-schemas.test.ts
git commit -m "feat(protocol): add handoff result schemas"
```

## Task 5: Define commands, operation results, and protocol errors

**Files:**

- Create: `protocol/schemas/v1/messages/resource-version-ref.schema.json`
- Create: `protocol/schemas/v1/messages/command-envelope.schema.json`
- Create: `protocol/schemas/v1/messages/operation-result.schema.json`
- Create: `protocol/schemas/v1/messages/protocol-error.schema.json`
- Test: `tools/conformance/test/message-schemas.test.ts`

- [ ] **Step 1: Write failing envelope and error tests**

Cover command correlation, Actor/Endpoint identity, authority scope, trace context, idempotency key, optimistic resource version, accepted and rejected operation results, and the complete normative error code set.

- [ ] **Step 2: Implement the command envelope**

The envelope carries `message_id`, `protocol_version`, `interaction`, `sent_at`, sender/endpoint identity, optional acting authority, idempotency, expected resource version, trace context, and a JSON payload. It remains transport-neutral.

- [ ] **Step 3: Implement conditional operation results and errors**

When `accepted` is true, an operation reference/receipt is required and error is forbidden. When false, `ProtocolError` is required. Include at least `invalid_message`, `unsupported_version`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `invalid_transition`, `idempotency_key_reused`, `precondition_failed`, `rate_limited`, `temporarily_unavailable`, and `cursor_expired`.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tools/conformance/test/message-schemas.test.ts
npm test
git add protocol/schemas/v1/messages tools/conformance/test/message-schemas.test.ts
git commit -m "feat(protocol): add message envelope schemas"
```

## Task 6: Define events, subscriptions, delivery, and acknowledgements

**Files:**

- Create: `protocol/schemas/v1/events/event-data.schema.json`
- Create: `protocol/schemas/v1/events/protocol-event.schema.json`
- Create: `protocol/schemas/v1/subscriptions/subscription-filter.schema.json`
- Create: `protocol/schemas/v1/subscriptions/subscription.schema.json`
- Create: `protocol/schemas/v1/subscriptions/event-delivery.schema.json`
- Create: `protocol/schemas/v1/subscriptions/delivery-ack.schema.json`
- Test: `tools/conformance/test/event-subscription-schemas.test.ts`

- [ ] **Step 1: Write failing event tests**

Validate a CloudEvents 1.0 structured event with Work Fabric extensions including `wfsequence`. Reject missing sequence metadata, embedded context bundles, secret-bearing data, and non-CloudEvents envelopes.

- [ ] **Step 2: Write failing subscription tests**

Validate filters composed only from event types, subjects, source Actors/Endpoints, resource IDs, and labels. Reject scripts, expressions, regex programs, or arbitrary executable predicates. Cover delivery attempt metadata and acknowledgements.

- [ ] **Step 3: Implement events**

Use CloudEvents fields `specversion`, `id`, `source`, `type`, `subject`, `time`, and `data`, plus protocol extensions for sequence, resource version, correlation, and trace. Event data summarizes a change and references resources; it does not duplicate full context.

- [ ] **Step 4: Implement subscriptions and delivery semantics**

Declare durable subscription identity, owner, closed filter model, requested delivery binding reference, cursor/checkpoint metadata, state, retry/dead-letter hints, and acknowledgement outcome. Core states at-least-once semantics without prescribing a broker.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tools/conformance/test/event-subscription-schemas.test.ts
npm test
git add protocol/schemas/v1/events protocol/schemas/v1/subscriptions tools/conformance/test/event-subscription-schemas.test.ts
git commit -m "feat(protocol): add event subscription schemas"
```

## Task 7: Add the machine-readable Handoff lifecycle

**Files:**

- Create: `protocol/spec/handoff-lifecycle.json`
- Create: `tools/conformance/src/lifecycle-runner.ts`
- Test: `tools/conformance/test/lifecycle-runner.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Test happy path, decline, expiry, cancellation, rework loop, invalid close-before-verify, invalid mutation after a terminal state, and transfer. Transfer must first preserve the parent in `accepted` while creating a child handoff effect; only `handoff.child_accepted` moves the parent to `transferred`.

- [ ] **Step 2: Define the declarative lifecycle model**

The JSON model contains version, initial state, terminal states, and transitions. Each transition declares interaction, allowed source states, target state, required conditions, emitted event type, and optional effects. Do not encode transport behavior.

- [ ] **Step 3: Implement the lifecycle runner**

Export typed `loadLifecycle`, `findTransition`, and `applyTransition` functions. Reject unknown interactions, disallowed source states, missing required conditions, and transitions from terminal states. Return the next state, event type, and declared effects without executing side effects.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tools/conformance/test/lifecycle-runner.test.ts
npm test
git add protocol/spec/handoff-lifecycle.json tools/conformance/src/lifecycle-runner.ts tools/conformance/test/lifecycle-runner.test.ts
git commit -m "feat(protocol): add handoff lifecycle model"
```

## Task 8: Add golden fixtures and the repository conformance runner

**Files:**

- Create: `tools/conformance/src/fixture-runner.ts`
- Create: `tools/conformance/src/manifest-runner.ts`
- Create: `tools/conformance/src/cli.ts`
- Create: `protocol/conformance/fixtures/positive/*.json`
- Create: `protocol/conformance/fixtures/negative/*.json`
- Create: `protocol/conformance/scenarios/*.json`
- Create: `protocol/conformance/exchange-contract.json`
- Test: `tools/conformance/test/fixture-runner.test.ts`
- Test: `tools/conformance/test/manifest-runner.test.ts`
- Test: `tools/conformance/test/cli.test.ts`

- [ ] **Step 1: Write failing fixture-runner tests**

Use this fixture contract:

```json
{
  "name": "valid human actor",
  "schema_id": "urn:work-fabric:schema:v1:actor-ref",
  "expected_valid": true,
  "instance": {}
}
```

Negative fixtures may add `expected_keyword`. Assert deterministic pass/fail diagnostics and explicit failure when a schema ID is unknown.

- [ ] **Step 2: Implement the fixture runner**

Export `runFixture` and `runFixtureDirectory`. Report fixture path, schema ID, expected/actual validity, normalized Ajv errors, and pass state. Sort input and diagnostics deterministically.

- [ ] **Step 3: Add lifecycle scenario manifests and tests**

Scenario files declare an initial state and ordered interaction/condition steps with expected states, event types, and effects. The manifest runner must use the same lifecycle runner as unit tests.

- [ ] **Step 4: Add the Exchange contract manifest**

Describe, without implementing a server, the 14 approved golden behaviors: identity presentation, discovery, offer, accept, decline, expire, cancel, status publish, result return, verify, rework, transfer, subscription delivery/acknowledgement, and idempotent retry/conflict behavior. Validate manifest structure in tests.

- [ ] **Step 5: Add broad positive and negative coverage**

Provide at least one positive and one negative fixture for each public schema. Include more than 20 total fixture/scenario cases, all lifecycle branches, secret/binary rejection, unknown enum values, resource-version conflict structure, duplicate event handling metadata, and transfer correlation.

- [ ] **Step 6: Implement the CLI**

`npm run conformance` loads all schemas, runs fixtures, lifecycle scenarios, and the Exchange contract manifest, prints individual failures, and ends with a deterministic line:

```text
WFPP v1 conformance: <passed>/<total> passed
```

Exit zero only when all cases pass.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run tools/conformance/test/fixture-runner.test.ts tools/conformance/test/manifest-runner.test.ts tools/conformance/test/cli.test.ts
npm run conformance
npm test
git add protocol/conformance tools/conformance
git commit -m "feat(protocol): add conformance fixtures runner"
```

## Task 9: Publish normative core text and reference examples

**Files:**

- Create: `protocol/README.md`
- Create: `protocol/spec/core.md`
- Create: `protocol/spec/roles.md`
- Create: `protocol/spec/interactions.md`
- Create: `protocol/spec/events.md`
- Create: `protocol/spec/subscriptions.md`
- Create: `protocol/spec/security.md`
- Create: `protocol/spec/versioning.md`
- Create: `protocol/examples/human-to-agent/sequence.json`
- Create: `protocol/examples/agent-to-agent/sequence.json`
- Create: `protocol/examples/system-agent-system/sequence.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Test: `tools/conformance/test/documentation.test.ts`

- [ ] **Step 1: Write failing documentation integrity tests**

Assert that every public schema appears in `protocol/README.md`, every lifecycle interaction is documented, the three example sequences exist and their embedded messages validate, and normative files contain no placeholder markers or `draft` as a Handoff lifecycle state.

- [ ] **Step 2: Write the normative specification**

Use RFC 2119/8174 terms consistently. Define role boundaries, resource ownership, interaction preconditions/effects, event ordering/deduplication, subscription recovery, security/authority expectations, compatibility rules, and extension behavior. Keep binding-specific rules out.

- [ ] **Step 3: Add three end-to-end examples**

Examples cover human-to-agent implementation assignment, agent-to-agent delegated research/implementation, and system-to-agent-to-system handoff. Every message must validate and every state change must match the lifecycle machine.

- [ ] **Step 4: Update entry-point documentation**

Link the protocol package, normative spec, schema index, lifecycle model, examples, and `npm run conformance` from the root README and architecture document. Explicitly list Server and bindings as follow-up packages.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tools/conformance/test/documentation.test.ts
npm run verify
git diff --check
git add README.md docs/architecture.md protocol tools/conformance/test/documentation.test.ts
git commit -m "docs(protocol): publish core protocol artifacts"
```

## Task 10: Final scope and quality verification

**Files:**

- Inspect: all files changed by Tasks 1–9
- Modify only if verification exposes a defect

- [ ] **Step 1: Verify clean installation and all gates**

```bash
rm -rf node_modules
npm ci
npm run verify
git diff --check
```

- [ ] **Step 2: Verify protocol invariants by search**

Confirm the repository contains the required lifecycle states, `wfsequence`, idempotency, authority, cursor recovery, and transfer correlation. Confirm no normative schema contains `draft`, credentials, inline binary, transport URLs, or executable filters.

- [ ] **Step 3: Verify scope discipline**

Inspect the diff and ensure it contains no Exchange Server implementation, OpenAPI binding, SSE/Webhook implementation, A2A adapter, MCP adapter, SDK generator, database, broker, or production deployment assets.

- [ ] **Step 4: Review commit series and working tree**

```bash
git log --oneline --decorate -12
git status --short --branch
```

The branch should be clean, ahead only by intentional protocol commits, and ready for review/push. If final verification required a correction, create one focused correction commit with the affected test.

## Completion criteria

- [ ] Canonical WFPP v1 schemas load under strict JSON Schema Draft 2020-12 validation.
- [ ] The authoritative Handoff lifecycle and every transition are machine-readable and tested.
- [ ] Positive and negative fixtures cover every public schema.
- [ ] Lifecycle scenarios cover happy path, decline, expiry, cancellation, rework, invalid transitions, and transfer.
- [ ] The conformance CLI is deterministic and exits non-zero on any failed case.
- [ ] Three reference workflows validate against the same artifacts as the tests.
- [ ] Normative documentation agrees with schemas and lifecycle model.
- [ ] `npm ci && npm run verify` and `git diff --check` pass from a clean checkout.
- [ ] No Server, transport binding, or adapter implementation has leaked into this phase.
