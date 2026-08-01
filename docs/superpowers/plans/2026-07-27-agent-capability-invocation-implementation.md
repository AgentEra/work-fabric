# Agent Capability Invocation Implementation Plan

> **Execution:** implement task-by-task with `superpowers:executing-plans`.

**Goal:** Let an external Agent decision body request a dynamically discovered
Network Citizen capability through an auxiliary Work Fabric Handoff, receive a
typed result, continue reasoning, and remain solely responsible for the
original Handoff and final human-facing answer.

**Architecture:** Wire-neutral turn and invocation contracts live in
`agent-runtime-spi`. A new `agent-capability-runtime` package performs
authorized Catalog disclosure, contract binding, auxiliary Handoff creation,
result waiting and validation behind narrow ports. `agent-runtime-host` owns a
bounded sequential continuation loop but receives the invocation port by
injection. The Agently adapter owns its versioned worker protocol and Python
prompt/decoder. Neither Core nor the Host imports Feishu, Agently internals,
YAML or a vendor SDK.

**Compatibility:** Existing `AgentRuntimeDriver.execute()` protocol v1 remains
valid. Capability-aware drivers opt into a separate turn interface. Existing
Runtime state adapters remain source-compatible; invocation persistence uses a
separate injected store.

## Global constraints

- The original Agent remains responsible for its Handoff while auxiliary
  capability Handoffs run; do not use `handoff.transfer`.
- The Agent produces structured invocation intent and final language.
- The Provider produces typed facts and stable failures, never assistant copy.
- Discovery does not grant invocation Authority.
- Catalog summary, full contract, grant, Handoff offer and Result reads are
  separately authorized.
- Contract digest, capability version and selected Citizen/Endpoint are frozen
  for one invocation.
- At most four sequential invocations per original Handoff.
- Cancellation and the original `result_due_at` bound discovery, invocation
  and continuation.
- Provider output is inert JSON data, never executable instructions.
- No Feishu credential, token or vendor client crosses these interfaces.
- Every production mutation follows RED, GREEN, focused regression and commit.

---

## Task 1: Define capability-aware Agent turn and invocation contracts

**Files**

- Modify: `packages/agent-runtime-spi/src/driver.ts`
- Create: `packages/agent-runtime-spi/src/capability-invocation.ts`
- Modify: `packages/agent-runtime-spi/src/index.ts`
- Test: `packages/agent-runtime-spi/test/capability-invocation.test.ts`

**Produce**

```ts
export interface CapabilityInvocationRequest {
  readonly invocation_id: string;
  readonly original_handoff_id: string;
  readonly thread_id: string;
  readonly capability_id: string;
  readonly version_constraint: string;
  readonly input: RuntimeJsonObject;
  readonly reason: string;
  readonly deadline: string;
}

export interface CapabilityCandidate {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly capability_id: string;
  readonly capability_version: string;
  readonly contract_digest: `sha256:${string}`;
}

export type CapabilityInvocationResult =
  | {
      readonly outcome: "succeeded";
      readonly invocation_id: string;
      readonly auxiliary_handoff_id: string;
      readonly candidate: CapabilityCandidate;
      readonly data: RuntimeJsonObject;
      readonly artifacts: readonly RuntimeJsonObject[];
    }
  | {
      readonly outcome: "rejected" | "failed";
      readonly invocation_id: string;
      readonly auxiliary_handoff_id: string | null;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface CapabilityInvocationPort {
  discover(
    requirement: CapabilityRequirement,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]>;
  invoke(
    request: CapabilityInvocationRequest,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationResult>;
}

export type RuntimeDriverTurn =
  | { readonly kind: "final"; readonly response: RuntimeDriverResult }
  | {
      readonly kind: "capability_request";
      readonly request: {
        readonly invocation_id: string;
        readonly capability_id: string;
        readonly version_constraint: string;
        readonly input: RuntimeJsonObject;
        readonly reason: string;
      };
    };

export interface CapabilityAwareAgentRuntimeDriver {
  executeTurn(
    task: RuntimeTaskPackage,
    continuation: RuntimeCapabilityContinuation | null,
    progress: (update: RuntimeProgress) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDriverTurn>;
}
```

Validation must reject unknown fields, unsafe JSON, invalid IDs/digests,
unbounded reason/message values and invalid timestamps. Results are cloned and
deep-frozen.

**TDD**

1. Write exact positive/negative contract tests.
2. Run:

   ```bash
   npx vitest run packages/agent-runtime-spi/test/capability-invocation.test.ts
   ```

   Expect RED because exports do not exist.
3. Implement the smallest wire-neutral contracts and validators.
4. Run the focused test plus existing SPI contracts and typecheck.
5. Commit:

   ```bash
   git commit -m "feat(agent): define capability invocation contracts"
   ```

---

## Task 2: Add durable invocation state ports and adapters

**Files**

- Create: `packages/agent-runtime-spi/src/capability-state.ts`
- Modify: `packages/agent-runtime-spi/src/index.ts`
- Modify: `packages/adapter-agent-runtime-memory/src/memory-agent-runtime-state-store.ts`
- Modify: `packages/adapter-agent-runtime-sqlite/src/sqlite-agent-runtime-state-store.ts`
- Create: `packages/adapter-agent-runtime-sqlite/migrations/002_capability_invocations.sql`
- Modify: `packages/adapter-agent-runtime-sqlite/src/migrations.ts`
- Test: `packages/adapter-agent-runtime-memory/test/capability-state.test.ts`
- Test: `packages/adapter-agent-runtime-sqlite/test/capability-state.test.ts`
- Test: `packages/adapter-agent-runtime-sqlite/test/migrations.test.ts`

**Behavior**

- Separate `AgentCapabilityInvocationStore` port; do not add required methods
  to `AgentRuntimeStateStore`.
- Unique `(tenant_id, original_handoff_id, invocation_id)`.
- Immutable request digest and contract binding.
- States:

  ```text
  requested -> offered -> waiting -> succeeded | rejected | failed | cancelled
  ```

- Every update matches owner + monotonic fencing token + expected state.
- Result/failure is restart recoverable and bounded.
- SQLite migration is forward-only, tenant-keyed and idempotent.

**TDD**

1. Add one reusable behavior suite and run against Memory first; expect RED.
2. Implement Memory atomically.
3. Run the same suite against SQLite; expect RED.
4. Add migration and SQLite adapter.
5. Run adapter regressions and typecheck.
6. Commit:

   ```bash
   git commit -m "feat(agent): persist capability invocation lifecycle"
   ```

---

## Task 3: Implement the Handoff-backed invocation coordinator

**Files**

- Create: `packages/agent-capability-runtime/package.json`
- Create: `packages/agent-capability-runtime/src/contracts.ts`
- Create: `packages/agent-capability-runtime/src/catalog-resolver.ts`
- Create: `packages/agent-capability-runtime/src/handoff-invocation-port.ts`
- Create: `packages/agent-capability-runtime/src/index.ts`
- Test: `packages/agent-capability-runtime/test/catalog-resolver.test.ts`
- Test: `packages/agent-capability-runtime/test/handoff-invocation-port.test.ts`
- Modify: `package-lock.json`

**Injected ports**

```ts
interface InvocationAuthorityProvider {
  authorize(input: NormalizedInvocationAuthorityRequest, signal: AbortSignal):
    Promise<RuntimeJsonObject>;
}

interface InvocationSchemaResolver {
  load(uri: string, digest: `sha256:${string}`, signal: AbortSignal):
    Promise<unknown>;
}

interface AuxiliaryHandoffWaiter {
  wait(input: BoundAuxiliaryHandoff, signal: AbortSignal):
    Promise<AuxiliaryHandoffTerminal>;
}
```

**Flow**

1. `CitizenClient.list()` by capability and executable availability.
2. Load each authorized full declaration contract separately.
3. Keep deterministic candidate order; no scoring or recommendation.
4. Validate model input against the immutable input Schema digest.
5. Request a down-scoped Authority evidence object.
6. Offer an auxiliary, capability-targeted Handoff in the original thread.
7. Explicitly resolve the already-selected Endpoint through normal Authority.
8. Persist the returned Handoff ID and frozen binding.
9. Wait through the injected canonical waiter.
10. Validate terminal Result against the bound output Schema and normalize it.

The Work Reference URI is deterministically derived from original Handoff ID
and invocation ID. The offer uses the invocation tuple as idempotency key and
sets correlation/causation to the original collaboration chain. It never uses
transfer.

**TDD**

Test discovery concealment, contract digest mismatch, input rejection, grant
denial, offer replay, resolve conflict convergence, cancellation, deadline,
terminal failure mapping, output mismatch and no vendor imports.

Commit:

```bash
git commit -m "feat(agent): invoke capabilities through auxiliary handoffs"
```

---

## Task 4: Add a bounded continuation loop to Agent Runtime Host

**Files**

- Create: `packages/agent-runtime-host/src/capability-loop.ts`
- Modify: `packages/agent-runtime-host/src/runtime-host.ts`
- Modify: `packages/agent-runtime-host/src/runtime-composition.ts`
- Modify: `packages/agent-runtime-host/src/index.ts`
- Test: `packages/agent-runtime-host/test/capability-loop.test.ts`
- Test: `packages/agent-runtime-host/test/runtime-host-capability.test.ts`

**Behavior**

- New optional dependencies:

  ```ts
  readonly turn_driver?: CapabilityAwareAgentRuntimeDriver;
  readonly capability_invocations?: CapabilityInvocationPort;
  readonly capability_invocation_store?: AgentCapabilityInvocationStore;
  readonly capability_limits?: {
    readonly max_invocations_per_handoff: number; // maximum 4
    readonly allowed_namespaces: readonly string[];
  };
  ```

- Existing drivers follow the unchanged one-shot `execute()` path.
- Capability-aware drivers run sequential turns only.
- Each request:
  - has a unique invocation ID within the original Handoff;
  - matches configured namespace and role scope;
  - is persisted before external work;
  - invokes the injected port;
  - persists the normalized result;
  - resumes with inert continuation data.
- The fifth request, repeated invocation ID, expired deadline, cancellation,
  unavailable port or unexpected driver union fails the local run without
  fabricating an original Handoff Result.
- Only a `final` turn is mapped to the original Handoff Result.

**TDD**

Add focused tests proving original responsibility remains accepted while the
auxiliary invocation runs, no `transfer` call exists, final copy comes only
from the driver, and restart resumes from persisted invocation result without
repeating the external side effect.

Commit:

```bash
git commit -m "feat(agent): run bounded capability continuation turns"
```

---

## Task 5: Version the Agently worker protocol for capability turns

**Files**

- Modify: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/agently-process-driver.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/index.ts`
- Test: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`
- Test: `packages/adapter-agent-runtime-agently/test/agently-process-driver.test.ts`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/runner.py`
- Test: `runtimes/agently-worker/tests/test_protocol.py`
- Test: `runtimes/agently-worker/tests/test_assistant.py`

**Protocol**

- Preserve `workfabric.agent-runtime/1` for one-shot drivers.
- Add `workfabric.agent-runtime/2` request/terminal union.
- Terminal records are exactly one of:

  ```text
  final
  capability_request
  failed
  ```

- A continuation request contains the original task, previous normalized
  request and typed result, never credentials or raw Provider internals.
- Python produces only the structured turn; TypeScript performs network I/O.
- Prompt explicitly treats Provider output as untrusted data and requires the
  final response to be Agent-authored.

Run TypeScript and Python tests, then commit:

```bash
git commit -m "feat(agently): support capability continuation turns"
```

---

## Task 6: Compose capability invocation without vendor coupling

**Files**

- Modify: `packages/agent-runtime-host/src/config.ts`
- Modify: `packages/agent-runtime-host/src/configuration-loader.ts`
- Modify: `examples/agently-agent-runtime/src/main.ts`
- Modify: `examples/agently-agent-runtime/package.json`
- Modify: example configuration under `config/`
- Test: `examples/agently-agent-runtime/test/composition.test.ts`
- Test: `examples/agently-agent-runtime/test/documentation-contract.test.ts`

**Configuration**

Configuration may enable the Agent-side invocation boundary and set:

- maximum sequential invocations, bounded to `1..4`;
- allowed capability namespaces;
- dedicated subscription ID / polling bounds;
- invocation state provider reference.

It must not list live Provider capabilities, contain Feishu credentials or
select a vendor backend. Runtime discovery remains authoritative.

Composition injects `HandoffCapabilityInvocationPort` into Host. A disabled
configuration retains the exact existing one-shot behavior.

Commit:

```bash
git commit -m "feat(agent): compose dynamic capability invocation"
```

---

## Task 7: Prove the auxiliary-Handoff flow through public boundaries

**Files**

- Create: `examples/agently-agent-runtime/test/capability-invocation.e2e.test.ts`
- Add or reuse test-only fake Capability Provider under the same test folder.
- Modify: `docs/guides/agently-agent-runtime.md`
- Modify: `docs/architecture/network-citizens.md`
- Modify: `docs/roadmap.md`

**E2E**

Use real in-memory Exchange, HTTP, TypeScript SDK, Citizen Directory,
Agent Runtime Host and a fake external Provider:

```text
Original Intake Handoff accepted by Daily Assistant
-> Driver emits capability_request
-> Catalog full contract read
-> auxiliary capability Handoff offered and resolved
-> fake Provider accepts and returns typed Result
-> Driver continuation emits final
-> original Handoff Result contains only Agent-authored language
```

Also prove:

- unauthorized discovery/invocation creates no auxiliary Handoff;
- malformed Provider output creates no original success Result;
- cancellation aborts the wait;
- duplicate recovery returns the prior invocation result without duplicating
  Provider execution;
- no transfer occurs and original responsibility stays with the Agent.

Run:

```bash
npm run typecheck
npx vitest run \
  packages/agent-runtime-spi/test \
  packages/agent-capability-runtime/test \
  packages/agent-runtime-host/test \
  packages/adapter-agent-runtime-agently/test \
  examples/agently-agent-runtime/test
npm run conformance
```

Commit:

```bash
git commit -m "test(agent): prove auxiliary capability handoff loop"
```

---

## Task 8: Release verification and next boundary

1. Run `npm run verify` outside the restricted listener sandbox when required.
2. Run Python worker tests through the repository's existing Python command.
3. Run `git diff --check` and static dependency/sensitive-data gates.
4. Update the Network Citizen design status to mark Agent invocation complete
   and Feishu Provider as the next independent subproject.
5. Commit any final documentation-only changes.

The following phase will implement the Feishu Capability/Context Providers
behind these contracts. It must not require changes to Exchange Core,
Network Citizen classification, Agent Host responsibility ownership or the
Channel module.
