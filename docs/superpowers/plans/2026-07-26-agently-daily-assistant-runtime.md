# Agently Daily Assistant Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a tenant-shared Daily Assistant Agent to Work Fabric through the existing Agent Gateway, execute its accepted Handoffs in an external Agently Python worker, and complete the durable Ack/Accept/Status/Result loop without changing WFPP Core semantics.

**Architecture:** A provider-neutral TypeScript Runtime Host consumes the public Agent Gateway and SDK, applies deterministic responsibility policy, persists its own recovery state, and calls an `AgentRuntimeDriver` SPI. The first Driver launches one bounded Agently Python process per execution. Role, identity, Capability, authority, Runtime state, Workspace, and future long-term memory remain separate concerns.

**Tech Stack:** Node.js `>=22.20.0`, TypeScript `7.0.2`, Vitest `4.1.10`, built-in `node:sqlite`, existing Work Fabric Configuration/SDK/Agent Gateway packages, Python `>=3.10`, `uv`, Agently `4.1.4.1`, pytest `9.1.1`, pytest-asyncio `1.4.0`.

## Global Constraints

- Do not modify WFPP schemas, Handoff state semantics, Exchange Core responsibility rules, or the Work Fabric service's execution boundary.
- Work Fabric Core and `service-node` must never import Agently or launch model/tool execution.
- Runtime code may use only public Work Fabric SDK and Agent Gateway interfaces; it must not query Work Fabric SQLite/PostgreSQL directly.
- Persist Delivery receipt before Ack; Delivery Ack never means responsibility acceptance.
- Only deterministic Host policy may accept or decline. Agently and the model never choose whether responsibility is accepted.
- Execute only an explicitly targeted, authoritative, accepted Handoff and create at most one logical Runtime run per Handoff.
- Store Runtime recovery state in a separate State Provider. The first local durable provider is a separate SQLite database.
- Create one isolated Agently Workspace per tenant/Handoff. Do not treat Workspace as canonical Work Fabric Context or long-term team memory.
- Carry the public Context reference as metadata only. The first version has no Context/Memory materialization Provider and must not read a Context Repository directly.
- Do not enable shell, Python, Node, browser, filesystem-write, MCP, or arbitrary Actions in the first version.
- Role Profile and Capability declarations never grant authority. Authentication, Actor representation, Endpoint ownership, Handoff access, and command authorization remain explicit and default-deny.
- Secrets are exact environment references resolved through `SecretResolver`; model and Work Fabric tokens must not appear in task JSON, prompts, Workspace, logs, metrics, status, or Result.
- Child-process input, NDJSON output, line size, event count, nesting depth, wall time, cancellation grace, and captured stderr are all bounded.
- Use Agently `4.1.4.1` and one async structured request; do not add TriggerFlow until the work genuinely requires branching or durable pause/resume.
- Preserve the user's unrelated `.gitignore` modification and untracked `.DS_Store`.

## File and package map

| Unit | Responsibility |
|---|---|
| `packages/agent-runtime-spi` | Provider-neutral task, Driver, progress/result, Role Profile, and Runtime State contracts |
| `packages/agent-runtime-conformance` | Reusable State Provider and Driver contract tests |
| `packages/adapter-agent-runtime-memory` | Deterministic in-memory Runtime State Provider for tests |
| `packages/adapter-agent-runtime-sqlite` | Durable local Runtime State Provider and forward-only migrations |
| `packages/adapter-authority-agent-runtime` | Default-deny self-Endpoint and assigned-Handoff policy for configured Agent Runtimes |
| `packages/agent-runtime-host` | Config validation, package loading, policy, recovery, orchestration, and WFPP mapping |
| `packages/adapter-agent-runtime-agently` | Bounded Node child-process Driver and NDJSON validation |
| `runtimes/agently-worker` | Independent Python package using Agently Request and Workspace APIs |
| `examples/agently-agent-runtime` | Runnable Runtime composition and deterministic fake-worker E2E fixture |
| `examples/config/agent-runtime-agently.yaml` | Separate Runtime deployment configuration |
| `docs/guides/agently-agent-runtime.md` | Setup, identity/authority, model, startup, verification, and troubleshooting |

---

### Task 1: Define the provider-neutral Agent Runtime SPI

**Files:**
- Create: `packages/agent-runtime-spi/package.json`
- Create: `packages/agent-runtime-spi/src/json.ts`
- Create: `packages/agent-runtime-spi/src/driver.ts`
- Create: `packages/agent-runtime-spi/src/role.ts`
- Create: `packages/agent-runtime-spi/src/state.ts`
- Create: `packages/agent-runtime-spi/src/index.ts`
- Test: `packages/agent-runtime-spi/test/contracts.test.ts`

**Interfaces:**
- Consumes: no Work Fabric Runtime implementation package and no Agently package.
- Produces: `AgentRuntimeDriver`, `AgentRuntimeDriverFactory`, `RuntimeTaskPackage`, `RuntimeProgress`, `RuntimeDriverResult`, `AgentRoleProfile`, and `AgentRuntimeStateStore`.

- [ ] **Step 1: Write failing contract tests for bounded, immutable SPI values**

```ts
import {
  defineAgentRoleProfile,
  validateDriverManifest,
  type AgentRuntimeDriver,
  type RuntimeTaskPackage,
} from "../src/index.js";

it("defines an immutable versioned role without authority fields", () => {
  const profile = defineAgentRoleProfile({
    role_id: "daily-assistant",
    version: 1,
    display_name: "日常助理 Agent",
    description: "团队共享的协作入口与日常事务助理",
    capability_ids: [
      "collaboration.request.intake",
      "information.synthesis",
      "collaboration.handoff.draft",
    ],
  });
  expect(Object.isFrozen(profile)).toBe(true);
  expect(profile).not.toHaveProperty("authority");
});

it("rejects a Driver manifest with duplicate capabilities", () => {
  expect(() => validateDriverManifest({
    driver_type: "test",
    protocol_version: "1",
    capability_ids: ["information.synthesis", "information.synthesis"],
  })).toThrow(/duplicate/i);
});

it("requires execution to receive cancellation and a progress sink", () => {
  const driver: AgentRuntimeDriver = {
    manifest: validateDriverManifest({
      driver_type: "test",
      protocol_version: "1",
      capability_ids: ["information.synthesis"],
    }),
    execute: async (_task: RuntimeTaskPackage, _progress, _signal) => ({
      summary: [{ kind: "text", media_type: "text/plain", text: "done" }],
      artifacts: [],
      evidence: [],
      extensions: {},
    }),
  };
  expect(driver.manifest.driver_type).toBe("test");
});
```

- [ ] **Step 2: Run the SPI tests and verify they fail**

Run:

```bash
npx vitest run packages/agent-runtime-spi/test/contracts.test.ts
```

Expected: FAIL because `packages/agent-runtime-spi` and its exports do not exist.

- [ ] **Step 3: Implement the neutral JSON, Driver, and Role contracts**

Create the package with the same private workspace metadata pattern as
`packages/agent-gateway/package.json`. Define these exact public shapes:

```ts
export type RuntimeJsonPrimitive = string | number | boolean | null;
export type RuntimeJsonValue =
  | RuntimeJsonPrimitive
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };
export type RuntimeJsonObject = {
  readonly [key: string]: RuntimeJsonValue;
};

export interface RuntimeTaskPackage {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly stream_version: number;
  readonly role: AgentRoleProfile;
  readonly capability_id: string | null;
  readonly intent: readonly RuntimeJsonObject[];
  readonly context_reference: RuntimeJsonObject | null;
  readonly authority_scope: RuntimeJsonObject;
  readonly acceptance_criteria: readonly RuntimeJsonObject[];
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
  readonly workspace_path: string;
}

export interface RuntimeProgress {
  readonly sequence: number;
  readonly progress: number | null;
  readonly message: string;
  readonly observed_at: string;
}

export interface RuntimeDriverResult {
  readonly summary: readonly RuntimeJsonObject[];
  readonly artifacts: readonly RuntimeJsonObject[];
  readonly evidence: readonly RuntimeJsonObject[];
  readonly extensions: RuntimeJsonObject;
}

export interface AgentRuntimeDriverManifest {
  readonly driver_type: string;
  readonly protocol_version: "1";
  readonly capability_ids: readonly string[];
}

export interface AgentRuntimeDriver {
  readonly manifest: Readonly<AgentRuntimeDriverManifest>;
  execute(
    task: RuntimeTaskPackage,
    progress: (update: RuntimeProgress) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDriverResult>;
}

export interface AgentRuntimeDriverFactory<Config = unknown> {
  readonly type: string;
  validate(value: unknown, path: string): Config;
  create(config: Config): Promise<AgentRuntimeDriver>;
}

export interface AgentRoleProfile {
  readonly role_id: string;
  readonly version: number;
  readonly display_name: string;
  readonly description: string;
  readonly capability_ids: readonly string[];
}
```

Implement `validateDriverManifest()` and `defineAgentRoleProfile()` with:

- trimmed IDs no longer than 128 characters;
- Capability IDs matching
  `^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$`;
- positive safe-integer role version;
- non-empty unique Capability arrays;
- deep clone and deep freeze;
- exact allowed keys so credentials or authority cannot be hidden in a role.

- [ ] **Step 4: Define the exact Runtime State contract**

Add these records and methods to `src/state.ts`:

```ts
export type RuntimeRunState =
  | "received"
  | "accepted"
  | "running"
  | "result_ready"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeDeliveryRecord {
  readonly tenant_id: string;
  readonly delivery_id: string;
  readonly handoff_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly received_at: string;
  readonly acknowledged_at: string | null;
}

export interface RuntimeRunRecord {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly state: RuntimeRunState;
  readonly attempt: number;
  readonly owner: string | null;
  readonly fencing_token: number;
  readonly lease_expires_at: string | null;
  readonly last_progress_sequence: number;
  readonly result_digest: string | null;
  readonly result: RuntimeDriverResult | null;
  readonly failure_code: string | null;
  readonly updated_at: string;
}

export interface RuntimeCommandRecord {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly command: "accept" | "decline" | "status" | "result";
  readonly idempotency_key: string;
  readonly resource_version: number;
  readonly recorded_at: string;
}

export interface AgentRuntimeStateStore {
  recordDelivery(input: RuntimeDeliveryRecord): Promise<{
    readonly created: boolean;
    readonly record: RuntimeDeliveryRecord;
  }>;
  markDeliveryAcknowledged(
    tenantId: string,
    deliveryId: string,
    acknowledgedAt: string,
  ): Promise<boolean>;
  createRunIfAbsent(
    tenantId: string,
    handoffId: string,
    now: string,
  ): Promise<{ readonly created: boolean; readonly run: RuntimeRunRecord }>;
  claimRun(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly now: string;
    readonly lease_seconds: number;
    readonly allowed_states: readonly RuntimeRunState[];
  }): Promise<RuntimeRunRecord | null>;
  renewRun(
    tenantId: string,
    handoffId: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  transitionRun(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly fencing_token: number;
    readonly expected_state: RuntimeRunState;
    readonly next_state: RuntimeRunState;
    readonly now: string;
    readonly result_digest?: string;
    readonly result?: RuntimeDriverResult;
    readonly failure_code?: string;
  }): Promise<boolean>;
  checkpointProgress(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly fencing_token: number;
    readonly sequence: number;
    readonly now: string;
  }): Promise<boolean>;
  recordCommand(input: RuntimeCommandRecord): Promise<{
    readonly created: boolean;
    readonly record: RuntimeCommandRecord;
  }>;
  listCommands(
    tenantId: string,
    handoffId: string,
  ): Promise<readonly RuntimeCommandRecord[]>;
  getRun(tenantId: string, handoffId: string): Promise<RuntimeRunRecord | null>;
  listRecoverable(
    tenantId: string,
    now: string,
    limit: number,
  ): Promise<readonly RuntimeRunRecord[]>;
  close(): Promise<void>;
}
```

Document in the interface comments that every mutating run operation after
`claimRun` must match both `owner` and monotonic `fencing_token`.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
npx vitest run packages/agent-runtime-spi/test/contracts.test.ts
npm run typecheck
git add packages/agent-runtime-spi
git commit -m "feat(agent): define runtime extension contracts"
```

Expected: tests and typecheck PASS; commit contains only the new SPI package.

---

### Task 2: Add reusable conformance tests and the memory State Provider

**Files:**
- Create: `packages/agent-runtime-conformance/package.json`
- Create: `packages/agent-runtime-conformance/src/state-store-contract.ts`
- Create: `packages/agent-runtime-conformance/src/index.ts`
- Create: `packages/adapter-agent-runtime-memory/package.json`
- Create: `packages/adapter-agent-runtime-memory/src/memory-agent-runtime-state-store.ts`
- Create: `packages/adapter-agent-runtime-memory/src/index.ts`
- Test: `packages/adapter-agent-runtime-memory/test/state-store.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeStateStore` and record types from `@work-fabric/agent-runtime-spi`.
- Produces: `verifyAgentRuntimeStateStoreContract()` and `MemoryAgentRuntimeStateStore`.

- [ ] **Step 1: Write the provider conformance suite**

Export this harness from `agent-runtime-conformance`:

```ts
export interface RuntimeStateStoreFixture {
  readonly store: AgentRuntimeStateStore;
  close(): Promise<void>;
}

export function verifyAgentRuntimeStateStoreContract(
  name: string,
  create: () => Promise<RuntimeStateStoreFixture>,
): void {
  describe(name, () => {
    it("deduplicates Delivery and command records", async () => {
      const fixture = await create();
      try {
        const first = await fixture.store.recordDelivery(delivery());
        const duplicate = await fixture.store.recordDelivery(delivery());
        expect(first.created).toBe(true);
        expect(duplicate).toEqual({ created: false, record: first.record });

        const command = await fixture.store.recordCommand(commandRecord());
        const replay = await fixture.store.recordCommand(commandRecord());
        expect(command.created).toBe(true);
        expect(replay).toEqual({ created: false, record: command.record });
      } finally {
        await fixture.close();
      }
    });

    it("creates one logical run and fences stale owners", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        const first = await fixture.store.claimRun(claim("host-a", NOW));
        expect(first?.fencing_token).toBe(1);
        const second = await fixture.store.claimRun(
          claim("host-b", "2026-07-26T01:01:01.000Z"),
        );
        expect(second?.fencing_token).toBe(2);
        expect(await fixture.store.transitionRun({
          tenant_id: "tenant-1",
          handoff_id: "handoff-1",
          owner: "host-a",
          fencing_token: 1,
          expected_state: "received",
          next_state: "accepted",
          now: "2026-07-26T01:01:02.000Z",
        })).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it("lists expired or unowned non-terminal runs for recovery", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        const recoverable = await fixture.store.listRecoverable(
          "tenant-1",
          "2026-07-26T01:05:00.000Z",
          10,
        );
        expect(recoverable.map((run) => run.handoff_id)).toEqual(["handoff-1"]);
      } finally {
        await fixture.close();
      }
    });
  });
}
```

Provide local helper factories in the same file with exact ISO timestamps,
valid records, and a two-second lease. Add cases for:

- Ack timestamp is write-once;
- progress sequence must strictly increase;
- invalid state transitions fail closed;
- terminal runs are never recoverable;
- distinct status idempotency keys can be recorded for increasing progress;
- replaying the same idempotency key with a different command or resource
  version throws, while distinct status idempotency keys remain valid.

- [ ] **Step 2: Write the memory adapter test and verify failure**

```ts
import { verifyAgentRuntimeStateStoreContract } from "@work-fabric/agent-runtime-conformance";
import { MemoryAgentRuntimeStateStore } from "../src/index.js";

verifyAgentRuntimeStateStoreContract("memory Agent Runtime state", async () => {
  const store = new MemoryAgentRuntimeStateStore();
  return { store, close: () => store.close() };
});
```

Run:

```bash
npx vitest run packages/adapter-agent-runtime-memory/test/state-store.test.ts
```

Expected: FAIL because `MemoryAgentRuntimeStateStore` does not exist.

- [ ] **Step 3: Implement the memory adapter**

Use cloned records and tenant-qualified keys:

```ts
const deliveryKey = (tenant: string, delivery: string) =>
  JSON.stringify([tenant, delivery]);
const runKey = (tenant: string, handoff: string) =>
  JSON.stringify([tenant, handoff]);
const commandKey = (
  tenant: string,
  handoff: string,
  idempotencyKey: string,
) => JSON.stringify([tenant, handoff, idempotencyKey]);
```

Implement all SPI methods with:

- a synchronous private mutation queue to preserve deterministic ordering;
- `structuredClone` on every read and write;
- one Delivery identity per tenant;
- one run identity per tenant/Handoff;
- one recorded command outcome per tenant/Handoff/idempotency key;
- monotonic fencing when an absent or expired lease is claimed;
- explicit allowed state-transition table;
- no timers or background work.

`close()` clears all maps and makes subsequent calls throw
`Runtime state store is closed`.

- [ ] **Step 4: Run conformance and type checks**

Run:

```bash
npx vitest run packages/agent-runtime-spi/test packages/adapter-agent-runtime-memory/test
npm run typecheck
```

Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime-conformance packages/adapter-agent-runtime-memory
git commit -m "feat(agent): add runtime state conformance"
```

---

### Task 3: Implement the independent SQLite Runtime State Provider

**Files:**
- Create: `packages/adapter-agent-runtime-sqlite/package.json`
- Create: `packages/adapter-agent-runtime-sqlite/migrations/001_agent_runtime.sql`
- Create: `packages/adapter-agent-runtime-sqlite/src/sqlite-session.ts`
- Create: `packages/adapter-agent-runtime-sqlite/src/migrations.ts`
- Create: `packages/adapter-agent-runtime-sqlite/src/sqlite-agent-runtime-state-store.ts`
- Create: `packages/adapter-agent-runtime-sqlite/src/index.ts`
- Test: `packages/adapter-agent-runtime-sqlite/test/state-store.test.ts`
- Test: `packages/adapter-agent-runtime-sqlite/test/migrations.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeStateStore` and the shared conformance suite.
- Produces: `SqliteAgentRuntimeStateStore`, `migrateAgentRuntimeSqlite()`, and an owned SQLite session isolated from Work Fabric storage.

- [ ] **Step 1: Write failing SQLite conformance and reopen tests**

```ts
verifyAgentRuntimeStateStoreContract("SQLite Agent Runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fabric-agent-runtime-"));
  const location = join(directory, "runtime.db");
  const store = new SqliteAgentRuntimeStateStore({ location });
  return {
    store,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

it("reopens durable Delivery and run state", async () => {
  const location = join(directory, "runtime.db");
  const first = new SqliteAgentRuntimeStateStore({ location });
  await first.recordDelivery(delivery());
  await first.createRunIfAbsent("tenant-1", "handoff-1", NOW);
  await first.close();

  const reopened = new SqliteAgentRuntimeStateStore({ location });
  expect(await reopened.getRun("tenant-1", "handoff-1")).toMatchObject({
    state: "received",
  });
  expect((await reopened.recordDelivery(delivery())).created).toBe(false);
  await reopened.close();
});
```

Run:

```bash
npx vitest run packages/adapter-agent-runtime-sqlite/test
```

Expected: FAIL because the SQLite package does not exist.

- [ ] **Step 2: Add a Runtime-owned migration**

Create only Runtime tables in `001_agent_runtime.sql`:

```sql
CREATE TABLE agent_runtime_deliveries (
  tenant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acknowledged_at TEXT,
  PRIMARY KEY (tenant_id, delivery_id)
);

CREATE TABLE agent_runtime_runs (
  tenant_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'received','accepted','running','result_ready',
      'succeeded','failed','cancelled'
    )
  ),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  owner TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  last_progress_sequence INTEGER NOT NULL CHECK (last_progress_sequence >= 0),
  result_digest TEXT,
  result_json TEXT,
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id)
);

CREATE TABLE agent_runtime_commands (
  tenant_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('accept','decline','status','result')),
  idempotency_key TEXT NOT NULL,
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id, idempotency_key)
);

CREATE INDEX agent_runtime_runs_recovery
  ON agent_runtime_runs (tenant_id, state, lease_expires_at, updated_at);

CREATE INDEX agent_runtime_commands_by_handoff
  ON agent_runtime_commands (tenant_id, handoff_id, command, recorded_at);
```

Reuse the safe session behavior from
`packages/adapter-storage-sqlite/src/sqlite-session.ts`, but copy only the
focused connection/migration utilities into this package. Do not depend on or
reuse the Work Fabric database location.

- [ ] **Step 3: Implement transactional Store methods**

Implement every method with prepared statements and `BEGIN IMMEDIATE`.
Critical claim SQL must atomically increment fencing:

```sql
UPDATE agent_runtime_runs
SET owner = ?,
    fencing_token = fencing_token + 1,
    lease_expires_at = ?,
    attempt = attempt + 1,
    updated_at = ?
WHERE tenant_id = ?
  AND handoff_id = ?
  AND state IN (/* validated placeholders */)
  AND (owner IS NULL OR lease_expires_at <= ?)
RETURNING *
```

Every renew, transition, and progress checkpoint statement must include:

```sql
WHERE tenant_id = ?
  AND handoff_id = ?
  AND owner = ?
  AND fencing_token = ?
```

Reject checksum changes to an already-applied migration. Normalize rows into
frozen SPI records and never return a live SQLite object. Serialize only a
validated, bounded `RuntimeDriverResult` into `result_json`; require it for
`result_ready` and reject it for states before `result_ready`.

- [ ] **Step 4: Run adapter and full TypeScript verification**

Run:

```bash
npx vitest run packages/adapter-agent-runtime-sqlite/test
npm run typecheck
npm run conformance
```

Expected: SQLite conformance, reopen, migration-order, checksum, and fencing
tests PASS; protocol conformance remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-agent-runtime-sqlite
git commit -m "feat(agent): persist external runtime state"
```

---

### Task 4: Add a default-deny authority adapter for configured Agent Runtimes

**Files:**
- Create: `packages/adapter-authority-agent-runtime/package.json`
- Create: `packages/adapter-authority-agent-runtime/src/config.ts`
- Create: `packages/adapter-authority-agent-runtime/src/handoff-access.ts`
- Create: `packages/adapter-authority-agent-runtime/src/agent-runtime-authority-policy.ts`
- Create: `packages/adapter-authority-agent-runtime/src/index.ts`
- Test: `packages/adapter-authority-agent-runtime/test/authority-policy.test.ts`
- Modify: `packages/service-node/package.json`
- Modify: `packages/service-node/src/configuration-loader.ts`
- Modify: `packages/service-node/src/compose.ts`
- Test: `packages/service-node/test/agent-runtime-authority.integration.test.ts`

**Interfaces:**
- Consumes: authenticated `ResolvedPrincipal`, `AuthorityRequest`, and a read-only `HandoffReadModelStore`.
- Produces: `AgentRuntimeAuthorityPolicy`, a validated `agent_runtime_authority` configuration section, and service composition that adds this policy without changing Exchange Core.

- [ ] **Step 1: Write failing policy tests for representation, Endpoint ownership, and assigned Handoffs**

```ts
const grant = {
  tenant_id: "tenant-local",
  principal_id: "principal-intake-agent",
  actor_id: "actor-intake-agent",
  endpoint_id: "endpoint-intake-agent",
  subscription_id: "subscription-intake-agent",
};

it("allows only the configured Principal to manage its own Runtime edge", async () => {
  const policy = new AgentRuntimeAuthorityPolicy([grant], handoffs);
  await expect(policy.authorize(request({
    action: "workfabric.endpoint.session.open.v1",
    resource_id: "endpoint-intake-agent",
  }))).resolves.toEqual({ kind: "allow" });
  await expect(policy.authorize(request({
    endpoint_id: "endpoint-other",
    action: "workfabric.endpoint.session.open.v1",
    resource_id: "endpoint-intake-agent",
  }))).resolves.toMatchObject({ kind: "deny" });
});

it("allows Handoff read and accept only when the snapshot targets the Agent", async () => {
  handoffs.put(targetedSnapshot("handoff-targeted", grant));
  handoffs.put(targetedSnapshot("handoff-other", {
    ...grant,
    actor_id: "actor-other",
    endpoint_id: "endpoint-other",
  }));
  await expect(policy.authorize(request({
    action: "workfabric.query.handoff.read.v1",
    resource_id: "handoff-targeted",
  }))).resolves.toEqual({ kind: "allow" });
  await expect(policy.authorize(request({
    action: "workfabric.handoff.accept.v1",
    resource_id: "handoff-other",
  }))).resolves.toMatchObject({ kind: "deny" });
});

it("allows status and Result only for the accepted responsible Actor", async () => {
  handoffs.put(acceptedSnapshot("handoff-accepted", grant));
  await expect(policy.authorize(request({
    action: "workfabric.handoff.report_status.v1",
    resource_id: "handoff-accepted",
  }))).resolves.toEqual({ kind: "allow" });
  await expect(policy.authorize(request({
    action: "workfabric.handoff.return_result.v1",
    resource_id: "handoff-unassigned",
  }))).resolves.toMatchObject({ kind: "deny" });
});
```

Also test exact Subscription ID matching, session heartbeat/close resource
prefixes, tenant mismatch, missing Actor claims, unknown actions, null Handoff
resource, malformed read model, and Handoff Store failure. All fail closed.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
npx vitest run packages/adapter-authority-agent-runtime/test/authority-policy.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the narrow authority policy**

Define:

```ts
export interface AgentRuntimeAuthorityGrant {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly subscription_id: string;
}

export interface AgentRuntimeHandoffAccess {
  getHandoff(
    tenantId: string,
    handoffId: string,
  ): Promise<HandoffReadModel | null>;
}
```

The policy may allow only:

```ts
const SELF_ENDPOINT_ACTIONS = new Set([
  "workfabric.endpoint.session.open.v1",
  "workfabric.endpoint.session.heartbeat.v1",
  "workfabric.endpoint.session.close.v1",
  "workfabric.endpoint.inbox.read.v1",
]);
const SELF_SUBSCRIPTION_ACTIONS = new Set([
  "workfabric.subscription.read.v1",
  "workfabric.subscription.manage.v1",
  "workfabric.subscription.stream.v1",
  "workfabric.subscription.ack.v1",
]);
const TARGETED_HANDOFF_ACTIONS = new Set([
  "workfabric.query.handoff.read.v1",
  "workfabric.handoff.accept.v1",
  "workfabric.handoff.decline.v1",
]);
const RESPONSIBLE_HANDOFF_ACTIONS = new Set([
  "workfabric.query.handoff.read.v1",
  "workfabric.handoff.report_status.v1",
  "workfabric.handoff.return_result.v1",
]);
```

Rules:

- exact trusted claim tuple `(tenant, principal, actor, endpoint)` is required;
- open/inbox resource equals Endpoint ID;
- heartbeat/close resource starts with `${endpoint_id}/` and has one bounded
  non-empty session suffix;
- Subscription resource equals configured Subscription ID;
- target access requires `state.package.target` or committed
  `state.target_binding` to match Actor/Endpoint;
- responsible access requires `state.recipient.actor_id` and
  `state.current_responsible_actor.actor_id` to match the configured Actor;
- `query.handoff.read` is allowed for either a currently targeted or previously
  accepted recipient, including terminal states needed for convergence;
- no partition, operations, admin, offer, resolve-target, verify, close,
  transfer, notification, Connector, or other action is allowed.

Return a generic deny reason and do not reveal whether an inaccessible Handoff
exists.

- [ ] **Step 4: Wire the policy through a configuration section**

Export a `NamedConfigurationSectionValidator` for:

```yaml
agent_runtime_authority:
  grants:
    daily-assistant:
      tenant_id: tenant-local
      principal_id: principal-intake-agent
      actor_id: actor-intake-agent
      endpoint_id: endpoint-intake-agent
      subscription_id: subscription-intake-agent
```

Update `loadNodeConfiguration()` to validate and return this optional section.
In `composeNodeService()`, instantiate:

```ts
const runtimeAuthority = new AgentRuntimeAuthorityPolicy(
  Object.values(agentRuntimeAuthority.grants),
  storage.handoffs,
);
const authority = new CompositeAuthorityPolicy([
  ...(admissionComposition === undefined ? [] : [admissionComposition.authority]),
  runtimeAuthority,
  localAuthority,
]);
```

The adapter belongs to the Trust extension plane. Do not add Runtime-specific
branches to `ExchangeApplication`, route handlers, or Handoff deciders.

- [ ] **Step 5: Run integration checks and commit**

Run:

```bash
npx vitest run packages/adapter-authority-agent-runtime/test packages/service-node/test/agent-runtime-authority.integration.test.ts
npm run typecheck
npm run conformance
git add packages/adapter-authority-agent-runtime packages/service-node
git commit -m "feat(agent): authorize configured runtime participants"
```

Expected: configured self-Endpoint and assigned-Handoff calls pass; an
unassigned Handoff returns the same denial shape as an unknown one.

---

### Task 5: Build Runtime configuration, Role Profile validation, package loading, and acceptance policy

**Files:**
- Create: `packages/agent-runtime-host/package.json`
- Create: `packages/agent-runtime-host/src/errors.ts`
- Create: `packages/agent-runtime-host/src/config.ts`
- Create: `packages/agent-runtime-host/src/configuration-loader.ts`
- Create: `packages/agent-runtime-host/src/handoff-package-loader.ts`
- Create: `packages/agent-runtime-host/src/acceptance-policy.ts`
- Create: `packages/agent-runtime-host/src/workspace-locator.ts`
- Create: `packages/agent-runtime-host/src/protocol-mapping.ts`
- Create: `packages/agent-runtime-host/src/index.ts`
- Modify: `packages/agent-gateway/src/agent-endpoint-session.ts`
- Test: `packages/agent-gateway/test/agent-endpoint-session.test.ts`
- Test: `packages/agent-runtime-host/test/config.test.ts`
- Test: `packages/agent-runtime-host/test/handoff-package-loader.test.ts`
- Test: `packages/agent-runtime-host/test/acceptance-policy.test.ts`
- Test: `packages/agent-runtime-host/test/workspace-locator.test.ts`
- Test: `packages/agent-runtime-host/test/protocol-mapping.test.ts`

**Interfaces:**
- Consumes: Configuration Provider/Secret Resolver, public SDK query types, Agent Gateway snapshots, Runtime SPI, and Driver factories.
- Produces: `loadAgentRuntimeConfiguration()`, `HandoffPackageLoader`, `DeterministicAcceptancePolicy`, and protocol status/result mapping helpers.

- [ ] **Step 1: Write failing configuration and Role tests**

```ts
it("loads a tenant Role Profile and resolves only declared secrets", async () => {
  const loaded = await loadAgentRuntimeConfiguration({
    WORK_FABRIC_AGENT_RUNTIME_CONFIG: fixturePath,
    AGENT_RUNTIME_WORK_FABRIC_TOKEN: "wf-token",
    AGENTLY_MODEL_API_KEY: "model-token",
  });
  expect(loaded.role).toMatchObject({
    role_id: "daily-assistant",
    version: 1,
    capability_ids: [
      "collaboration.request.intake",
      "information.synthesis",
      "collaboration.handoff.draft",
    ],
  });
  expect(loaded.service.work_fabric.access_token).toBe("wf-token");
  expect(loaded.driver.config.provider.api_key).toBe("model-token");
});

it.each([
  ["role contains authority", "role.authority"],
  ["Capability is not supported by Driver", "capabilities"],
  ["Actor type is human", "participant.actor_type"],
  ["literal production secret", "literal_secret_forbidden"],
])("rejects %s", async (_name, expected) => {
  await expect(loadFixture(invalidFixture(_name))).rejects.toThrow(expected);
});
```

Use `ConfigurationService` top-level section validators for `role`,
`participant`, and `capabilities`, and a plugin validator for
`agent-runtime.agently`. Unknown and disabled plugins remain generic config
behavior.

- [ ] **Step 2: Extend the Agent Gateway query surface and test it**

Change:

```ts
readonly queries: Pick<QueryClient, "getHandoff" | "listHandoffEvents">;
```

Add a Gateway boundary test proving the public interface exposes only these
two Handoff query operations and never a persistence adapter.

Run:

```bash
npx vitest run packages/agent-gateway/test
```

Expected before the change: typecheck/test fixture failure for the missing
`listHandoffEvents` method. Expected after the minimal change: PASS.

- [ ] **Step 3: Write and implement strict public Snapshot package loading**

Test:

```ts
it("loads execution input from getHandoff state and uses events only for provenance", async () => {
  const task = await loader.load("handoff-1", "/workspace/t1/h1");
  expect(task.intent).toEqual(snapshot.state.package.intent);
  expect(task.acceptance_criteria).toEqual(
    snapshot.state.package.acceptance_criteria,
  );
  expect(task.stream_version).toBe(snapshot.stream_version);
  expect(client.listHandoffEvents).toHaveBeenCalledWith(
    "handoff-1",
    expect.objectContaining({ fromVersion: 1 }),
  );
});
```

Implement:

```ts
export interface RuntimeHandoffQueries {
  getHandoff(id: string, options?: RequestOptions): Promise<HandoffReadModel>;
  listHandoffEvents(
    id: string,
    options?: HandoffEventQuery,
  ): Promise<readonly ProtocolEvent[]>;
}

export interface LoadedRuntimeHandoff {
  readonly snapshot: HandoffReadModel;
  readonly events: readonly ProtocolEvent[];
  readonly task: RuntimeTaskPackage;
}

export class HandoffPackageLoader {
  constructor(
    private readonly queries: RuntimeHandoffQueries,
    private readonly tenantId: string,
    private readonly role: AgentRoleProfile,
  ) {}

  async load(
    handoffId: string,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<LoadedRuntimeHandoff> {
    // Decode exact state keys, package keys, target, Context reference,
    // AuthorityScope, criteria, lifecycle, timestamps, and Actor refs.
  }
}
```

The decoder must reject:

- tenant, Handoff ID, resource version, or stream version mismatch;
- empty or gapped public event sequence;
- final event sequence different from `snapshot.stream_version`;
- missing Package, malformed target, unsupported lifecycle, expired timestamps;
- Snapshot Package values outside the Runtime SPI bounds.

Read events in pages of `256`, advance `fromVersion` from the last validated
`wfsequence`, and reject streams longer than `4,096` events in the first
version. Never issue an unbounded event query.

Do not attempt to extract the original Package from public event `data`.

Create `workspacePath(root, tenantId, handoffId)` using separate SHA-256
digests of tenant and Handoff identifiers:

```ts
return resolve(
  root,
  createHash("sha256").update(tenantId).digest("hex"),
  createHash("sha256").update(handoffId).digest("hex"),
);
```

Verify the resolved path is a strict descendant of the configured root and
never place raw tenant/Handoff IDs in filesystem names.

- [ ] **Step 4: Implement deterministic policy and protocol mapping**

Define:

```ts
export type AcceptanceDecision =
  | { readonly kind: "accept" }
  | {
      readonly kind: "decline";
      readonly code:
        | "not_targeted"
        | "unsupported_capability"
        | "expired"
        | "terminal"
        | "authority_missing"
        | "already_running";
    }
  | { readonly kind: "ignore"; readonly code: "not_offered" | "own_update" };
```

Policy tests must cover direct Actor target, direct Endpoint target, committed
Capability resolution, unsupported Capability, absent AuthorityScope, expired
acceptance deadline, status/result redelivery, and every terminal lifecycle.

Export protocol mappers:

```ts
export function statusPayload(
  handoffId: string,
  update: RuntimeProgress,
): HandoffStatusPayload;

export function resultPayload(
  handoffId: string,
  result: RuntimeDriverResult,
): HandoffResultPayload;
```

Map progress into valid `status-update` fields and Driver Result into valid
`summary`, `artifacts`, `evidence`, and safe extension keys. Reject empty
summary and forbidden extension names before sending a command.

- [ ] **Step 5: Run Host foundation tests and commit**

Run:

```bash
npx vitest run packages/agent-gateway/test packages/agent-runtime-host/test
npm run typecheck
git add packages/agent-gateway packages/agent-runtime-host
git commit -m "feat(agent): load and evaluate runtime handoffs"
```

---

### Task 6: Implement the durable Runtime Host lifecycle and recovery loop

**Files:**
- Create: `packages/agent-runtime-host/src/idempotency.ts`
- Create: `packages/agent-runtime-host/src/progress-coalescer.ts`
- Create: `packages/agent-runtime-host/src/runtime-host.ts`
- Create: `packages/agent-runtime-host/src/runtime-composition.ts`
- Test: `packages/agent-runtime-host/test/idempotency.test.ts`
- Test: `packages/agent-runtime-host/test/progress-coalescer.test.ts`
- Test: `packages/agent-runtime-host/test/runtime-host.integration.test.ts`
- Test: `packages/agent-runtime-host/test/runtime-recovery.integration.test.ts`

**Interfaces:**
- Consumes: `AgentEndpointSession`, `AgentRuntimeStateStore`, `AgentRuntimeDriver`, `HandoffPackageLoader`, deterministic policy, and SDK Handoff commands.
- Produces: `AgentRuntimeHost.start()`, `AgentRuntimeHost.close()`, bounded execution concurrency, recovery, cancellation, status, and Result convergence.

The Host receives this normalized, provider-neutral composition value:

```ts
export interface AgentRuntimeHostConfig {
  readonly runtime_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly max_active_runs: number;
  readonly queue_capacity: number;
  readonly run_lease_seconds: number;
  readonly progress_interval_ms: number;
  readonly workspace_root: string;
}
```

The runnable composition obtains `workspace_root` from the selected Driver
plugin configuration, resolves it to an absolute path, and passes it to the
Host. The Host does not know that the selected Driver is Agently.

- [ ] **Step 1: Write failing persist-before-Ack and logical-run idempotency tests**

```ts
it("persists Delivery before acknowledging and accepts before execution", async () => {
  const order: string[] = [];
  state.recordDelivery = async (input) => {
    order.push("persist");
    return { created: true, record: input };
  };
  incoming.acknowledgeSignal = async () => {
    order.push("ack");
    return ackResult;
  };
  handoffs.accept = async () => {
    order.push("accept");
    return acceptedOperation(3);
  };
  driver.execute = async () => {
    order.push("execute");
    return result();
  };
  await host.handle(incoming);
  expect(order.slice(0, 4)).toEqual(["persist", "ack", "accept", "execute"]);
});

it("does not execute a duplicate Delivery or its own status/result signals", async () => {
  await host.handle(incomingOffer);
  await host.handle(incomingOffer);
  await host.handle(incomingStatus);
  await host.handle(incomingResult);
  expect(driver.execute).toHaveBeenCalledTimes(1);
  expect(incomingStatus.acknowledgeSignal).toHaveBeenCalledWith("acknowledged");
});
```

Add cases for decline, Ack retry, queue full, accept conflict convergence,
stale expected version, cancellation, model failure, invalid result, and
Host shutdown.

- [ ] **Step 2: Implement stable idempotency and progress coalescing**

Idempotency keys are deterministic and contain no sensitive data:

```ts
export function runtimeCommandKey(
  runtimeId: string,
  handoffId: string,
  command: "accept" | "decline" | "status" | "result",
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runtimeId, handoffId, command, sequence]))
    .digest("hex");
  return `agent-runtime:${command}:${digest}`;
}
```

`ProgressCoalescer` must:

- accept strictly increasing Driver sequence values;
- retain the most recent update;
- emit at most once per configured interval;
- always flush a final pending update before terminal Result/failure;
- cap message length and never log raw content.

- [ ] **Step 3: Implement one incoming-Delivery lifecycle**

`AgentRuntimeHost.handle()` must perform:

```ts
await state.recordDelivery(receipt);
await incoming.acknowledgeSignal("acknowledged");

const { run } = await state.createRunIfAbsent(tenantId, handoffId, now());
const decision = policy.decide(incoming.handoff, run, now());
if (decision.kind === "ignore") return;
if (decision.kind === "decline") {
  await this.issueDecline(handoffId, incoming.handoff, signal);
  return;
}

const claim = await state.claimRun({
  tenant_id: tenantId,
  handoff_id: handoffId,
  owner: this.runtimeId,
  now: now(),
  lease_seconds: this.config.run_lease_seconds,
  allowed_states: ["received", "accepted", "running", "result_ready"],
});
if (claim === null) return;
const taskWorkspace = workspacePath(
  this.config.workspace_root,
  tenantId,
  handoffId,
);
const loaded = await packageLoader.load(handoffId, taskWorkspace, signal);
const transition = async (
  expected_state: RuntimeRunState,
  next_state: RuntimeRunState,
  extra: Pick<RuntimeRunRecord, "result" | "result_digest"> = {
    result: null,
    result_digest: null,
  },
) => {
  const changed = await state.transitionRun({
    tenant_id: tenantId,
    handoff_id: handoffId,
    owner: this.runtimeId,
    fencing_token: claim.fencing_token,
    expected_state,
    next_state,
    now: now(),
    ...(extra.result === null ? {} : { result: extra.result }),
    ...(extra.result_digest === null
      ? {}
      : { result_digest: extra.result_digest }),
  });
  if (!changed) throw new RuntimeHostError("run_fenced", handoffId);
};
const coalescer = new ProgressCoalescer(
  this.config.progress_interval_ms,
  async (update) => {
    await this.issueStatus(handoffId, update, signal);
    const saved = await state.checkpointProgress({
      tenant_id: tenantId,
      handoff_id: handoffId,
      owner: this.runtimeId,
      fencing_token: claim.fencing_token,
      sequence: update.sequence,
      now: now(),
    });
    if (!saved) throw new RuntimeHostError("run_fenced", handoffId);
  },
);
const progress = (update: RuntimeProgress) => coalescer.push({
  ...update,
  sequence: update.sequence + 1,
});
const flushProgress = () => coalescer.flush();
await this.issueAccept(handoffId, loaded.snapshot, signal);
await transition("received", "accepted");
await this.issueStatus(handoffId, {
  sequence: 1,
  progress: 0,
  message: "Agent Runtime started",
  observed_at: now(),
}, signal);
const initialCheckpoint = await state.checkpointProgress({
  tenant_id: tenantId,
  handoff_id: handoffId,
  owner: this.runtimeId,
  fencing_token: claim.fencing_token,
  sequence: 1,
  now: now(),
});
if (!initialCheckpoint) throw new RuntimeHostError("run_fenced", handoffId);
await transition("accepted", "running");
const result = await driver.execute(loaded.task, progress, signal);
await flushProgress();
await transition("running", "result_ready", {
  result,
  result_digest: digest(result),
});
await this.issueResult(handoffId, result, signal);
await transition("result_ready", "succeeded");
```

Define the private command helpers with these exact signatures:

```ts
private issueDecline(
  handoffId: string,
  snapshot: HandoffReadModel,
  signal: AbortSignal,
): Promise<void>;
private issueAccept(
  handoffId: string,
  snapshot: HandoffReadModel,
  signal: AbortSignal,
): Promise<void>;
private issueStatus(
  handoffId: string,
  progress: RuntimeProgress,
  signal: AbortSignal,
): Promise<void>;
private issueResult(
  handoffId: string,
  result: RuntimeDriverResult,
  signal: AbortSignal,
): Promise<void>;
```

Every Work Fabric command:

- re-reads the current Handoff before choosing expected version;
- records its stable idempotency key and accepted resource version;
- treats an idempotent replay as success;
- handles conflict by re-reading and accepting only the equivalent already
  committed state;
- never retries a semantically different command under the same key.

On failure, flush safe progress, report `failed` when still responsible, and
transition the Runtime run to `failed` with a bounded machine code.

- [ ] **Step 4: Implement start, recovery, terminal cancellation, and close**

`start()`:

- starts the Agent Gateway session;
- recovers a bounded page of expired/unowned non-terminal runs;
- consumes `session.incoming()` with a bounded semaphore;
- never exceeds `max_active_runs` or `queue_capacity`.

Recovery:

- re-read each Handoff;
- if offered and no Accept command exists, resume at policy/Accept;
- if accepted and local state is `accepted` or `running`, reacquire the same
  logical run and create a new bounded process attempt only when no validated
  result was durably captured;
- if local state is `result_ready`, reuse the persisted validated result and
  submit it with the same idempotency key without calling the model again;
- if Work Fabric already contains Result/terminal state, mark local state
  converged without executing;
- reacquire a monotonic Runtime lease before every resume.

When a Delivery shows cancelled, expired, declined, result-returned, verified,
closed, transferred, or target-unavailable state, abort the active execution
for that Handoff and Ack the signal.

`close()` stops intake, aborts active executions, waits only the configured
grace period, closes the Gateway session, then closes the State Provider.

- [ ] **Step 5: Run integration and recovery tests, then commit**

Run:

```bash
npx vitest run packages/agent-runtime-host/test
npm run typecheck
git add packages/agent-runtime-host
git commit -m "feat(agent): orchestrate durable external runs"
```

Expected: restart tests at Delivery/Ack, Ack/Accept, Accept/execute,
result-ready/Result, and Result/local-terminal boundaries all converge to one
logical run and one Work Fabric Result. An ambiguous process failure before a
validated result is durably captured may create a new model attempt; the first
version has no mutating tools, so that retry cannot duplicate an external
business side effect.

---

### Task 7: Implement the bounded Agently child-process Driver

**Files:**
- Create: `packages/adapter-agent-runtime-agently/package.json`
- Create: `packages/adapter-agent-runtime-agently/src/config.ts`
- Create: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Create: `packages/adapter-agent-runtime-agently/src/ndjson-reader.ts`
- Create: `packages/adapter-agent-runtime-agently/src/agently-process-driver.ts`
- Create: `packages/adapter-agent-runtime-agently/src/index.ts`
- Test: `packages/adapter-agent-runtime-agently/test/config.test.ts`
- Test: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`
- Test: `packages/adapter-agent-runtime-agently/test/process-driver.test.ts`
- Test fixture: `packages/adapter-agent-runtime-agently/test/fixtures/fake-worker.mjs`

**Interfaces:**
- Consumes: `AgentRuntimeDriverFactory`, `RuntimeTaskPackage`, and resolved Agently plugin config.
- Produces: `AgentlyRuntimeDriverFactory`, one-process-per-run execution, strict versioned stdin/NDJSON protocol, timeout, cancellation, and bounded stderr diagnostics.

- [ ] **Step 1: Write failing protocol and process-boundary tests**

```ts
it("accepts ordered progress followed by exactly one completed record", async () => {
  const progress: RuntimeProgress[] = [];
  const result = await driver.execute(task, async (item) => {
    progress.push(item);
  }, new AbortController().signal);
  expect(progress.map((item) => item.sequence)).toEqual([1, 2]);
  expect(result.summary[0]).toMatchObject({ kind: "text" });
});

it.each([
  "malformed-json",
  "wrong-protocol",
  "duplicate-terminal",
  "progress-after-terminal",
  "non-monotonic-sequence",
  "oversized-line",
  "too-many-events",
  "deep-json",
  "silent-timeout",
  "non-zero-exit",
])("fails closed for %s", async (scenario) => {
  await expect(runFixture(scenario)).rejects.toMatchObject({
    code: expect.stringMatching(/^agently_worker_/),
  });
});

it("passes only an allowlisted child environment", async () => {
  const result = await runFixture("print-env-keys");
  expect(result.extensions["workfabric.dev/child_env_keys"]).toEqual([
    "AGENTLY_MODEL_API_KEY",
    "LANG",
    "PATH",
    "PYTHONIOENCODING",
  ]);
});
```

Also assert AbortSignal sends graceful termination and then forced termination
after `cancellation_grace_seconds`.

- [ ] **Step 2: Define and validate the exact wire protocol**

One bounded JSON request is written to stdin:

```ts
export interface AgentlyWorkerRequestV1 {
  readonly protocol: "workfabric.agent-runtime/1";
  readonly command_id: string;
  readonly task: RuntimeTaskPackage;
  readonly provider: {
    readonly type: "OpenAICompatible";
    readonly base_url: string;
    readonly model: string;
  };
}
```

Stdout accepts only NDJSON records:

```ts
export type AgentlyWorkerRecordV1 =
  | {
      readonly protocol: "workfabric.agent-runtime/1";
      readonly type: "progress";
      readonly command_id: string;
      readonly sequence: number;
      readonly progress: number | null;
      readonly message: string;
      readonly observed_at: string;
    }
  | {
      readonly protocol: "workfabric.agent-runtime/1";
      readonly type: "completed";
      readonly command_id: string;
      readonly result: RuntimeDriverResult;
    }
  | {
      readonly protocol: "workfabric.agent-runtime/1";
      readonly type: "failed";
      readonly command_id: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };
```

Set explicit defaults and maxima:

- stdin task: `1 MiB`;
- one stdout line: `256 KiB`;
- stdout records: `1,024`;
- JSON depth: `32`;
- stderr capture: `64 KiB`;
- execution timeout: configured, maximum `86,400` seconds;
- cancellation grace: configured, maximum `60` seconds.

- [ ] **Step 3: Implement strict Agently plugin configuration**

Validate:

```ts
export interface AgentlyRuntimeDriverConfig {
  readonly python: {
    readonly executable: string;
    readonly module: string;
  };
  readonly workspace_root: string;
  readonly execution_timeout_seconds: number;
  readonly cancellation_grace_seconds: number;
  readonly provider: {
    readonly type: "OpenAICompatible";
    readonly base_url: string;
    readonly model: string;
    readonly api_key: string;
  };
}
```

Require an absolute or config-file-relative Python executable resolved at
startup, module name `work_fabric_agently_runtime`, an explicit Workspace
root, HTTPS model base URL except in `development_mode`, bounded model name,
and non-empty resolved API key. Export `agentlySecretPaths()` returning only
the plugin API-key path.

- [ ] **Step 4: Implement spawn, validation, timeout, and cancellation**

Launch without a shell:

```ts
const child = spawn(config.python.executable, [
  "-m",
  config.python.module,
], {
  cwd: workspaceParent,
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    AGENTLY_MODEL_API_KEY: config.provider.api_key,
  },
});
```

Write exactly one request plus newline, then close stdin. Parse stdout
incrementally without buffering the entire stream. Treat stderr only as a
redacted bounded diagnostic; never parse protocol from it.

On timeout or abort:

1. stop accepting new protocol records;
2. send `SIGTERM`;
3. wait the configured grace interval;
4. send `SIGKILL` if still alive;
5. reject with a bounded machine code.

- [ ] **Step 5: Run adapter tests and commit**

Run:

```bash
npx vitest run packages/adapter-agent-runtime-agently/test
npm run typecheck
git add packages/adapter-agent-runtime-agently
git commit -m "feat(agent): add bounded Agently process driver"
```

---

### Task 8: Build the independent Agently Python Worker

**Files:**
- Create: `runtimes/agently-worker/pyproject.toml`
- Create: `runtimes/agently-worker/uv.lock`
- Create: `runtimes/agently-worker/src/work_fabric_agently_runtime/__init__.py`
- Create: `runtimes/agently-worker/src/work_fabric_agently_runtime/__main__.py`
- Create: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Create: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Create: `runtimes/agently-worker/src/work_fabric_agently_runtime/runner.py`
- Test: `runtimes/agently-worker/tests/test_protocol.py`
- Test: `runtimes/agently-worker/tests/test_assistant.py`
- Test: `runtimes/agently-worker/tests/test_main.py`

**Interfaces:**
- Consumes: one `AgentlyWorkerRequestV1` on stdin and `AGENTLY_MODEL_API_KEY` in the allowlisted process environment.
- Produces: bounded progress plus exactly one completed/failed NDJSON record on stdout; all diagnostics go to stderr.

- [ ] **Step 1: Create the locked Python project and failing protocol tests**

Use:

```toml
[project]
name = "work-fabric-agently-runtime"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
  "agently==4.1.4.1",
]

[dependency-groups]
dev = [
  "pytest==9.1.1",
  "pytest-asyncio==1.4.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

Run:

```bash
cd runtimes/agently-worker
uv lock
uv run pytest
```

Initial tests:

```py
def test_rejects_secret_inside_task_json():
    value = valid_request()
    value["task"]["api_key"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown"):
        parse_request(value)

def test_completed_record_requires_non_empty_summary():
    with pytest.raises(ProtocolError, match="summary"):
        completed_record("command-1", {
            "summary": [],
            "artifacts": [],
            "evidence": [],
            "extensions": {},
        })
```

Expected before implementation: FAIL because the package is missing.

- [ ] **Step 2: Implement strict Python request and record models**

Use frozen `dataclass` values and manual exact-key validation; do not add a
second permissive schema system.

```py
@dataclass(frozen=True)
class WorkerRequest:
    protocol: Literal["workfabric.agent-runtime/1"]
    command_id: str
    task: Mapping[str, JsonValue]
    provider_type: Literal["OpenAICompatible"]
    provider_base_url: str
    provider_model: str

@dataclass(frozen=True)
class WorkerRecord:
    protocol: Literal["workfabric.agent-runtime/1"]
    type: Literal["progress", "completed", "failed"]
    command_id: str
    payload: Mapping[str, JsonValue]
```

Apply the same byte, string, array, and depth bounds as the Node Driver.
`write_record()` uses one compact UTF-8 JSON object followed by one newline
and immediately flushes stdout.

- [ ] **Step 3: Write the Daily Assistant request with a fake Agent**

Use a small `AgentPort` Protocol in tests. Verify exact calls:

```py
class FakeAgent:
    def use_workspace(self, path: str):
        self.workspace = path
        return self

    def role(self, value: str, *, always: bool):
        self.role_value = value
        assert always is True
        return self

    def input(self, value: object):
        self.input_value = value
        return self

    def output(self, schema: object, *, format: str):
        self.schema = schema
        assert format == "json"
        return self

    async def async_start(self):
        return {
            "request_summary": "整理后的请求",
            "response": "已收到并完成整理",
            "missing_information": [],
            "handoff_draft_required": True,
            "handoff_draft_reason": "需要需求分析角色继续处理",
            "handoff_draft_capability": "requirements.analysis",
            "handoff_draft_intent": "梳理并确认需求",
            "handoff_draft_acceptance_criteria": ["范围得到确认"],
        }
```

The Worker output schema is exactly:

```py
ASSISTANT_OUTPUT_SCHEMA = {
    "request_summary": (str, "结构化请求摘要", "not_null"),
    "response": (str, "面向协作者的答复", "not_null"),
    "missing_information": [(str, "仍需补充的信息")],
    "handoff_draft_required": (bool, "是否建议下游交接", True),
    "handoff_draft_reason": (str, "建议或不建议交接的原因", True),
    "handoff_draft_capability": (str, "建议的能力 ID；无则为空字符串", True),
    "handoff_draft_intent": (str, "建议交接意图；无则为空字符串", True),
    "handoff_draft_acceptance_criteria": [(str, "建议验收条件")],
}
```

Validate that when `handoff_draft_required` is true, capability matches the
WFPP Capability-ID pattern and intent/criteria are non-empty. This produces a
draft only; it never calls Work Fabric.

- [ ] **Step 4: Implement the real async Agently execution**

Create one Agent per process:

```py
from agently import Agently

async def execute(request: WorkerRequest) -> Mapping[str, JsonValue]:
    api_key = required_environment("AGENTLY_MODEL_API_KEY")
    Agently.set_settings("OpenAICompatible", {
        "base_url": request.provider_base_url,
        "api_key": api_key,
        "model": request.provider_model,
        "request_retry": {"max_attempts": 2},
        "request_options": {"timeout": 120},
    })
    agent = (
        Agently.create_agent(
            f"{request.task['role']['role_id']}-{request.command_id}"
        )
        .use_workspace(request.task["workspace_path"])
        .role(role_prompt(request.task["role"]), always=True)
    )
    return await (
        agent
        .input(task_prompt_input(request.task))
        .output(ASSISTANT_OUTPUT_SCHEMA, format="json")
        .async_start()
    )
```

Do not call `use_actions`, `enable_shell`, `enable_python`,
`enable_workspace_file_actions`, MCP, browser, or TriggerFlow.

`runner.py` emits progress at start and after validated model output, then maps
the structured output to:

```py
{
    "summary": [{
        "kind": "text",
        "media_type": "text/plain",
        "text": output["response"],
    }],
    "artifacts": [],
    "evidence": [],
    "extensions": {
        "workfabric.agent/assistant_output": output,
    },
}
```

Catch known validation/model errors, emit one safe `failed` record, and place
redacted diagnostics on stderr. Never include the API key, raw prompt, or
unbounded model response.

- [ ] **Step 5: Run Python tests and commit**

Run:

```bash
cd runtimes/agently-worker
uv run pytest -q
cd ../..
git add runtimes/agently-worker
git commit -m "feat(agent): execute daily assistant with Agently"
```

Expected: protocol, fake-Agent, Workspace binding, stdout/stderr separation,
invalid-output, and cancellation-by-process tests PASS without a model API
call.

---

### Task 9: Compose a runnable Daily Assistant Runtime and local configuration

**Files:**
- Create: `examples/agently-agent-runtime/package.json`
- Create: `examples/agently-agent-runtime/src/capabilities.ts`
- Create: `examples/agently-agent-runtime/src/subscription.ts`
- Create: `examples/agently-agent-runtime/src/main.ts`
- Create: `examples/agently-agent-runtime/src/provision.ts`
- Create: `examples/config/agent-runtime-agently.yaml`
- Modify: `examples/config/service-feishu-long-connection.yaml`
- Modify: `package.json`
- Test: `examples/agently-agent-runtime/test/composition.test.ts`
- Test: `packages/service-node/test/global-configuration.test.ts`

**Interfaces:**
- Consumes: separate Runtime YAML, Environment Secret Resolver, Work Fabric SDK/Gateway, SQLite Runtime State, Agently Driver, and Host.
- Produces: `npm run agent-runtime:start`, `npm run agent-runtime:provision`, and a local Feishu-to-Daily-Assistant deployment profile.

- [ ] **Step 1: Write failing composition tests**

```ts
it("builds a Daily Assistant Runtime without importing service-node", async () => {
  const composition = await composeAgentRuntime(validLoadedConfig, {
    fetch: fakeFetch,
    driver: fakeDriver,
    state: new MemoryAgentRuntimeStateStore(),
  });
  expect(composition.role.role_id).toBe("daily-assistant");
  expect(composition.gatewayConfig.open_session.capabilities.map(
    (item) => item.capability_id,
  )).toEqual([
    "collaboration.request.intake",
    "information.synthesis",
    "collaboration.handoff.draft",
  ]);
});

it("does not expose a Work Fabric database setting to the Runtime", async () => {
  const loaded = await loadConfig(validFixture());
  expect(loaded.service.work_fabric).not.toHaveProperty("database");
  expect(loaded.service.state.location).toBe(
    "./var/daily-assistant-runtime.db",
  );
});
```

Add a boundary assertion that no source under `packages/service-node`,
`packages/exchange-core`, or `packages/agent-gateway` imports
`adapter-agent-runtime-agently` or `agently`.

- [ ] **Step 2: Add the separate Runtime YAML**

```yaml
api_version: workfabric.config/v1

service:
  runtime_id: daily-assistant-local
  development_mode: true
  work_fabric:
    base_url: http://127.0.0.1:8787
    tenant_id: tenant-local
    exchange_id: exchange-local
    actor_id: actor-intake-agent
    endpoint_id: endpoint-intake-agent
    subscription_id: subscription-intake-agent
    access_token: ${INTAKE_AGENT_ACCESS_TOKEN}
  acceptance:
    mode: accept_all_targeted
    require_explicit_target: true
    reject_expired_handoffs: true
    require_authority_scope: true
    allowed_capability_ids:
      - collaboration.request.intake
      - information.synthesis
      - collaboration.handoff.draft
  concurrency:
    max_active_runs: 2
    queue_capacity: 32
  state:
    provider: sqlite
    location: ./var/daily-assistant-runtime.db
    busy_timeout_ms: 5000

role:
  role_id: daily-assistant
  version: 1
  display_name: 日常助理 Agent
  description: 团队共享的协作入口与日常事务助理

participant:
  actor_id: actor-intake-agent
  actor_type: agent
  endpoint_id: endpoint-intake-agent

capabilities:
  - capability_id: collaboration.request.intake
    version: 1.0.0
    name: Collaboration request intake
    description: Normalize an explicitly assigned collaboration request
    input_media_types: [text/plain, text/markdown, application/json]
    output_media_types: [application/json]
    input_schema_refs: []
    output_schema_refs: []
    interaction_modes: [asynchronous, status_updates]
    constraints: {}
    extensions: {}
  - capability_id: information.synthesis
    version: 1.0.0
    name: Information synthesis
    description: Synthesize content actually supplied and authorized in one Handoff
    input_media_types: [text/plain, text/markdown, application/json]
    output_media_types: [application/json]
    input_schema_refs: []
    output_schema_refs: []
    interaction_modes: [asynchronous, status_updates]
    constraints: {}
    extensions: {}
  - capability_id: collaboration.handoff.draft
    version: 1.0.0
    name: Handoff draft
    description: Return a downstream Handoff proposal without dispatching it
    input_media_types: [text/plain, text/markdown, application/json]
    output_media_types: [application/json]
    input_schema_refs: []
    output_schema_refs: []
    interaction_modes: [asynchronous, status_updates]
    constraints: {}
    extensions: {}

plugins:
  instances:
    agently-primary:
      type: agent-runtime.agently
      enabled: true
      config:
        python:
          executable: ./runtimes/agently-worker/.venv/bin/python
          module: work_fabric_agently_runtime
        workspace_root: ./var/agently-workspaces
        execution_timeout_seconds: 900
        cancellation_grace_seconds: 10
        provider:
          type: OpenAICompatible
          base_url: https://provider.example/v1
          model: configured-model
          api_key: ${AGENTLY_MODEL_API_KEY}
```

Model base URL and model name are ordinary deployment configuration values.
Only the API key and Work Fabric bearer token use the Secret Resolver. A
deployment chooses its provider by changing or supplying another
Configuration Provider document, not by treating non-secret values as
credentials.

- [ ] **Step 3: Compose the executable Host**

`main.ts` performs only composition:

```ts
const loaded = await loadAgentRuntimeConfiguration(process.env);
const client = new WorkFabricClient({
  baseUrl: loaded.service.work_fabric.base_url,
  tenantId: loaded.service.work_fabric.tenant_id,
  exchangeId: loaded.service.work_fabric.exchange_id,
  representation: {
    actorId: loaded.participant.actor_id,
    endpointId: loaded.participant.endpoint_id,
  },
  authentication: new BearerTokenProvider(
    loaded.service.work_fabric.access_token,
  ),
});
const state = createRuntimeStateStore(loaded.service.state);
const driver = await loaded.driver.factory.create(loaded.driver.config);
const host = composeAgentRuntimeHost({ loaded, client, state, driver });
await host.start();
```

Register SIGINT/SIGTERM once and call the idempotent `host.close()`. Print only
one readiness line containing Runtime ID, role ID, Actor, and Endpoint; never
print tokens, model URL query parameters, Context, or prompt data.

- [ ] **Step 4: Add explicit Endpoint provisioning and service authority config**

`provision.ts` uses a separate admin Principal and `EndpointClient.provision`
to create the version-1 native Agent Endpoint with the three allowed
Capability IDs. It reads `WORK_FABRIC_ADMIN_TOKEN` and never lets the Runtime
token call the admin route.

Extend `service-feishu-long-connection.yaml` with:

- an admin identity and exact
  `workfabric.endpoint.provision.v1` rule for `endpoint-intake-agent`;
- the existing Runtime identity for `principal-intake-agent`;
- the `agent_runtime_authority.grants.daily-assistant` section from Task 4;
- Feishu `intake_target` kept as
  `actor-intake-agent`/`endpoint-intake-agent`.

Do not grant the Runtime admin, offer, target-resolution, verification,
Connector, or Operations permissions.

Add scripts:

```json
{
  "agent-runtime:provision": "tsx examples/agently-agent-runtime/src/provision.ts",
  "agent-runtime:start": "tsx examples/agently-agent-runtime/src/main.ts",
  "agent-runtime:test-python": "uv run --project runtimes/agently-worker pytest -q"
}
```

- [ ] **Step 5: Run config/composition tests and commit**

Run:

```bash
npx vitest run examples/agently-agent-runtime/test packages/service-node/test/global-configuration.test.ts
npm run typecheck
git add examples/agently-agent-runtime examples/config package.json
git commit -m "feat(agent): compose team daily assistant runtime"
```

---

### Task 10: Complete deterministic end-to-end verification and operator documentation

**Files:**
- Create: `packages/agent-runtime-host/test/agently-daily-assistant.e2e.test.ts`
- Create: `packages/agent-runtime-host/test/fake-openai-compatible-server.ts`
- Modify: `packages/service-node/test/feishu-long-connection.e2e.test.ts`
- Create: `docs/guides/agently-agent-runtime.md`
- Modify: `docs/endpoint-agent-boundary.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: all previous tasks, a local fake OpenAI-compatible HTTP server, Work Fabric SQLite, public HTTP/SSE, and the real Agently worker process.
- Produces: deterministic E2E evidence, an opt-in real-model smoke path, and complete local operator instructions.

- [ ] **Step 1: Write the failing full-loop E2E test**

The test must:

```ts
it("completes and recovers the Daily Assistant Handoff through real boundaries", async () => {
  const model = await startFakeOpenAiCompatibleServer({
    structuredOutput: {
      request_summary: "创建一个新需求",
      response: "需求已整理，建议交给需求分析角色确认",
      missing_information: ["期望上线日期"],
      handoff_draft_required: true,
      handoff_draft_reason: "需要专业需求分析",
      handoff_draft_capability: "requirements.analysis",
      handoff_draft_intent: "梳理需求范围并确认验收标准",
      handoff_draft_acceptance_criteria: ["范围得到业务方确认"],
    },
  });
  const service = await startSqliteWorkFabric();
  await provisionDailyAssistant(service.origin);
  const runtime = await startRealAgentlyRuntime({
    baseUrl: service.origin,
    modelBaseUrl: model.baseUrl,
  });

  const offered = await human.handoffs.offer(dailyAssistantOffer(), {
    idempotencyKey: "daily-assistant-e2e-offer-1",
  });
  await expectEventually(async () => {
    const handoff = await human.queries.getHandoff(resourceId(offered));
    expect(handoff.state.lifecycle_state).toBe("result_returned");
    expect(handoff.state.result.extensions[
      "workfabric.agent/assistant_output"
    ]).toMatchObject({ handoff_draft_required: true });
  });

  await runtime.close();
  const restarted = await startRealAgentlyRuntime({
    baseUrl: service.origin,
    modelBaseUrl: model.baseUrl,
  });
  expect(model.requestCountFor(resourceId(offered))).toBe(1);
  await offerAndAwaitSecondHandoff(human);
  await restarted.close();
});
```

The fake HTTP server must implement only the OpenAI-compatible Chat
Completions response needed by Agently and bind to `127.0.0.1` on an ephemeral
port. It records bounded request metadata but not raw authorization values.

- [ ] **Step 2: Verify Feishu ingress targets the same Agent identity**

Extend the existing long-connection E2E fixture so a simulated Feishu mention:

1. passes Admission;
2. creates a Handoff targeted to
   `actor-intake-agent`/`endpoint-intake-agent`;
3. reaches a real Agent Gateway Delivery;
4. is acknowledged and accepted by the Runtime Host;
5. returns a Result rendered by the configured Feishu outbound path.

Use the deterministic fake OpenAI-compatible server. Do not call the real
Feishu or model network in automated tests.

- [ ] **Step 3: Add failure, security, and restart acceptance cases**

Add E2E cases proving:

- no Authority grant means no model request;
- a Handoff targeted to another Actor is not readable or executable;
- malformed model output becomes `failed`, never Result;
- process timeout becomes `failed` and kills the Worker;
- cancelled Handoff aborts the active process;
- duplicate Delivery and restart after durable validated result capture do not
  create a second model request;
- Workspace paths differ across tenant/Handoff;
- task JSON, SQLite rows, logs, status, and Result contain neither model API
  key nor Work Fabric bearer token;
- the Handoff draft remains Result data and no child Handoff is created.

- [ ] **Step 4: Write the operator guide and boundary updates**

`docs/guides/agently-agent-runtime.md` must include:

- architecture and why Work Fabric Core is unchanged;
- Principal/Actor/Endpoint/Role/Capability/Authority distinctions;
- local static bearer tokens are development-only;
- `uv sync --project runtimes/agently-worker`;
- `.env` variable names without values;
- service YAML and Runtime YAML separation;
- Endpoint provisioning;
- service, Runtime, Console, and Feishu startup order;
- Console locations for Endpoint, Delivery, Handoff, status, and Result;
- how to send a Feishu `@bot` request;
- expected Ack/Accept/Status/Result observations;
- fake-model test and opt-in real-model smoke commands;
- timeout, authority denial, Endpoint fencing, Workspace, and SQLite
  troubleshooting;
- future Memory Provider is not implemented and must remain separate from
  Runtime State.

Update architecture docs only to list the external Runtime Host and Role
Profile extension point. Do not redraw Work Fabric as an execution engine.

Also state that any previously exposed Feishu App Secret or model key must be
rotated before use.

- [ ] **Step 5: Run the complete release gate and commit**

Add:

```json
{
  "verify:agent-runtime": "npm run typecheck && vitest run packages/agent-runtime-spi/test packages/adapter-agent-runtime-memory/test packages/adapter-agent-runtime-sqlite/test packages/adapter-authority-agent-runtime/test packages/agent-runtime-host/test packages/adapter-agent-runtime-agently/test examples/agently-agent-runtime/test && uv run --project runtimes/agently-worker pytest -q && npm run conformance"
}
```

Run:

```bash
npm run verify:agent-runtime
npm run verify
git diff --check
git status --short
```

Expected:

- TypeScript and Python unit/integration/E2E tests PASS;
- protocol conformance is unchanged;
- full existing project verification PASS;
- no unexpected generated files, credentials, Work Fabric database, Runtime
  database, Workspace, `.venv`, or Python cache is staged.

Commit:

```bash
git add packages/agent-runtime-host/test packages/service-node/test/feishu-long-connection.e2e.test.ts docs README.md package.json
git commit -m "test(agent): verify daily assistant end to end"
```

## Optional real-model smoke test

After the deterministic release gate passes, a human may copy the Runtime YAML
outside source control, set `provider.base_url` and `provider.model` to the
chosen non-secret deployment values, and explicitly provide:

```bash
export AGENTLY_MODEL_API_KEY=rotated-secret
```

Run one non-destructive `information.synthesis` Handoff. Confirm that it
produces status and Result, then remove the test credentials. The smoke test
must not be required by CI and must not enable Actions or external mutations.
