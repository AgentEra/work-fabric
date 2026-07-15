# Target Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the two-stage Capability Target resolution protocol and Exchange behavior required before the Phase 3 HTTP and TypeScript SDK Binding can expose Capability-targeted Handoffs.

**Architecture:** A Capability Offer creates the existing Handoff aggregate in `target_resolution_pending`; an authorized external Resolver then either binds one eligible Actor/Endpoint and moves it to `offered`, or records `target_unavailable`. The immutable Package retains the Capability Requirement while a separate Target Binding records the explicit target and provenance. A technology-neutral `TargetEligibilityVerifier` validates one proposed target but never returns, ranks, or selects candidates.

**Tech Stack:** Node.js 22.20+, TypeScript 7 strict mode, JSON Schema Draft 2020-12, Ajv 8, Vitest 4, existing Exchange SPI/Core/Runtime and Memory/PostgreSQL adapters.

## Global Constraints

- Follow [Target Resolution Design](../specs/2026-07-15-target-resolution-design.md) exactly.
- Use TDD for every behavior change: add one focused failing test, observe the expected failure, implement the minimum behavior, and rerun focused plus affected tests.
- Direct Actor and Endpoint Offers must retain their existing observable behavior.
- Work Fabric must not match, rank, recommend, randomly choose, or race candidate targets.
- No HTTP server, TypeScript SDK, Endpoint Directory, Agent Runtime, Console, workflow engine, or execution scheduler enters this plan.
- No package in `exchange-core` or `exchange-spi` may import a concrete storage, transport, identity product, or Endpoint Directory implementation.
- Capability resolution must fail closed with `temporarily_unavailable` when eligibility cannot be verified.
- Concurrent resolution commands may commit at most one authoritative Target Binding; the loser receives `version_conflict`.
- PostgreSQL and Memory adapters must persist the new states and events through existing technology-neutral contracts without branching protocol semantics.

---

### Task 1: Canonical Target Resolution protocol artifacts

**Files:**
- Create: `protocol/schemas/v1/handoff/handoff-explicit-target.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-target-resolution.schema.json`
- Create: `protocol/schemas/v1/handoff/handoff-target-unavailable-command.schema.json`
- Modify: `protocol/schemas/v1/handoff/handoff-snapshot.schema.json`
- Modify: `protocol/spec/interaction-payloads.json`
- Modify: `protocol/spec/handoff-lifecycle.json`
- Modify: `protocol/spec/interactions.md`
- Modify: `protocol/spec/events.md`
- Modify: `protocol/spec/core.md`
- Modify: `protocol/spec/roles.md`
- Modify: `protocol/spec/security.md`
- Modify: `protocol/spec/versioning.md`
- Modify: `protocol/README.md`
- Modify: `protocol/conformance/fixtures/positive/core-schemas.json`
- Modify: `protocol/conformance/fixtures/negative/core-schemas.json`
- Modify: `protocol/conformance/scenarios/handoff-lifecycle.json`
- Modify: `tools/conformance/src/lifecycle-runner.ts`
- Test: `tools/conformance/test/handoff-schemas.test.ts`
- Test: `tools/conformance/test/interaction-payloads.test.ts`
- Test: `tools/conformance/test/lifecycle-runner.test.ts`

**Interfaces:**
- Consumes: existing Actor, Endpoint, Evidence, ContentPart, Handoff Reference, Envelope, lifecycle and fixture conventions.
- Produces: Schema IDs `urn:work-fabric:schema:v1:handoff-explicit-target`, `urn:work-fabric:schema:v1:handoff-target-resolution`, and `urn:work-fabric:schema:v1:handoff-target-unavailable-command`; interactions `workfabric.handoff.resolve_target.v1` and `workfabric.handoff.report_target_unavailable.v1`; states `target_resolution_pending` and `target_unavailable`.

- [x] **Step 1: Write failing Schema and lifecycle assertions**

Add focused assertions that load the three new Schema IDs, validate a Resolve Target payload, reject a nested Capability target, validate an unavailable payload, and apply these lifecycle paths:

```ts
expect(resolveTarget({ endpoint_id: "endpoint_agent" })).toBe(true);
expect(resolveTarget({ capability_requirement: { capability_id: "code" } })).toBe(false);
expect(targetUnavailable(validUnavailablePayload)).toBe(true);
expect(applyTransition(lifecycle, null, "handoff.offer", new Set(["capability_target"])).next_state)
  .toBe("target_resolution_pending");
expect(applyTransition(lifecycle, "target_resolution_pending", "handoff.resolve_target", new Set(["resolver_authorized", "target_eligible"])).next_state)
  .toBe("offered");
```

- [x] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run tools/conformance/test/handoff-schemas.test.ts tools/conformance/test/interaction-payloads.test.ts tools/conformance/test/lifecycle-runner.test.ts
```

Expected: FAIL because the new Schema IDs, mappings, states, and transitions do not exist.

- [x] **Step 3: Add canonical Schemas, lifecycle, fixtures, and normative text**

Define `handoff-explicit-target` as exactly one `actor_id` or `endpoint_id`; define resolution payload as `{handoff_id,resolved_target,evidence}`; define unavailable payload as `{handoff_id,reason_code,reason,evidence}` with the four approved reason codes. Extend the snapshot with nullable `target_binding`, replace the single machine-readable initial state with `initial_states`, and represent both initial paths as `handoff.offer` transitions selected by the mutually exclusive `explicit_target` and `capability_target` conditions. Update the lifecycle runner to select the transition whose required conditions are satisfied, then index every public Schema and Event.

- [x] **Step 4: Run focused tests and protocol conformance for GREEN**

```bash
npx vitest run tools/conformance/test/handoff-schemas.test.ts tools/conformance/test/interaction-payloads.test.ts tools/conformance/test/lifecycle-runner.test.ts tools/conformance/test/documentation.test.ts
npm run conformance
```

Expected: all focused tests pass and conformance reports every fixture and lifecycle scenario passing.

- [x] **Step 5: Commit canonical artifacts**

```bash
git add protocol tools/conformance/test
git commit -m "feat(protocol): define target resolution lifecycle"
```

---

### Task 2: Technology-neutral target eligibility SPI

**Files:**
- Create: `packages/exchange-spi/src/target-resolution.ts`
- Modify: `packages/exchange-spi/src/index.ts`
- Test: `packages/exchange-spi/test/target-resolution-contract.test.ts`
- Modify: `packages/exchange-conformance/src/adapter-profiles.ts`
- Test: `packages/exchange-conformance/test/adapter-profiles.test.ts`

**Interfaces:**
- Consumes: `ExchangeAdapter`, `ResolvedPrincipal`, `JsonObject`, tenant/exchange/actor/endpoint identifiers.
- Produces: `TargetEligibilityVerifier.verify(request): Promise<TargetEligibilityDecision>` where decision is `{kind:"eligible"}`, `{kind:"ineligible",reason:string}`, or `{kind:"unavailable",reason:string}`. The request contains one immutable Capability Requirement and one explicit Actor/Endpoint only.

- [x] **Step 1: Write failing SPI contract tests**

Add a verifier profile whose test adapter records one request and returns each allowed decision. Assert the manifest requires `explicit_target_only`, `no_candidate_selection`, and `fail_closed`.

```ts
const decision = await verifier.verify({
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  handoff_id: "handoff_01",
  requirement: { capability_id: "code.implement" },
  proposed_target: { endpoint_id: "endpoint_agent" },
  principal,
});
expect(decision).toEqual({ kind: "eligible" });
```

- [x] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run packages/exchange-spi/test/target-resolution-contract.test.ts packages/exchange-conformance/test/adapter-profiles.test.ts
```

Expected: FAIL because the target-resolution SPI and conformance profile are absent.

- [x] **Step 3: Implement the minimal SPI and reusable profile**

Export immutable request/decision types, the required capability manifest, and `verifyTargetEligibilityProfile`. Do not add any candidate-list or scoring type.

- [x] **Step 4: Run focused and dependency-boundary tests for GREEN**

```bash
npx vitest run packages/exchange-spi/test/target-resolution-contract.test.ts packages/exchange-conformance/test/adapter-profiles.test.ts packages/exchange-core/test/dependency-boundaries.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass.

- [x] **Step 5: Commit the SPI**

```bash
git add packages/exchange-spi packages/exchange-conformance
git commit -m "feat(spi): add target eligibility verifier"
```

---

### Task 3: Handoff domain lifecycle and immutable Target Binding

**Files:**
- Modify: `packages/exchange-core/src/domain/handoff-types.ts`
- Modify: `packages/exchange-core/src/domain/handoff-commands.ts`
- Modify: `packages/exchange-core/src/domain/handoff-events.ts`
- Modify: `packages/exchange-core/src/domain/handoff-decider.ts`
- Modify: `packages/exchange-core/src/domain/handoff-reducer.ts`
- Modify: `packages/exchange-core/src/domain/handoff-state-codec.ts`
- Modify: `packages/exchange-core/src/domain/index.ts`
- Test: `packages/exchange-core/test/handoff-decider.test.ts`
- Test: `packages/exchange-core/test/handoff-reducer.test.ts`
- Test: `packages/exchange-core/test/handoff-codec.test.ts`

**Interfaces:**
- Consumes: protocol explicit target and Evidence JSON.
- Produces: lifecycle states `target_resolution_pending` and `target_unavailable`; commands `resolve_target` and `report_target_unavailable`; events `target_resolution_requested`, `target_resolved`, and `target_unavailable`; immutable `TargetBinding`; `effectiveHandoffTarget(state)`.

- [ ] **Step 1: Write failing domain tests one behavior at a time**

Cover direct Offer unchanged, Capability Offer pending, pending cannot accept, eligible resolve reaches offered, unavailable becomes terminal, cancel/expire pending, second resolve rejected, and state/event codec round trips.

```ts
const decision = decideHandoff(null, capabilityOffer, context);
expect(decision).toMatchObject({
  accepted: true,
  events: [{ event_type: "workfabric.handoff.target_resolution_requested.v1" }],
});
```

- [ ] **Step 2: Run domain tests and verify RED**

```bash
npx vitest run packages/exchange-core/test/handoff-decider.test.ts packages/exchange-core/test/handoff-reducer.test.ts packages/exchange-core/test/handoff-codec.test.ts
```

Expected: FAIL because the new commands, events, states, and binding codec are absent.

- [ ] **Step 3: Implement minimal domain behavior**

Add the immutable binding and effective-target helper. Keep the original Package unchanged. Make pending and unavailable states reject every interaction not explicitly listed in the design. Reuse `accept_by` for pending expiry.

- [ ] **Step 4: Run domain tests for GREEN**

```bash
npx vitest run packages/exchange-core/test/handoff-decider.test.ts packages/exchange-core/test/handoff-reducer.test.ts packages/exchange-core/test/handoff-codec.test.ts
npm run typecheck
```

Expected: all domain tests and typecheck pass.

- [ ] **Step 5: Commit the domain model**

```bash
git add packages/exchange-core/src/domain packages/exchange-core/test
git commit -m "feat(core): add target binding lifecycle"
```

---

### Task 4: Exchange Application authorization, eligibility, and atomic resolution

**Files:**
- Modify: `packages/exchange-core/src/application/application-dependencies.ts`
- Modify: `packages/exchange-core/src/application/handoff-codec.ts`
- Modify: `packages/exchange-core/src/application/exchange-application.ts`
- Test: `packages/exchange-core/test/exchange-application.test.ts`
- Test: `packages/exchange-core/test/concurrency.integration.test.ts`
- Modify: `packages/adapter-identity-local/src/local-authority-policy.ts`
- Test: `packages/adapter-identity-local/test/local-identity-authority.test.ts`

**Interfaces:**
- Consumes: `TargetEligibilityVerifier` and new validated protocol payloads.
- Produces: authenticated Resolver commands, authority actions `handoff.resolve_target` and `handoff.report_target_unavailable`, eligibility fail-closed behavior, atomic Target Binding commits, and normalized Operation Results.

- [ ] **Step 1: Write failing application tests**

Test authorized/eligible resolution, authority denial before verifier call, ineligible rejection, unavailable temporary failure without persistence, deterministic unavailable outcome persistence, idempotent replay, stale version conflict, and two concurrent resolvers committing one binding.

```ts
expect(await application.handle(resolveEnvelope, authEvidence)).toMatchObject({
  operation_status: "accepted",
  resource: { resource_type: "handoff", resource_version: 2 },
});
expect(eligibility.requests).toHaveLength(1);
```

- [ ] **Step 2: Run application tests and verify RED**

```bash
npx vitest run packages/exchange-core/test/exchange-application.test.ts packages/exchange-core/test/concurrency.integration.test.ts packages/adapter-identity-local/test/local-identity-authority.test.ts
```

Expected: FAIL because application decoding, authority actions, and verifier integration are absent.

- [ ] **Step 3: Implement application integration**

Decode the two interactions, authorize before eligibility, call the verifier only for Resolve Target, map `ineligible` to deterministic `permission_denied`, map `unavailable` to non-persisted `temporarily_unavailable`, and commit through the existing expected-version/idempotency transaction.

- [ ] **Step 4: Run application, integration, and reference tests for GREEN**

```bash
npx vitest run packages/exchange-core/test packages/adapter-identity-local/test
npm run typecheck
```

Expected: all Core and local identity tests pass.

- [ ] **Step 5: Commit application behavior**

```bash
git add packages/exchange-core packages/adapter-identity-local
git commit -m "feat(exchange): apply external target resolutions"
```

---

### Task 5: Public events, read projections, and persistence compatibility

**Files:**
- Modify: `packages/exchange-runtime/src/subscription/protocol-event-builder.ts`
- Modify: `packages/exchange-runtime/src/projection/handoff-projector.ts`
- Modify: `packages/exchange-runtime/src/projection/handoff-read-model.ts`
- Test: `packages/exchange-runtime/test/handoff-projector.test.ts`
- Test: `packages/exchange-runtime/test/subscription-filter.test.ts`
- Test: `packages/exchange-runtime/test/recovery.integration.test.ts`
- Test: `packages/adapter-storage-memory/test/memory-exchange-persistence.test.ts`
- Test: `packages/adapter-storage-postgres/test/postgres-exchange-persistence.test.ts`

**Interfaces:**
- Consumes: new domain events and state codec.
- Produces: safe public Protocol Events and Handoff projections that expose pending/unavailable state and Target Binding without internal candidate facts or scores.

- [ ] **Step 1: Write failing projection and event tests**

Assert pending and resolved events project in order, snapshots retain the Capability Requirement plus separate binding, assignment remains null until `accept`, filters can select the new lifecycle states, and replay across Memory/PostgreSQL JSON persistence preserves all fields.

- [ ] **Step 2: Run affected tests and verify RED**

```bash
npx vitest run packages/exchange-runtime/test packages/adapter-storage-memory/test/memory-exchange-persistence.test.ts packages/adapter-storage-postgres/test/postgres-exchange-persistence.test.ts
```

Expected: FAIL on unknown event/state or missing Target Binding projection.

- [ ] **Step 3: Implement safe event and projection mappings**

Expose only requirement/explicit-target references, provenance IDs, reason code, and resource version. Do not expose private candidate sets, scores, policy internals, `domain_data`, partition positions, or commit IDs.

- [ ] **Step 4: Run runtime and adapter tests for GREEN**

```bash
npx vitest run packages/exchange-runtime/test packages/adapter-storage-memory/test packages/adapter-storage-postgres/test
npm run typecheck
```

Expected: all non-live tests pass; PostgreSQL live tests may remain skipped when `PG_TEST_URL` is absent.

- [ ] **Step 5: Commit runtime compatibility**

```bash
git add packages/exchange-runtime packages/adapter-storage-memory packages/adapter-storage-postgres
git commit -m "feat(runtime): project target resolution facts"
```

---

### Task 6: Public conformance, status, and completion verification

**Files:**
- Modify: `packages/exchange-conformance/src/reference-suite.ts`
- Test: `packages/exchange-conformance/test/reference-suite.test.ts`
- Modify: `protocol/conformance/exchange-contract.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-15-target-resolution-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-target-resolution-implementation.md`

**Interfaces:**
- Consumes: all completed 3A behavior.
- Produces: reusable public compatibility assertions and accurate roadmap status showing 3A complete while HTTP and SDK remain next.

- [ ] **Step 1: Write the failing public reference assertion**

Extend the public-only reference suite with Capability Offer → external Resolve Target → recipient Accept. Assert no private Core import is required and the original requirement plus binding remain queryable.

- [ ] **Step 2: Run reference and conformance tests and verify RED**

```bash
npx vitest run packages/exchange-conformance/test/reference-suite.test.ts tools/conformance/test
npm run conformance
```

Expected: FAIL until the public reference flow and Exchange contract checklist include Target Resolution.

- [ ] **Step 3: Complete public conformance and update status docs**

Mark every checklist item in this plan complete. Update the roadmap to say `3A Target Resolution Protocol/Core` is complete and `3B HTTP Service Binding` is next; do not mark Phase 3 complete.

- [ ] **Step 4: Run full verification**

```bash
npm run verify
npm run verify:exchange
git diff --check
```

Expected: typecheck passes, every non-live test passes, conformance is fully green, and the diff has no whitespace errors.

- [ ] **Step 5: Review the complete diff and commit**

```bash
git diff --stat
git status --short
git add README.md docs protocol packages tools
git commit -m "feat: complete target resolution foundation"
```

- [ ] **Step 6: Push the branch**

```bash
git push origin codex/exchange-core-design
```
