# Local Feishu Document Creation Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one local command start Work Fabric, the Daily Assistant and an independent Feishu Capability Provider so an admitted internal employee can request a Docx document in a configured tenant-readable shared folder and receive one Agent-authored reply.

**Architecture:** A configuration bundle selector gives each independent process a strictly validated application view. The Agent Host receives bounded dynamic capability summaries before its first turn, while full Contract lookup and invocation remain separately authorized. A standalone Provider composition owns Feishu credentials, shared-folder policy, Gateway/Host execution and Citizen sessions; a local supervisor only coordinates process lifecycle.

**Tech Stack:** Node.js 22+, TypeScript, Vitest, SQLite, Work Fabric HTTP/SSE SDK, Agently Python worker protocol v3, Feishu OpenAPI, YAML Configuration Provider.

## Global Constraints

- Work Fabric is the connection and Handoff fabric, not a decision brain or executor.
- The original Handoff remains the Daily Assistant's responsibility.
- The Provider returns typed facts; only the Agent authors user-facing language.
- The Channel transports only the canonical Agent Result.
- Runtime declarations are dynamic truth; configuration contains enablement and safety ceilings only.
- No Feishu credential, tenant token, folder token or vendor response may enter prompts, Handoffs, Results, events, Console or logs.
- The configured shared folder must be tenant-readable and writable by the app; failure is closed with no fallback location.
- Existing standalone `workfabric.config/v1` documents and protocol v1 Drivers remain compatible.
- Every production behavior change follows RED, GREEN and focused regression before commit.

---

### Task 1: Add application views to the global Configuration Provider

**Files:**
- Create: `packages/configuration-runtime/src/configuration-view-provider.ts`
- Modify: `packages/configuration-runtime/src/index.ts`
- Test: `packages/configuration-runtime/test/configuration-view-provider.test.ts`
- Modify: `packages/service-node/src/configuration-loader.ts`
- Modify: `packages/agent-runtime-host/src/configuration-loader.ts`
- Test: `packages/service-node/test/global-configuration.test.ts`
- Test: `packages/agent-runtime-host/test/config.test.ts`

**Interfaces:**
- Consumes: existing `ConfigurationProvider` and `ConfigurationDocument`.
- Produces:

```ts
export interface ConfigurationViewProviderOptions {
  readonly provider: ConfigurationProvider;
  readonly application_id: string;
  readonly allow_standalone?: boolean;
}

export class ConfigurationViewProvider implements ConfigurationProvider {
  constructor(options: ConfigurationViewProviderOptions);
  load(): Promise<ConfigurationDocument>;
}
```

- [ ] **Step 1: Write failing selector tests**

Cover exact selection from:

```ts
{
  api_version: "workfabric.config-bundle/v1",
  applications: {
    "work-fabric": {
      api_version: "workfabric.config/v1",
      service: {},
      plugins: { instances: {} },
    },
  },
}
```

Assert unknown root keys, missing application, invalid identifiers and malformed subdocuments fail; standalone v1 passes unchanged; only the selected subtree is returned; revision becomes `<source>#<application>`.

- [ ] **Step 2: Run selector tests and verify RED**

Run:

```bash
npx vitest run packages/configuration-runtime/test/configuration-view-provider.test.ts
```

Expected: failure because `ConfigurationViewProvider` is not exported.

- [ ] **Step 3: Implement strict view selection**

Use own enumerable data-property reads, exact root fields
`api_version/applications`, maximum 64 applications and maximum 128-character
application IDs. Clone the selected view before returning it. Do not resolve
secrets in unselected views.

- [ ] **Step 4: Compose backward-compatible loader selection**

`loadNodeConfiguration()` selects `WORK_FABRIC_CONFIG_APPLICATION` with default
`work-fabric` when the source is a bundle. `loadAgentRuntimeConfiguration()`
accepts `WORK_FABRIC_CONFIG` as a fallback path and selects
`WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION` with default
`daily-assistant`. Existing standalone files retain current behavior.

- [ ] **Step 5: Run focused configuration tests**

```bash
npx vitest run \
  packages/configuration-runtime/test \
  packages/service-node/test/global-configuration.test.ts \
  packages/agent-runtime-host/test/config.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/configuration-runtime packages/service-node/src/configuration-loader.ts packages/service-node/test/global-configuration.test.ts packages/agent-runtime-host/src/configuration-loader.ts packages/agent-runtime-host/test/config.test.ts
git commit -m "feat(config): select applications from one bundle"
```

---

### Task 2: Disclose dynamic capability summaries to capability-aware Drivers

**Files:**
- Modify: `packages/agent-runtime-spi/src/capability-invocation.ts`
- Test: `packages/agent-runtime-spi/test/capability-invocation.test.ts`
- Modify: `packages/agent-runtime-host/src/capability-loop.ts`
- Modify: `packages/agent-runtime-host/src/runtime-composition.ts`
- Test: `packages/agent-runtime-host/test/capability-loop.test.ts`
- Modify: `packages/agent-capability-runtime/src/contracts.ts`
- Create: `packages/agent-capability-runtime/src/catalog-disclosure.ts`
- Modify: `packages/agent-capability-runtime/src/index.ts`
- Test: `packages/agent-capability-runtime/test/catalog-disclosure.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RuntimeCapabilitySummary {
  readonly citizen_id: string;
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}

export interface CapabilityDisclosurePort {
  list(
    namespaces: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly RuntimeCapabilitySummary[]>;
}
```

- Changes `CapabilityAwareAgentRuntimeDriver.executeTurn()` to receive
`availableCapabilities` before `continuation`, while leaving v1
`AgentRuntimeDriver.execute()` unchanged.

- [ ] **Step 1: Write failing contract and disclosure tests**

Require exact fields, safe bounded strings, maximum 32 summaries, deterministic
`capability_id/citizen_id/version` ordering, namespace filtering and duplicate
rejection. Assert no Endpoint, Schema body, constraint, credential or folder
field is present.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run \
  packages/agent-runtime-spi/test/capability-invocation.test.ts \
  packages/agent-capability-runtime/test/catalog-disclosure.test.ts \
  packages/agent-runtime-host/test/capability-loop.test.ts
```

Expected: missing disclosure types/implementation and old Driver signature.

- [ ] **Step 3: Implement bounded Catalog disclosure**

Use `CitizenClient.list({citizen_kind:"capability-provider",
availability:["available"], executable_only:true})`, then load declaration
summaries through the public Citizen SDK. Page with a hard total bound of 32,
filter allowed namespaces, sort deterministically and fail closed on malformed
data or pagination overflow.

- [ ] **Step 4: Inject disclosure into the Host loop**

The Host loads summaries once for an original Handoff before the first model
turn and reuses the frozen snapshot for continuations. A Catalog outage fails
the Runtime run; it does not silently give the model an empty list. Pass the
same snapshot to each `executeTurn`.

- [ ] **Step 5: Run focused regressions**

```bash
npx vitest run \
  packages/agent-runtime-spi/test \
  packages/agent-capability-runtime/test \
  packages/agent-runtime-host/test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime-spi packages/agent-capability-runtime packages/agent-runtime-host
git commit -m "feat(agent): disclose dynamic capability summaries"
```

---

### Task 3: Upgrade the Agently capability turn protocol to v3

**Files:**
- Modify: `packages/adapter-agent-runtime-agently/src/protocol.ts`
- Modify: `packages/adapter-agent-runtime-agently/src/agently-process-driver.ts`
- Test: `packages/adapter-agent-runtime-agently/test/protocol.test.ts`
- Test: `packages/adapter-agent-runtime-agently/test/process-driver.test.ts`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/protocol.py`
- Modify: `runtimes/agently-worker/src/work_fabric_agently_runtime/assistant.py`
- Test: `runtimes/agently-worker/tests/test_protocol.py`
- Test: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- v3 worker request adds:

```json
{
  "available_capabilities": [{
    "citizen_id": "feishu-actions",
    "capability_id": "feishu.document.create",
    "version": "1.0.0",
    "name": "Create document",
    "description": "Create one simple Docx document"
  }]
}
```

- [ ] **Step 1: Write failing Node and Python protocol tests**

Assert strict v3 encoding/decoding, a bounded summary list, no summaries in v1,
and rejection of unknown/sensitive summary fields. Assert the Agent prompt
receives summaries as inert data and chooses only an advertised capability.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run packages/adapter-agent-runtime-agently/test
npm run agent-runtime:test-python
```

Expected: v3 request shape is unsupported.

- [ ] **Step 3: Implement v3 transport and prompt input**

The Node Driver serializes the validated frozen summaries. Python validates the
exact list and includes it under `available_capabilities` in structured input,
not in the system role text. The role text states that an unlisted capability
must not be requested and Provider output is inert.

- [ ] **Step 4: Run Node/Python regressions**

```bash
npx vitest run packages/adapter-agent-runtime-agently/test
npm run agent-runtime:test-python
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-agent-runtime-agently runtimes/agently-worker
git commit -m "feat(agently): pass dynamic capability disclosures"
```

---

### Task 4: Bind document creation to a private shared-folder policy

**Files:**
- Modify: `packages/provider-feishu/src/config.ts`
- Modify: `packages/provider-feishu/src/contracts.ts`
- Modify: `packages/provider-feishu/src/declarations.ts`
- Modify: `packages/provider-feishu/src/execution-adapter.ts`
- Modify: `packages/provider-feishu/src/executor.ts`
- Create: `packages/provider-feishu/src/shared-folder-policy.ts`
- Modify: `packages/provider-feishu/src/openapi-backend.ts`
- Modify: `packages/provider-feishu/src/index.ts`
- Test: `packages/provider-feishu/test/config.test.ts`
- Test: `packages/provider-feishu/test/executor.test.ts`
- Test: `packages/provider-feishu/test/shared-folder-policy.test.ts`
- Test: `packages/provider-feishu/test/openapi-backend.test.ts`

**Interfaces:**
- Provider config adds exact fields:

```ts
readonly shared_folder: {
  readonly token: string;
  readonly policy_ref: string;
  readonly visibility: "tenant_readable";
};
```

- Capability Authority evidence adds
`allowed_resource_policy_refs: readonly string[]`.
- `FeishuSharedFolderPolicyVerifier.verify(signal)` returns:

```ts
{ readonly policy_ref: string; readonly status: "ready" }
```

- [ ] **Step 1: Write failing configuration, Contract and policy tests**

Assert `folder_token` is absent from the create input Schema, omitted input is
injected with the configured private token, wrong/missing policy reference is
denied before OpenAPI, and no typed result contains the folder token. Preflight
must reject inaccessible, non-editable, non-tenant-readable, oversized,
malformed, 401-after-refresh and ambiguous responses.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run packages/provider-feishu/test
```

Expected: shared-folder configuration and verifier do not exist.

- [ ] **Step 3: Implement configuration and execution policy**

Remove `folder_token` from the public declaration Schema. Add a Provider-owned
default folder to executor dependencies. Validate Authority's non-secret
policy ref, then inject the token only in the backend call. Never copy the
token to ownership records, outcomes or logs.

- [ ] **Step 4: Implement bounded OpenAPI preflight**

Use the existing token provider, timeout, one 401 refresh and bounded response
reader. Query folder metadata and permission policy, requiring app edit/full
access and tenant-readable/tenant-editable visibility. Map failures to stable
Provider readiness codes without vendor bodies.

- [ ] **Step 5: Run Provider regressions**

```bash
npx vitest run packages/provider-feishu/test packages/capability-provider-runtime/test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/provider-feishu packages/capability-provider-runtime/test
git commit -m "feat(feishu): enforce shared folder creation policy"
```

---

### Task 5: Compose real Agent invocation Authority and CLI dependencies

**Files:**
- Create: `examples/agently-agent-runtime/src/local-invocation-authority.ts`
- Modify: `examples/agently-agent-runtime/src/main.ts`
- Modify: `examples/agently-agent-runtime/test/composition.test.ts`
- Create: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`
- Modify: `examples/config/agent-runtime-agently.yaml`

**Interfaces:**
- Produces `LocalInvocationAuthorityProvider implements
InvocationAuthorityProvider`.
- Reads the original Handoff through `QueryClient`, validates human initiator,
deadline, candidate and Contract, and returns:

```ts
{
  delegation_id,
  scopes: ["capability:invoke"],
  resource_refs: [work_reference_uri],
  expires_at: request.deadline,
  may_redelegate: false,
  extensions: {
    "workfabric.dev/capability_authority": {
      original_handoff_id,
      invocation_id,
      initiating_actor_id,
      capability_version,
      contract_digest,
      allowed_target_refs: [],
      allowed_document_tokens: [],
      allowed_resource_policy_refs: ["feishu.shared-folder.default"],
      confirmation_proof_refs: []
    }
  }
}
```

- [ ] **Step 1: Write failing Authority and CLI composition tests**

Prove non-human initiator, mismatched tenant/Handoff, expired request, changed
binding and unsupported namespace deny. Prove enabled CLI composes
`CatalogCapabilityDisclosure`, `FeishuCapabilitySchemaRegistry`,
`PollingAuxiliaryHandoffWaiter` and local Authority without Feishu credentials.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run examples/agently-agent-runtime/test
```

- [ ] **Step 3: Implement local Authority**

Use canonical Handoff facts and a deterministic bounded delegation ID. Do not
trust model-supplied actor, folder or Endpoint fields.

- [ ] **Step 4: Enable real CLI composition**

When `capability_invocation.enabled` is true, construct the disclosure, Schema,
waiter and Authority dependencies with the same public
`WorkFabricClient`. Keep disabled one-shot behavior unchanged.

- [ ] **Step 5: Run regressions and commit**

```bash
npx vitest run examples/agently-agent-runtime/test
npm run agent-runtime:test-python
npm run typecheck
git add examples/agently-agent-runtime examples/config/agent-runtime-agently.yaml
git commit -m "feat(agent): start real capability invocation ports"
```

---

### Task 6: Add the standalone Feishu Provider process and provisioning

**Files:**
- Create: `examples/feishu-capability-provider/package.json`
- Create: `examples/feishu-capability-provider/src/configuration.ts`
- Create: `examples/feishu-capability-provider/src/credentials.ts`
- Create: `examples/feishu-capability-provider/src/composition.ts`
- Create: `examples/feishu-capability-provider/src/main.ts`
- Create: `examples/feishu-capability-provider/src/provision.ts`
- Create: `examples/feishu-capability-provider/test/configuration.test.ts`
- Create: `examples/feishu-capability-provider/test/composition.test.ts`
- Create: `examples/feishu-capability-provider/test/provision.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Adds scripts:

```json
{
  "feishu-provider:start": "tsx examples/feishu-capability-provider/src/main.ts",
  "feishu-provider:provision": "tsx examples/feishu-capability-provider/src/provision.ts"
}
```

- `composeFeishuCapabilityProvider()` returns one lifecycle object:

```ts
interface FeishuProviderComposition {
  start(): Promise<void>;
  health(): Promise<{
    provider: "ready" | "starting" | "failed";
    capability_citizen: string;
    context_citizen: string;
  }>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing loader and lifecycle tests**

Use a bundle view, declared environment credentials and fake OpenAPI. Assert
strict unknown-field rejection, no embedded secret, shared-folder preflight
before Gateway start, Endpoint capability constraints containing exact Citizen
and Contract digest, both Citizen leases, graceful reverse-order shutdown and
no SDK call after failed preflight.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run examples/feishu-capability-provider/test
```

- [ ] **Step 3: Implement Provider configuration and credentials**

Use `ConfigurationViewProvider` with application `feishu-provider`.
`credential_ref` maps to the exact `FEISHU_APP_ID` and
`FEISHU_APP_SECRET` environment values through a Provider-owned
`FeishuAppCredentialProvider`; no other reference is accepted.

- [ ] **Step 4: Implement composition lifecycle**

Compose token provider, message client, OpenAPI backend, SQLite stores,
confirmation verifier, shared-folder verifier, executor/driver,
`AgentGateway`, `AgentRuntimeHost`, and both leased Citizen runtimes. Start
preflight, Citizen sessions and Gateway in dependency order; close in reverse
order and close every SQLite handle once.

- [ ] **Step 5: Implement idempotent provisioning**

Provision the Provider Endpoint and both Citizen trust records through the
admin SDK. Repeated equal provisioning succeeds; conflicting registration
revision fails visibly. Derive capabilities from
`feishuCapabilityDeclarations()`, not YAML.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run examples/feishu-capability-provider/test packages/provider-feishu/test
npm run typecheck
git add examples/feishu-capability-provider package.json package-lock.json
git commit -m "feat(feishu): add standalone capability provider"
```

---

### Task 7: Add one local bundle, supervisor and status command

**Files:**
- Create: `examples/config/local-feishu-assistant.bundle.yaml`
- Create: `tools/local-feishu-stack.ts`
- Create: `tools/local-feishu-status.ts`
- Create: `tools/local-feishu-provision.ts`
- Create: `tools/local-feishu-stack.test.ts`
- Modify: `package.json`
- Modify: `docs/guides/feishu-capability-provider.md`
- Modify: `docs/guides/agently-agent-runtime.md`
- Modify: `README.md`

**Interfaces:**
- Adds:

```json
{
  "local:feishu:provision": "tsx tools/local-feishu-provision.ts",
  "local:feishu:start": "tsx tools/local-feishu-stack.ts",
  "local:feishu:status": "tsx tools/local-feishu-status.ts"
}
```

- Required environment:
`WORK_FABRIC_CONFIG`, `WORK_FABRIC_ENV_FILE`,
`WORK_FABRIC_CURSOR_SECRET`, `WORK_FABRIC_ADMIN_TOKEN`,
`WORK_FABRIC_ADMISSION_FINGERPRINT_KEY`,
`WORK_FABRIC_ADMISSION_GRANT_KEY`, `FEISHU_APP_ID`,
`FEISHU_APP_SECRET`, `FEISHU_SHARED_FOLDER_TOKEN`,
`FEISHU_CONNECTOR_ACCESS_TOKEN`, `INTAKE_AGENT_ACCESS_TOKEN`,
`FEISHU_PROVIDER_ACCESS_TOKEN`, `AGENTLY_MODEL_API_KEY`,
`FEISHU_EXTERNAL_TENANT_ID`, and `FEISHU_BOT_OPEN_ID`.

- [ ] **Step 1: Write failing supervisor tests**

Use fake child commands and health endpoints. Assert deterministic start order,
prefixed logs without environment values, timeout cleanup, nonzero child
failure propagation, SIGINT/SIGTERM reverse shutdown and status output for all
three processes.

- [ ] **Step 2: Run test and verify RED**

```bash
npx vitest run tools/local-feishu-stack.test.ts
```

- [ ] **Step 3: Implement local bundle and commands**

The supervisor reads the explicit env file without printing it, sets the same
bundle path plus per-process application IDs, starts service, provisions after
HTTP readiness, then starts Provider and Agent. `status` uses public health,
Endpoint/Citizen queries and local PID state; it does not infer readiness from
process existence alone.

- [ ] **Step 4: Document exact operation**

Document folder preparation, App permissions, secret rotation, env-file
fields, provisioning, startup, status, test message and shutdown. State that
Console is optional and not an execution dependency.

- [ ] **Step 5: Run focused regressions and commit**

```bash
npx vitest run tools/local-feishu-stack.test.ts packages/service-node/test/main-lifecycle.integration.test.ts
npm run typecheck
git add examples/config/local-feishu-assistant.bundle.yaml tools/local-feishu-stack.ts tools/local-feishu-status.ts tools/local-feishu-provision.ts tools/local-feishu-stack.test.ts package.json README.md docs/guides
git commit -m "feat(local): run the Feishu assistant stack"
```

---

### Task 8: Prove the complete public boundary and perform live startup

**Files:**
- Create: `examples/feishu-capability-provider/test/local-stack.e2e.test.ts`
- Modify: `packages/service-node/test/feishu-capability-provider.e2e.test.ts`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces the release acceptance gate and local live-run evidence.

- [ ] **Step 1: Write the failing end-to-end acceptance test**

Use SQLite, real service HTTP/SSE, real SDK, bundle views, real Agent Host
capability disclosure, Provider Host/Citizens and fake Feishu/OpenAI boundaries.
One Feishu-shaped admitted message must create exactly one document in the
configured folder and produce exactly one Agent-authored result. Restart the
Agent/Provider after invocation persistence and prove no duplicate document.

- [ ] **Step 2: Run test and verify RED**

```bash
npx vitest run examples/feishu-capability-provider/test/local-stack.e2e.test.ts --testTimeout=30000
```

- [ ] **Step 3: Complete only defects exposed by the acceptance test**

Keep fixes within the owning module. Do not introduce a cross-module shortcut
or test-only production behavior.

- [ ] **Step 4: Run full release verification**

```bash
npm run typecheck
npm test -- --testTimeout=30000
npm run conformance
npm run agent-runtime:test-python
npm run check:console-boundaries
npm run check:cluster-boundaries
npm run check:federation-boundaries
npm run check:plugin-boundaries
npm run check:admission-boundaries
npm run check:sensitive-observability
git diff --check
```

- [ ] **Step 5: Provision and start the user's local stack**

Use the user's explicit env file and bundle. If
`FEISHU_SHARED_FOLDER_TOKEN` or rotated credentials are absent, stop with the
exact missing names and do not start a partial Provider. Otherwise run:

```bash
npm run local:feishu:provision
npm run local:feishu:start
npm run local:feishu:status
```

Wait for all readiness checks. Ask the user to send one document-creation
message, observe the original and auxiliary Handoffs, Provider outcome and
single semantic reply, and verify the returned URL is accessible.

- [ ] **Step 6: Update status and commit**

```bash
git add examples/feishu-capability-provider/test/local-stack.e2e.test.ts packages/service-node/test/feishu-capability-provider.e2e.test.ts docs/roadmap.md
git commit -m "test(feishu): prove local document creation stack"
```
