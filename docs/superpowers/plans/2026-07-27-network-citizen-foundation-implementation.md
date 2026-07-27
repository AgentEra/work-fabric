# Network Citizen Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a technology-neutral, dynamically registered Network Citizen catalog with leased sessions, progressive disclosure, HTTP/TypeScript SDK access, and reusable TypeScript runtime foundations.

**Architecture:** New wire-neutral types and ports live in `network-citizen-spi`; a directory service validates provisioning, session fencing, declaration replacement and disclosure; memory and SQLite adapters own persistence. HTTP and SDK packages expose the same contract, while `network-citizen-runtime` provides optional leased runtimes and factory composition without introducing vendor dependencies into Core.

**Tech Stack:** Node.js `>=22.20.0`, TypeScript `7.0.2`, Vitest `4.1.10`, AJV `8.20.0`, Fastify `5.10.0`, built-in `node:sqlite`, existing Work Fabric authentication/Authority/configuration infrastructure.

## Global Constraints

- Work Fabric Core handles connection, discovery, Authority, Handoff, responsibility, state, events, Result and audit; it does not execute Agent reasoning or vendor operations.
- Actor type and Citizen kind remain orthogonal.
- One Citizen registration has exactly one kind.
- Configuration provisions trust and safety ceilings; session declarations are runtime truth.
- Declaring a capability never grants invocation Authority.
- Dynamic updates use registration revision, session fencing and declaration CAS.
- Full contracts are independently authorized from list, citizen detail and declaration summaries.
- Wire protocols are the base contract; TypeScript abstract classes are optional conveniences.
- Core packages may not import YAML, SQLite, HTTP, Feishu, Agently or MCP.
- Existing Endpoint APIs and projections remain compatible.
- Secrets, private URLs and executable paths are invalid descriptor/declaration content.
- Every production mutation follows RED, GREEN, focused regression, then commit.

## File and package map

| Unit | Responsibility |
|---|---|
| `packages/network-citizen-spi` | Citizen kinds, descriptors, declarations, provisioning/session/store ports, validation and factory interfaces |
| `packages/network-citizen-directory` | Provisioning, leased sessions, declaration CAS, availability projection and progressive disclosure |
| `packages/adapter-network-citizen-memory` | Deterministic in-memory catalog store for tests and local demos |
| `packages/adapter-network-citizen-sqlite` | Durable local catalog store and forward-only migration |
| `protocol/schemas/v1/citizen` | Language-neutral registration, session, declaration and disclosure JSON Schemas |
| `packages/transport-http` | Authorized Citizen administration, session and discovery routes |
| `packages/sdk-typescript` | Strict Citizen API decoder/client |
| `packages/network-citizen-runtime` | Optional leased runtime, heartbeat/declaration lifecycle and factory registry |
| `packages/service-node` | Composition only: storage selection, directory wiring and HTTP dependency injection |

---

### Task 1: Commit the verified legacy Handoff snapshot compatibility fix

**Files:**
- Modify: `packages/agent-runtime-host/src/handoff-package-loader.ts`
- Test: `packages/agent-runtime-host/test/handoff-package-loader.test.ts`

**Interfaces:**
- Consumes: legacy Handoff snapshots that predate `active_claim` and `claim_fencing_token`.
- Produces: `HandoffPackageLoader.load()` returning canonical snapshot defaults `active_claim: null` and `claim_fencing_token: 0`.

- [ ] **Step 1: Re-run the focused compatibility test**

Run:

```bash
npx vitest run packages/agent-runtime-host/test/handoff-package-loader.test.ts
```

Expected: all tests pass, including the legacy-snapshot case.

- [ ] **Step 2: Run the Agent Runtime regression set**

Run:

```bash
npm run typecheck
npx vitest run packages/agent-runtime-host/test packages/adapter-agent-runtime-agently/test examples/agently-agent-runtime/test
```

Expected: typecheck and selected tests pass.

- [ ] **Step 3: Commit only the compatibility fix**

```bash
git add packages/agent-runtime-host/src/handoff-package-loader.ts packages/agent-runtime-host/test/handoff-package-loader.test.ts
git commit -m "fix(agent): normalize legacy handoff claim fields"
```

### Task 2: Define the Network Citizen wire-neutral SPI

**Files:**
- Create: `packages/network-citizen-spi/package.json`
- Create: `packages/network-citizen-spi/src/json.ts`
- Create: `packages/network-citizen-spi/src/contracts.ts`
- Create: `packages/network-citizen-spi/src/store.ts`
- Create: `packages/network-citizen-spi/src/runtime.ts`
- Create: `packages/network-citizen-spi/src/validation.ts`
- Create: `packages/network-citizen-spi/src/index.ts`
- Test: `packages/network-citizen-spi/test/contracts.test.ts`

**Interfaces:**
- Consumes: no Work Fabric implementation package.
- Produces:

```ts
export type NetworkCitizenKind =
  | "decision-body"
  | "capability-provider"
  | "channel"
  | "context-provider"
  | "governance-provider"
  | "observer";

export type CitizenAvailability =
  | "available"
  | "degraded"
  | "draining"
  | "unavailable";

export interface CitizenIdentity {
  readonly principal_id: string;
  readonly actor?: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly endpoint_id?: string;
}

export interface CitizenSchemaReference {
  readonly uri: string;
  readonly digest: `sha256:${string}`;
}

export interface CitizenDeclarationSummary {
  readonly declaration_id: string;
  readonly declaration_kind: "capability" | "context" | "channel" | "policy";
  readonly version: string;
  readonly name: string;
  readonly description: string;
}

export interface CitizenDeclaration extends CitizenDeclarationSummary {
  readonly input_schema?: CitizenSchemaReference;
  readonly output_schema?: CitizenSchemaReference;
  readonly interaction_modes: readonly ("synchronous" | "asynchronous" | "status-updates")[];
  readonly risk: "low" | "medium" | "high" | "destructive";
  readonly confirmation: "none" | "explicit";
  readonly constraints: CitizenJsonObject;
  readonly extensions: CitizenJsonObject;
}

export interface NetworkCitizenDescriptor {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly version: string;
  readonly identity: CitizenIdentity | null;
  readonly protocol: {
    readonly versions: readonly string[];
    readonly bindings: readonly string[];
  };
  readonly declarations: {
    readonly count: number;
    readonly digest: `sha256:${string}`;
  };
  readonly availability: CitizenAvailability;
  readonly extensions: CitizenJsonObject;
}
```

- [ ] **Step 1: Write failing exact-contract tests**

Add tests proving:

```ts
expect(assertNetworkCitizenKind("capability-provider")).toBe("capability-provider");
expect(() => assertNetworkCitizenKind("database")).toThrow(/citizen_kind/);
expect(() => validateCitizenDescriptor({
  citizen_id: "feishu-actions",
  citizen_kind: "capability-provider",
  version: "1.0.0",
  identity: null,
  protocol: { versions: ["1"], bindings: ["https://private.local"] },
  declarations: { count: 0, digest: `sha256:${"a".repeat(64)}` },
  availability: "available",
  extensions: {},
})).toThrow(/binding/);
```

Also test exact keys, bounded strings/arrays/depth, semantic versions, digest format, duplicate declarations, schema-reference immutability input shape, and deep-frozen validator output.

- [ ] **Step 2: Run the SPI test and verify RED**

```bash
npx vitest run packages/network-citizen-spi/test/contracts.test.ts
```

Expected: FAIL because the package and exports do not exist.

- [ ] **Step 3: Implement JSON-safe cloning and exact validators**

`json.ts` must reject:

```ts
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
```

It must also reject non-finite numbers, accessors, symbols, functions, cycles,
depth greater than `16`, and serialized values over `256 KiB`.

`validation.ts` must use these exact ID patterns:

```ts
const CITIZEN_ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const DECLARATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
```

- [ ] **Step 4: Define store and runtime ports**

`store.ts` exports:

```ts
export interface CitizenStoreManifest {
  readonly profile: "network-citizen.store.v1";
  readonly adapter: string;
  readonly capabilities: {
    readonly tenant_isolation: true;
    readonly optimistic_registration: true;
    readonly idempotent_session_open: true;
    readonly monotonic_fencing: true;
    readonly declaration_cas: true;
    readonly deterministic_pagination: true;
  };
}

export interface CitizenProvisioning {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly principal_id: string;
  readonly allowed_actor?: CitizenIdentity["actor"];
  readonly allowed_endpoint_id?: string;
  readonly allowed_declaration_namespaces: readonly string[];
  readonly maximum_risk: CitizenDeclaration["risk"];
  readonly administrative_state: "enabled" | "disabled";
  readonly registration_version: number;
}

export interface PutCitizenProvisioning {
  readonly tenant_id: string;
  readonly provisioning: CitizenProvisioning;
  readonly expected_registration_version: number | null;
  readonly recorded_at: string;
}

export interface OpenCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly accepted_lease_seconds: number;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly opened_at: string;
}

export interface HeartbeatCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: CitizenAvailability;
  readonly request_digest: string;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly updated_at: string;
}

export interface ReplaceCitizenDeclarations {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly registration_version: number;
  readonly expected_declaration_version: number;
  readonly declarations: readonly CitizenDeclaration[];
  readonly declaration_digest: `sha256:${string}`;
  readonly request_digest: string;
  readonly updated_at: string;
}

export interface CloseCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly closed_at: string;
}

export interface StoredCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly declaration_version: number;
  readonly declaration_digest: `sha256:${string}`;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly state: "active" | "closed" | "fenced";
  readonly expires_at: string;
  readonly renew_after: string;
  readonly request_digest: string;
  readonly opened_at: string;
  readonly updated_at: string;
}

export interface ProjectedCitizen {
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly lease: {
    readonly session_id: string;
    readonly fencing_token: number;
    readonly declaration_version: number;
    readonly expires_at: string;
    readonly renew_after: string;
  } | null;
}

export interface CitizenDiscoveryQuery {
  readonly tenant_id: string;
  readonly citizen_kind?: NetworkCitizenKind;
  readonly declaration_id?: string;
  readonly availability?: readonly CitizenAvailability[];
  readonly executable_only?: boolean;
  readonly cursor?: string;
  readonly limit: number;
  readonly now: string;
}

export interface CitizenDiscoveryPage {
  readonly items: readonly ProjectedCitizen[];
  readonly next_cursor?: string;
}

export interface NetworkCitizenStore {
  readonly manifest: CitizenStoreManifest;
  putProvisioning(input: PutCitizenProvisioning): Promise<CitizenProvisioning>;
  getProvisioning(tenantId: string, citizenId: string): Promise<CitizenProvisioning | null>;
  openSession(input: OpenCitizenSession): Promise<StoredCitizenSession>;
  heartbeat(input: HeartbeatCitizenSession): Promise<StoredCitizenSession>;
  replaceDeclarations(input: ReplaceCitizenDeclarations): Promise<StoredCitizenSession>;
  closeSession(input: CloseCitizenSession): Promise<StoredCitizenSession>;
  getSession(tenantId: string, citizenId: string, sessionId: string): Promise<StoredCitizenSession | null>;
  getSessionByClientId(tenantId: string, citizenId: string, clientSessionId: string): Promise<StoredCitizenSession | null>;
  getProjectedCitizen(tenantId: string, citizenId: string, now: string): Promise<ProjectedCitizen | null>;
  discover(input: CitizenDiscoveryQuery): Promise<CitizenDiscoveryPage>;
}
```

`runtime.ts` exports `NetworkCitizenRuntime`, `NetworkCitizenFactory`,
`CapabilityExecutor`, `CapabilityProviderRuntimePort`,
`ContextProviderRuntimePort`, `ChannelRuntimePort`, `GovernanceRuntimePort`
and `ObserverRuntimePort`. No method accepts a vendor SDK or configuration-file
type.

The common runtime shapes are:

```ts
export interface CitizenSessionOpenInput {
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly requested_lease_seconds?: number;
  readonly expected_registration_version: number;
}

export interface CitizenHeartbeatInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: CitizenAvailability;
  readonly expected_registration_version: number;
}

export interface CitizenDeclarationReplaceInput {
  readonly fencing_token: number;
  readonly expected_registration_version: number;
  readonly expected_declaration_version: number;
  readonly declarations: readonly CitizenDeclaration[];
}

export interface CitizenSessionCloseInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly expected_registration_version: number;
}

export interface PublicCitizenSession {
  readonly citizen_id: string;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly declaration_version: number;
  readonly declaration_digest: `sha256:${string}`;
  readonly accepted_lease_seconds: number;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly state: "active" | "closed" | "fenced";
  readonly expires_at: string;
  readonly renew_after: string;
  readonly registration_version: number;
}

export interface CitizenSessionClient {
  openSession(citizenId: string, input: CitizenSessionOpenInput): Promise<PublicCitizenSession>;
  heartbeat(citizenId: string, sessionId: string, input: CitizenHeartbeatInput): Promise<PublicCitizenSession>;
  replaceDeclarations(citizenId: string, sessionId: string, input: CitizenDeclarationReplaceInput): Promise<PublicCitizenSession>;
  closeSession(citizenId: string, sessionId: string, input: CitizenSessionCloseInput): Promise<PublicCitizenSession>;
}

export interface CitizenHealth {
  readonly status: "starting" | "available" | "degraded" | "unavailable" | "closed";
  readonly session_id: string | null;
  readonly fencing_token: number | null;
  readonly declaration_version: number | null;
  readonly checked_at: string;
  readonly detail_code?: string;
}

export interface CitizenRuntimeContext {
  readonly tenant_id: string;
  readonly client: CitizenSessionClient;
  readonly clock: {
    now(): string;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly requested_lease_seconds: number;
  readonly heartbeat_safety_margin_ms: number;
  readonly signal: AbortSignal;
}

export interface NetworkCitizenRuntime {
  readonly citizen_kind: NetworkCitizenKind;
  start(context: CitizenRuntimeContext): Promise<void>;
  health(): Promise<CitizenHealth>;
  close(): Promise<void>;
}

export interface NetworkCitizenFactory<TConfig = unknown> {
  readonly type: string;
  readonly citizen_kind: NetworkCitizenKind;
  validate(value: unknown, path: string): TConfig;
  create(config: TConfig): Promise<NetworkCitizenRuntime>;
}
```

- [ ] **Step 5: Run SPI tests and typecheck**

```bash
npx vitest run packages/network-citizen-spi/test/contracts.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/network-citizen-spi package-lock.json
git commit -m "feat(citizen): define network citizen contracts"
```

### Task 3: Implement the in-memory store and Citizen Directory

**Files:**
- Create: `packages/adapter-network-citizen-memory/package.json`
- Create: `packages/adapter-network-citizen-memory/src/memory-network-citizen-store.ts`
- Create: `packages/adapter-network-citizen-memory/src/index.ts`
- Test: `packages/adapter-network-citizen-memory/test/memory-network-citizen-store.test.ts`
- Create: `packages/network-citizen-directory/package.json`
- Create: `packages/network-citizen-directory/src/errors.ts`
- Create: `packages/network-citizen-directory/src/network-citizen-directory-service.ts`
- Create: `packages/network-citizen-directory/src/index.ts`
- Test: `packages/network-citizen-directory/test/network-citizen-directory-service.test.ts`

**Interfaces:**
- Consumes: all contracts from Task 2.
- Produces:

```ts
export interface CitizenCallContext {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly represented_actor?: CitizenIdentity["actor"];
  readonly represented_endpoint_id?: string;
}

export interface CitizenCardPage {
  readonly items: readonly NetworkCitizenDescriptor[];
  readonly next_cursor?: string;
}

export interface CitizenDeclarationSummaryPage {
  readonly items: readonly CitizenDeclarationSummary[];
}

export interface CitizenDeclarationContract {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly availability: CitizenAvailability;
  readonly declaration: CitizenDeclaration;
  readonly declaration_version: number;
  readonly fencing_token: number;
}
```

- [ ] **Step 1: Write failing store conformance tests**

Test:

- provisioning CAS starts at version `1`;
- Actor/Endpoint and Citizen kind cannot change;
- repeated `client_session_id` with identical digest is idempotent;
- a new session fences the prior active session and increments fencing;
- heartbeat cannot alter declarations;
- declaration replacement requires current fencing and both expected versions;
- session expiry projects `unavailable`;
- draining is discoverable but excluded from executable discovery;
- cursors are query-bound and deterministic;
- values returned from the store are clones.

- [ ] **Step 2: Run memory tests and verify RED**

```bash
npx vitest run packages/adapter-network-citizen-memory/test
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement atomic memory persistence**

Follow `MemoryEndpointDirectoryStore`'s serialized `mutationTail` pattern.
Keys must be the JSON tuple:

```ts
JSON.stringify([tenantId, citizenId, optionalSessionId])
```

Declaration digest is SHA-256 over recursively key-sorted canonical JSON.
Replacing declarations increments `declaration_version` exactly once and
updates the descriptor's declaration count/digest atomically.

- [ ] **Step 4: Write failing Directory behavior tests**

Prove:

```ts
await expect(directory.openSession({
  tenant_id: "tenant-a",
  principal_id: "principal-b",
}, "feishu-actions", input)).rejects.toMatchObject({
  code: "representation_denied",
});
```

Also prove namespace/risk ceilings, one-kind binding, schema URI/digest
immutability within the directory, exact declaration lookup, four progressive
disclosure methods, separate list/detail call paths, lease bounds and stable
error mapping.

- [ ] **Step 5: Implement the Directory service**

Export these methods:

```ts
provision(context, input, expectedVersion): Promise<CitizenProvisioning>;
openSession(context, citizenId, input): Promise<PublicCitizenSession>;
heartbeat(context, citizenId, sessionId, input): Promise<PublicCitizenSession>;
replaceDeclarations(context, citizenId, sessionId, input): Promise<PublicCitizenSession>;
closeSession(context, citizenId, sessionId, input): Promise<PublicCitizenSession>;
discoverCitizens(context, input): Promise<CitizenCardPage>;
getCitizen(context, citizenId): Promise<NetworkCitizenDescriptor>;
listDeclarations(context, citizenId): Promise<CitizenDeclarationSummaryPage>;
getDeclaration(context, citizenId, declarationId): Promise<CitizenDeclarationContract>;
```

Use stable errors:

```ts
type CitizenDirectoryErrorCode =
  | "invalid_request"
  | "not_found"
  | "representation_denied"
  | "citizen_disabled"
  | "version_conflict"
  | "idempotency_conflict"
  | "immutable_binding"
  | "session_fenced"
  | "stale_sequence"
  | "schema_digest_conflict"
  | "temporarily_unavailable";
```

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run packages/network-citizen-spi/test packages/adapter-network-citizen-memory/test packages/network-citizen-directory/test
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-network-citizen-memory packages/network-citizen-directory package-lock.json
git commit -m "feat(citizen): add dynamic citizen directory"
```

### Task 4: Add durable SQLite Citizen storage

**Files:**
- Create: `packages/adapter-network-citizen-sqlite/package.json`
- Create: `packages/adapter-network-citizen-sqlite/migrations/001_network_citizens.sql`
- Create: `packages/adapter-network-citizen-sqlite/src/sqlite-network-citizen-store.ts`
- Create: `packages/adapter-network-citizen-sqlite/src/index.ts`
- Test: `packages/adapter-network-citizen-sqlite/test/sqlite-network-citizen-store.test.ts`

**Interfaces:**
- Consumes: `NetworkCitizenStore`.
- Produces: `SqliteNetworkCitizenStore` with behavior identical to Task 3's memory adapter.

- [ ] **Step 1: Write failing parity and restart tests**

Run the same conformance cases against `:memory:` and a temporary file. Add a
restart test that provisions, opens a session, replaces declarations, closes
the connection, reopens it and observes the same fencing/declaration versions.

- [ ] **Step 2: Run SQLite tests and verify RED**

```bash
npx vitest run packages/adapter-network-citizen-sqlite/test
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Create the forward-only schema**

The migration creates:

```sql
network_citizen_provisioning(
  tenant_id, citizen_id, citizen_kind, principal_id, registration_json,
  registration_version, created_at, updated_at,
  PRIMARY KEY(tenant_id, citizen_id)
)
network_citizen_sessions(
  tenant_id, citizen_id, session_id, client_session_id, state,
  fencing_token, heartbeat_sequence, declaration_version,
  declaration_digest, session_json, request_digest, expires_at,
  renew_after, opened_at, updated_at,
  PRIMARY KEY(tenant_id, citizen_id, session_id),
  UNIQUE(tenant_id, citizen_id, client_session_id)
)
network_citizen_active_sessions(
  tenant_id, citizen_id, session_id, fencing_token,
  PRIMARY KEY(tenant_id, citizen_id)
)
network_citizen_schema_digests(
  tenant_id, schema_uri, schema_digest,
  PRIMARY KEY(tenant_id, schema_uri)
)
```

Use `BEGIN IMMEDIATE` for provisioning/session/declaration CAS and never
deserialize a row before checking tenant predicates.

- [ ] **Step 4: Implement and run parity tests**

```bash
npx vitest run packages/adapter-network-citizen-memory/test packages/adapter-network-citizen-sqlite/test
npm run typecheck
```

Expected: both adapters pass the same behavior suite.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-network-citizen-sqlite package-lock.json
git commit -m "feat(citizen): persist citizen directory in sqlite"
```

### Task 5: Publish JSON Schemas and conformance fixtures

**Files:**
- Create: `protocol/schemas/v1/citizen/citizen-provisioning.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-descriptor.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-declaration.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-session-open.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-heartbeat.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-declaration-replace.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-session-close.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-discovery-page.schema.json`
- Create: `protocol/schemas/v1/citizen/citizen-declaration-page.schema.json`
- Create: `protocol/conformance/fixtures/positive/network-citizen.json`
- Create: `protocol/conformance/fixtures/negative/network-citizen.json`
- Test: `tools/conformance/test/network-citizen-schemas.test.ts`
- Modify: `tools/conformance/src/schema-registry.ts`

**Interfaces:**
- Consumes: Task 2's exact wire contracts.
- Produces: URNs `urn:work-fabric:schema:v1:citizen-*` resolvable by `WfppSchemaValidator`.

- [ ] **Step 1: Write failing schema-registry and fixture tests**

Test every positive artifact and prove negatives reject database Citizen kind,
unknown fields, malformed SHA-256 digest, an undeclared risk, oversized IDs
and missing declaration CAS fields.

- [ ] **Step 2: Run conformance tests and verify RED**

```bash
npx vitest run tools/conformance/test/network-citizen-schemas.test.ts
```

Expected: missing schema registrations.

- [ ] **Step 3: Implement strict Draft 2020-12 schemas**

Every object uses `"additionalProperties": false`. Reuse common Actor, JSON and
timestamp definitions by `$ref`; do not copy credentials, backend config or
storage fields into any schema.

- [ ] **Step 4: Run conformance**

```bash
npx vitest run tools/conformance/test/network-citizen-schemas.test.ts tools/conformance/test/schema-registry.test.ts
npm run conformance
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add protocol/schemas/v1/citizen protocol/conformance/fixtures tools/conformance
git commit -m "feat(protocol): publish network citizen schemas"
```

### Task 6: Expose Citizen HTTP routes and TypeScript SDK

**Files:**
- Create: `packages/transport-http/src/routes/citizen-routes.ts`
- Modify: `packages/transport-http/src/create-http-service.ts`
- Modify: `packages/transport-http/src/public-types.ts`
- Modify: `packages/transport-http/package.json`
- Test: `packages/transport-http/test/citizen-routes.test.ts`
- Create: `packages/sdk-typescript/src/citizen-client.ts`
- Modify: `packages/sdk-typescript/src/client.ts`
- Modify: `packages/sdk-typescript/src/index.ts`
- Modify: `packages/sdk-typescript/package.json`
- Test: `packages/sdk-typescript/test/citizen-client.test.ts`

**Interfaces:**
- Consumes: `NetworkCitizenDirectoryService` and Task 5 schemas.
- Produces:

```ts
class CitizenClient {
  provision(citizenId, input, options?): Promise<CitizenProvisioning>;
  list(input?, options?): Promise<CitizenCardPage>;
  get(citizenId, options?): Promise<NetworkCitizenDescriptor>;
  listDeclarations(citizenId, input?, options?): Promise<CitizenDeclarationSummaryPage>;
  getDeclaration(citizenId, declarationId, options?): Promise<CitizenDeclarationContract>;
  openSession(citizenId, input, options?): Promise<PublicCitizenSession>;
  heartbeat(citizenId, sessionId, input, options?): Promise<PublicCitizenSession>;
  replaceDeclarations(citizenId, sessionId, input, options?): Promise<PublicCitizenSession>;
  closeSession(citizenId, sessionId, input, options?): Promise<PublicCitizenSession>;
}
```

- [ ] **Step 1: Write failing route tests**

Assert exact routes and separate actions:

```text
PUT  /v1/admin/citizens/:citizen_id
GET  /v1/citizens
GET  /v1/citizens/:citizen_id
GET  /v1/citizens/:citizen_id/declarations
GET  /v1/citizens/:citizen_id/declarations/:declaration_id
POST /v1/citizens/:citizen_id/sessions
POST /v1/citizens/:citizen_id/sessions/:session_id/heartbeat
PUT  /v1/citizens/:citizen_id/sessions/:session_id/declarations
POST /v1/citizens/:citizen_id/sessions/:session_id/close
```

The four disclosure actions are:

```text
workfabric.citizen.discover.v1
workfabric.citizen.read.v1
workfabric.citizen.declaration-summary.read.v1
workfabric.citizen.declaration.read.v1
```

Also test schema errors return `400`, representation/disabled conceal as
`404`, CAS/fencing as `409`, and unavailable stores as `503`.

- [ ] **Step 2: Run route tests and verify RED**

```bash
npx vitest run packages/transport-http/test/citizen-routes.test.ts
```

Expected: routes return `404`.

- [ ] **Step 3: Implement route dependency and handlers**

Use existing `authorizeRoute`, Problem Details and schema validator patterns.
Never derive invocation permission from successful declaration discovery.

- [ ] **Step 4: Write failing SDK decoder tests**

Prove the client rejects unknown fields, malformed IDs/digests, non-safe
integers and sensitive keys while accepting every route response.

- [ ] **Step 5: Implement `CitizenClient`**

Reuse `Transport`, abort, retry and strict decoder utilities. Encode every path
segment with `encodeURIComponent`; emit no endpoint-specific compatibility
aliases from the SDK.

- [ ] **Step 6: Run HTTP/SDK tests and typecheck**

```bash
npx vitest run packages/transport-http/test/citizen-routes.test.ts packages/sdk-typescript/test/citizen-client.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-http packages/sdk-typescript package-lock.json
git commit -m "feat(citizen): expose citizen catalog HTTP SDK"
```

### Task 7: Add leased runtime and compose the service

**Files:**
- Create: `packages/network-citizen-runtime/package.json`
- Create: `packages/network-citizen-runtime/src/factory-registry.ts`
- Create: `packages/network-citizen-runtime/src/leased-network-citizen-runtime.ts`
- Create: `packages/network-citizen-runtime/src/index.ts`
- Test: `packages/network-citizen-runtime/test/factory-registry.test.ts`
- Test: `packages/network-citizen-runtime/test/leased-network-citizen-runtime.test.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/package.json`
- Test: `packages/service-node/test/memory-composition.integration.test.ts`
- Test: `packages/service-node/test/sqlite-restart.integration.test.ts`

**Interfaces:**
- Consumes: `CitizenClient`, `NetworkCitizenFactory`, memory/SQLite stores and `NetworkCitizenDirectoryService`.
- Produces:

```ts
export class NetworkCitizenFactoryRegistry {
  register(factory: NetworkCitizenFactory): void;
  resolve(type: string, expectedKind: NetworkCitizenKind): NetworkCitizenFactory;
}

export abstract class LeasedNetworkCitizenRuntime
  implements NetworkCitizenRuntime {
  start(context: CitizenRuntimeContext): Promise<void>;
  health(): Promise<CitizenHealth>;
  replaceDeclarations(declarations: readonly CitizenDeclaration[]): Promise<void>;
  close(): Promise<void>;
  protected abstract currentDescriptor(): NetworkCitizenDescriptor;
  protected abstract currentDeclarations(): readonly CitizenDeclaration[];
}
```

- [ ] **Step 1: Write failing factory tests**

Prove duplicate types are rejected, missing types fail closed, expected kind
must match, and the registry does not inspect vendor configuration.

- [ ] **Step 2: Write failing leased lifecycle tests**

With a fake `CitizenClient` and fake clock prove:

- start opens exactly one session;
- heartbeat never carries declarations;
- explicit replacement uses current declaration version and fencing;
- lease loss changes health to `unavailable` and stops declaring availability;
- close is idempotent;
- a failed start rolls back by closing any opened session;
- descriptor changes outside an explicit replacement are rejected.

- [ ] **Step 3: Implement registry and leased runtime**

Heartbeat timing is:

```ts
renewAt = min(serverRenewAfter, expiresAt - configuredSafetyMargin)
```

Only one timer and one in-flight mutation may exist. `close()` aborts the
timer, awaits the mutation tail and closes with the next heartbeat sequence.

- [ ] **Step 4: Compose memory and SQLite directories**

Add `citizens: NetworkCitizenDirectoryService` to service composition. Memory
uses `MemoryNetworkCitizenStore`; SQLite uses `SqliteNetworkCitizenStore` on
the existing service database connection. Register Citizen routes for API/all
roles. Do not start any vendor Citizen in this task.

- [ ] **Step 5: Run foundation regression**

```bash
npx vitest run \
  packages/network-citizen-spi/test \
  packages/adapter-network-citizen-memory/test \
  packages/adapter-network-citizen-sqlite/test \
  packages/network-citizen-directory/test \
  packages/network-citizen-runtime/test \
  packages/transport-http/test/citizen-routes.test.ts \
  packages/sdk-typescript/test/citizen-client.test.ts \
  packages/service-node/test/memory-composition.integration.test.ts \
  packages/service-node/test/sqlite-restart.integration.test.ts
npm run typecheck
npm run conformance
```

Expected: all selected tests, typecheck and conformance pass.

- [ ] **Step 6: Commit**

```bash
git add packages/network-citizen-runtime packages/service-node package-lock.json
git commit -m "feat(citizen): compose leased citizen runtime foundation"
```

### Task 8: Document the foundation and define the next execution boundary

**Files:**
- Create: `docs/architecture/network-citizens.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `protocol/spec/roles.md`
- Modify: `protocol/README.md`
- Test: `tools/conformance/test/documentation.test.ts`

**Interfaces:**
- Consumes: the implemented foundation.
- Produces: normative project rules and operator-facing registration/discovery examples.

- [ ] **Step 1: Write failing documentation contract assertions**

Require the documentation to contain all six Citizen kinds, the Actor/Citizen
orthogonality rule, dynamic runtime truth, declaration-not-Authority rule,
one-kind-per-registration rule, progressive disclosure levels, session
fencing/CAS, module responsibility closure and the non-citizen infrastructure
list.

- [ ] **Step 2: Run documentation tests and verify RED**

```bash
npx vitest run tools/conformance/test/documentation.test.ts
```

Expected: missing Network Citizen normative sections.

- [ ] **Step 3: Write architecture and usage documentation**

Include complete HTTP and TypeScript SDK examples for provision, session open,
declaration replace, discovery and close. State that the next subproject adds
the Agent `CapabilityInvocationPort`, not vendor calls in Core.

- [ ] **Step 4: Run full release verification**

```bash
npm run verify
```

Expected: typecheck, all Vitest suites and protocol conformance pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md docs/architecture/network-citizens.md docs/roadmap.md protocol/README.md protocol/spec/roles.md tools/conformance/test/documentation.test.ts
git commit -m "docs: publish network citizen architecture"
```
