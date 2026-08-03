import { createHash } from "node:crypto";
import { join } from "node:path";

import { AgentlyProcessDriver, type AgentlyProcessDriverObservation } from "@work-fabric/adapter-agent-runtime-agently";
import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import {
  CatalogCapabilityDisclosure,
  CatalogCapabilityResolver,
  HandoffCapabilityInvocationPort,
  JsonSchemaInvocationValidator,
  PollingAuxiliaryHandoffWaiter,
} from "@work-fabric/agent-capability-runtime";
import { AgentGateway } from "@work-fabric/agent-gateway";
import { AgentRuntimeHost, DeterministicAcceptancePolicy, HandoffPackageLoader } from "@work-fabric/agent-runtime-host";
import { CapabilityProviderDriver } from "@work-fabric/capability-provider-runtime";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";
import {
  GitHubCapabilityCitizenRuntime,
  GitHubCapabilityExecutor,
  GitHubCapabilitySchemaRegistry,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  githubReadCapabilityDeclarations,
  type GitHubReadApi,
} from "@work-fabric/provider-github";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type EndpointRegistration,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";
import {
  composeNodeService,
  parseServiceConfig,
  type NodeServiceCompositionOptions,
} from "@work-fabric/service-node";

import { dailyAssistantEndpointRegistration, dailyAssistantGatewayConfig } from "../src/subscription.js";
import { githubProviderEvidenceIdentity } from "../../github-capability-provider/src/composition.js";
import { DailyAssistantDriver } from "../src/daily-assistant-driver.js";
import { LocalInvocationAuthorityProvider } from "../src/local-invocation-authority.js";

export const DAILY_E2E = Object.freeze({
  tenantId: "tenant-daily-e2e",
  exchangeId: "exchange-daily-e2e",
  runtimeToken: "runtime-test-token",
  modelToken: "model-test-token",
  adminToken: "admin-test-token",
  humanToken: "human-test-token",
  runtimeActorId: "actor-intake-agent",
  runtimeEndpointId: "endpoint-intake-agent",
  runtimePrincipalId: "principal-intake-agent",
  subscriptionId: "subscription-intake-agent",
  humanActorId: "actor-human",
  humanEndpointId: "endpoint-human",
  githubToken: "github-provider-test-token",
  githubPrincipalId: "principal-github-provider",
  githubActorId: "actor-github-provider",
  githubEndpointId: "endpoint-github-provider",
  githubSubscriptionId: "subscription-github-provider",
  githubCitizenId: "citizen-github-read",
});

const githubDeclarations = githubReadCapabilityDeclarations();

function githubDescriptor(
  declaration: (typeof githubDeclarations)[number],
): CapabilityDescriptor {
  return {
    capability_id: declaration.declaration_id,
    version: declaration.version,
    name: declaration.name,
    description: declaration.description,
    input_media_types: ["application/json"],
    output_media_types: ["application/json"],
    input_schema_refs:
      declaration.input_schema === undefined ? [] : [declaration.input_schema.uri],
    output_schema_refs:
      declaration.output_schema === undefined ? [] : [declaration.output_schema.uri],
    interaction_modes: ["asynchronous"],
    constraints: {
      selected_citizen_id: DAILY_E2E.githubCitizenId,
      contract_digest: canonicalCitizenDigest(declaration),
    },
    extensions: {},
  };
}

const githubDescriptors = Object.freeze(githubDeclarations.map(githubDescriptor));

type DailyE2eServiceOptions = {
  readonly directory: string;
  readonly runtimeAuthority?: boolean;
  readonly composition?: Omit<NodeServiceCompositionOptions, "ids" | "agent_runtime_authority">;
};

export function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export function e2eClient(
  origin: string,
  token: string,
  actorId: string,
  endpointId: string,
): WorkFabricClient {
  return new WorkFabricClient({
    baseUrl: origin,
    tenantId: DAILY_E2E.tenantId,
    exchangeId: DAILY_E2E.exchangeId,
    representation: { actorId, endpointId },
    authentication: new BearerTokenProvider(token),
    streamReconnect: { baseDelayMs: 10, maxDelayMs: 25, maxReconnects: 8 },
  });
}

export function dailyAssistantOffer(
  target: HandoffOfferPayload["target"] = { actor_id: DAILY_E2E.runtimeActorId },
): HandoffOfferPayload {
  return {
    work_reference: { uri: "urn:work-fabric:e2e:daily-assistant", extensions: {} },
    target,
    intent: [{ kind: "text", media_type: "text/plain", text: "创建一个新需求" }],
    authority_scope: {
      delegation_id: "delegation-daily-e2e", scopes: ["work:read", "result:write"], resource_refs: ["urn:work-fabric:e2e:daily-assistant"],
      expires_at: future(3_600), may_redelegate: false,
    },
    acceptance_criteria: [{ criterion_id: "assistant-response", description: "Returns a structured assistant response", required: true, result_schema_ref: null, required_evidence_types: [] }],
    verifier: { actor_id: DAILY_E2E.humanActorId, actor_type: "human" },
    priority: "normal", accept_by: future(1_800), result_due_at: future(3_600),
  };
}

/**
 * Starts only public Work Fabric surfaces.  Runtime-specific authority is a
 * deliberate composition choice, allowing E2E tests to prove default denial.
 */
export async function startDailyAssistantWorkFabric(options: DailyE2eServiceOptions) {
  let handoffSequence = 0;
  let otherSequence = 0;
  const ids = ["handoff-daily-1", "handoff-daily-2", "handoff-daily-3", "handoff-daily-4", "handoff-daily-5", "handoff-daily-6"];
  const identities = [
    { authentication_evidence: { bearer_token: DAILY_E2E.adminToken }, principal: { principal_id: "principal-admin", tenant_id: DAILY_E2E.tenantId, actor_claims: [{ actor_id: "actor-work-fabric-admin", actor_type: "system" as const, endpoint_ids: ["endpoint-work-fabric-admin"] }], attributes: {} } },
    { authentication_evidence: { bearer_token: DAILY_E2E.humanToken }, principal: { principal_id: "principal-human", tenant_id: DAILY_E2E.tenantId, actor_claims: [{ actor_id: DAILY_E2E.humanActorId, actor_type: "human" as const, endpoint_ids: [DAILY_E2E.humanEndpointId] }], attributes: {} } },
    { authentication_evidence: { bearer_token: DAILY_E2E.runtimeToken }, principal: { principal_id: DAILY_E2E.runtimePrincipalId, tenant_id: DAILY_E2E.tenantId, actor_claims: [{ actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent" as const, endpoint_ids: [DAILY_E2E.runtimeEndpointId] }], attributes: {} } },
    { authentication_evidence: { bearer_token: DAILY_E2E.githubToken }, principal: { principal_id: DAILY_E2E.githubPrincipalId, tenant_id: DAILY_E2E.tenantId, actor_claims: [{ actor_id: DAILY_E2E.githubActorId, actor_type: "system" as const, endpoint_ids: [DAILY_E2E.githubEndpointId] }], attributes: {} } },
  ];
  const humanRules = ids.flatMap((resource_id) => [
    { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-human", actor_id: DAILY_E2E.humanActorId, actor_type: "human" as const, endpoint_id: DAILY_E2E.humanEndpointId, action: "workfabric.query.handoff.read.v1", resource_id },
    { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-human", actor_id: DAILY_E2E.humanActorId, actor_type: "human" as const, endpoint_id: DAILY_E2E.humanEndpointId, action: "workfabric.handoff.cancel.v1", resource_id },
  ]);
  const service = await composeNodeService(parseServiceConfig({
    storage_profile: "sqlite-local", role: "all", development_mode: true, tenant_id: DAILY_E2E.tenantId, exchange_id: DAILY_E2E.exchangeId,
    cursor_secret: "c".repeat(32), sqlite: { location: join(options.directory, "work-fabric.db"), busy_timeout_ms: 5_000 },
    admission: { subject_fingerprint_key: "f".repeat(32), grant_active_key_id: "primary", grant_keys: { primary: "g".repeat(32) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 100 },
    identities,
    authority_rules: [
      { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-admin", actor_id: "actor-work-fabric-admin", actor_type: "system", endpoint_id: "endpoint-work-fabric-admin", action: "workfabric.endpoint.provision.v1", resource_id: DAILY_E2E.runtimeEndpointId },
      { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-admin", actor_id: "actor-work-fabric-admin", actor_type: "system", endpoint_id: "endpoint-work-fabric-admin", action: "workfabric.endpoint.provision.v1", resource_id: DAILY_E2E.githubEndpointId },
      { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-admin", actor_id: "actor-work-fabric-admin", actor_type: "system", endpoint_id: "endpoint-work-fabric-admin", action: "workfabric.citizen.provision.v1", resource_id: DAILY_E2E.githubCitizenId },
      ...[
        "workfabric.citizen.session.open.v1",
        "workfabric.citizen.session.heartbeat.v1",
        "workfabric.citizen.session.declarations.replace.v1",
        "workfabric.citizen.session.close.v1",
      ].map((action) => ({ tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.githubPrincipalId, actor_id: DAILY_E2E.githubActorId, actor_type: "system" as const, endpoint_id: DAILY_E2E.githubEndpointId, action, resource_id: DAILY_E2E.githubCitizenId })),
      { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent", endpoint_id: DAILY_E2E.runtimeEndpointId, action: "workfabric.handoff.offer.v1", resource_id: null },
      { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent", endpoint_id: DAILY_E2E.runtimeEndpointId, action: "workfabric.citizen.discover.v1", resource_id: null },
      { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent", endpoint_id: DAILY_E2E.runtimeEndpointId, action: "workfabric.citizen.declaration-summary.read.v1", resource_id: DAILY_E2E.githubCitizenId },
      ...githubDeclarations.map((declaration) => ({ tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent" as const, endpoint_id: DAILY_E2E.runtimeEndpointId, action: "workfabric.citizen.declaration.read.v1", resource_id: `${DAILY_E2E.githubCitizenId}/${declaration.declaration_id}` })),
      { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-human", actor_id: DAILY_E2E.humanActorId, actor_type: "human", endpoint_id: DAILY_E2E.humanEndpointId, action: "workfabric.handoff.offer.v1", resource_id: null },
      ...humanRules,
    ],
    listen: { host: "127.0.0.1", port: 0 },
  }), {
    ...options.composition,
    ids: { nextId(kind) { return kind === "handoff" ? `handoff-daily-${++handoffSequence}` : `${kind}-daily-${++otherSequence}`; } },
    ...(options.runtimeAuthority === false ? {} : {
      agent_runtime_authority: { grants: {
        "daily-assistant": { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, subscription_id: DAILY_E2E.subscriptionId },
        "github-provider": { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.githubPrincipalId, actor_id: DAILY_E2E.githubActorId, actor_type: "system", endpoint_id: DAILY_E2E.githubEndpointId, subscription_id: DAILY_E2E.githubSubscriptionId },
      } },
    }),
  });
  const { origin } = await service.listen();
  await service.start();
  return {
    service,
    origin,
    human: e2eClient(origin, DAILY_E2E.humanToken, DAILY_E2E.humanActorId, DAILY_E2E.humanEndpointId),
    runtime: e2eClient(origin, DAILY_E2E.runtimeToken, DAILY_E2E.runtimeActorId, DAILY_E2E.runtimeEndpointId),
  };
}

export async function provisionDailyAssistant(origin: string): Promise<void> {
  await e2eClient(origin, DAILY_E2E.adminToken, "actor-work-fabric-admin", "endpoint-work-fabric-admin")
    .endpoints.provision(DAILY_E2E.runtimeEndpointId, dailyAssistantEndpointRegistration());
}

export async function provisionGitHubReadProvider(origin: string): Promise<void> {
  const admin = e2eClient(
    origin,
    DAILY_E2E.adminToken,
    "actor-work-fabric-admin",
    "endpoint-work-fabric-admin",
  );
  const registration: EndpointRegistration = {
    endpoint_id: DAILY_E2E.githubEndpointId,
    actor: { actor_id: DAILY_E2E.githubActorId, actor_type: "system" },
    endpoint_type: "workfabric.dev/capability_provider",
    display_name: "GitHub Read Provider",
    protocol_versions: ["1.0"],
    bindings: [{
      binding_type: "http_sse",
      uri: "urn:work-fabric:e2e:github-provider",
      security_schemes: ["bearer"],
      extensions: {},
    }],
    allowed_capability_ids: githubDescriptors.map((item) => item.capability_id),
    limits: { max_inline_content_bytes: 262_144, max_concurrent_handoffs: 1 },
    administrative_state: "enabled",
    registration_version: 1,
  };
  await admin.endpoints.provision(DAILY_E2E.githubEndpointId, registration);
  await admin.citizens.provision(DAILY_E2E.githubCitizenId, {
    citizen_id: DAILY_E2E.githubCitizenId,
    citizen_kind: "capability-provider",
    principal_id: DAILY_E2E.githubPrincipalId,
    allowed_actor: { actor_id: DAILY_E2E.githubActorId, actor_type: "system" },
    allowed_endpoint_id: DAILY_E2E.githubEndpointId,
    allowed_declaration_namespaces: ["github"],
    maximum_risk: "destructive",
    administrative_state: "enabled",
    registration_version: 1,
  });
}

export async function startGitHubReadProviderFixture(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly api: GitHubReadApi;
}) {
  const fabric = e2eClient(
    input.baseUrl,
    DAILY_E2E.githubToken,
    DAILY_E2E.githubActorId,
    DAILY_E2E.githubEndpointId,
  );
  const evidenceIdentity = githubProviderEvidenceIdentity("88888", Buffer.alloc(32, 8));
  const query = new GitHubQueryService({
    api: input.api,
    policy: new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [{ owner: "AgentEra", name: "work-fabric" }],
      maximum_page_size: 30,
      maximum_aggregate_repositories: 10,
    }),
    cursor: new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 8) }),
    api_version: evidenceIdentity.api_version,
    now: () => new Date().toISOString(),
  });
  const executor = new GitHubCapabilityExecutor({
    query_service: query,
    installation_id_hash: evidenceIdentity.installation_id_hash,
    now: () => new Date().toISOString(),
  });
  const shutdown = new AbortController();
  const citizen = new GitHubCapabilityCitizenRuntime({
    citizen_id: DAILY_E2E.githubCitizenId,
    client_session_id: "github-citizen-debug-e2e",
    expected_registration_version: 1,
    principal_id: DAILY_E2E.githubPrincipalId,
    actor_id: DAILY_E2E.githubActorId,
    endpoint_id: DAILY_E2E.githubEndpointId,
    executor,
  });
  await citizen.start({
    tenant_id: DAILY_E2E.tenantId,
    client: fabric.citizens,
    clock: {
      now: () => new Date().toISOString(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    requested_lease_seconds: 300,
    heartbeat_safety_margin_ms: 5_000,
    signal: shutdown.signal,
  });
  const now = new Date().toISOString();
  const gateway = new AgentGateway(fabric, {
    endpoint_id: DAILY_E2E.githubEndpointId,
    subscription: {
      subscription_id: DAILY_E2E.githubSubscriptionId,
      owner: { actor_id: DAILY_E2E.githubActorId, actor_type: "system" },
      endpoint_id: DAILY_E2E.githubEndpointId,
      filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
      delivery: { mode: "sse" },
      state: "active",
      cursor: null,
      created_at: now,
      updated_at: now,
    },
    open_session: {
      client_session_id: "github-provider-debug-e2e",
      protocol_version: "1.0",
      capabilities: githubDescriptors,
      availability: "available",
      requested_lease_seconds: 300,
      expected_registration_version: 1,
    },
    inbox_refresh_ms: 20,
    max_active_partitions: 8,
    incoming_queue_capacity: 8,
    heartbeat_retry_count: 2,
    heartbeat_backoff_ms: 10,
    graceful_close_timeout_ms: 5_000,
  });
  const state = new SqliteAgentRuntimeStateStore({
    location: join(input.directory, "github-provider-runtime.db"),
    busy_timeout_ms: 5_000,
  });
  const host = new AgentRuntimeHost({
    config: { runtime_id: "github-provider-debug-e2e", tenant_id: DAILY_E2E.tenantId, actor_id: DAILY_E2E.githubActorId, actor_type: "system", endpoint_id: DAILY_E2E.githubEndpointId, max_active_runs: 1, queue_capacity: 8, run_lease_seconds: 60, progress_interval_ms: 1_000, workspace_root: join(input.directory, "github-provider-workspaces") },
    startSession: () => gateway.start({ signal: shutdown.signal }),
    state,
    driver: new CapabilityProviderDriver({
      citizen_id: DAILY_E2E.githubCitizenId,
      endpoint_id: DAILY_E2E.githubEndpointId,
      capabilities: githubDescriptors.map((item) => item.capability_id),
      executor,
    }),
    packageLoader: new HandoffPackageLoader(fabric.queries, DAILY_E2E.tenantId, {
      role_id: "github-provider",
      version: 1,
      display_name: "GitHub Provider",
      description: "Typed read-only GitHub capabilities",
      capability_ids: githubDescriptors.map((item) => item.capability_id),
    }),
    policy: new DeterministicAcceptancePolicy({
      actor_id: DAILY_E2E.githubActorId,
      endpoint_id: DAILY_E2E.githubEndpointId,
      allowed_capability_ids: githubDescriptors.map((item) => item.capability_id),
    }),
    queries: fabric.queries,
  });
  await host.start();
  return {
    async close() {
      await host.close().catch(() => undefined);
      shutdown.abort();
      await citizen.close().catch(() => undefined);
    },
  };
}

export async function startRealAgentlyRuntime(input: {
  readonly baseUrl: string;
  readonly modelBaseUrl: string;
  readonly directory: string;
  readonly timeoutSeconds?: number;
  readonly capabilityNamespaces?: readonly string[];
  /** Test-only bounded process observation; never configured by production YAML. */
  readonly onWorkerObservation?: (observation: AgentlyProcessDriverObservation) => void;
}) {
  const statePath = join(input.directory, "runtime-state.db");
  const workspaceRoot = join(input.directory, "workspaces");
  const state = new SqliteAgentRuntimeStateStore({ location: statePath, busy_timeout_ms: 5_000 });
  const driver = new AgentlyProcessDriver({
    python: { executable: join(process.cwd(), "runtimes/agently-worker/.venv/bin/python"), module: "work_fabric_agently_runtime" },
    workspace_root: workspaceRoot, execution_timeout_seconds: input.timeoutSeconds ?? 20, cancellation_grace_seconds: 1,
    provider: { type: "OpenAICompatible", base_url: input.modelBaseUrl, model: "fake-work-fabric-model", api_key: DAILY_E2E.modelToken }, development_mode: true,
  }, input.onWorkerObservation === undefined
    ? {}
    : { observer: input.onWorkerObservation });
  const fabric = e2eClient(input.baseUrl, DAILY_E2E.runtimeToken, DAILY_E2E.runtimeActorId, DAILY_E2E.runtimeEndpointId);
  const gateway = new AgentGateway({ endpoints: fabric.endpoints, subscriptions: fabric.subscriptions, queries: fabric.queries, handoffs: fabric.handoffs }, dailyAssistantGatewayConfig({ actorId: DAILY_E2E.runtimeActorId, endpointId: DAILY_E2E.runtimeEndpointId, subscriptionId: DAILY_E2E.subscriptionId, queueCapacity: 8, maxActivePartitions: 8 }));
  const role = { role_id: "daily-assistant", version: 1, display_name: "Daily Assistant", description: "E2E runtime", capability_ids: ["information.synthesis"] } as const;
  const schemas = new GitHubCapabilitySchemaRegistry();
  const capability = input.capabilityNamespaces === undefined ? {} : {
    turn_driver: new DailyAssistantDriver(driver, state),
    capability_disclosure: new CatalogCapabilityDisclosure(fabric.citizens, schemas),
    capability_invocations: new HandoffCapabilityInvocationPort({
      tenant_id: DAILY_E2E.tenantId,
      owner_id: "daily-e2e-runtime:capability-invocations",
      verifier: { actor_id: DAILY_E2E.runtimeActorId, actor_type: "agent" },
      resolver: new CatalogCapabilityResolver(fabric.citizens),
      schemas: new JsonSchemaInvocationValidator(schemas),
      authority: new LocalInvocationAuthorityProvider({
        tenant_id: DAILY_E2E.tenantId,
        agent_actor_id: DAILY_E2E.runtimeActorId,
        queries: fabric.queries,
        allowed_namespaces: input.capabilityNamespaces,
      }),
      handoffs: {
        offer: (payload, options) => fabric.handoffs.offer(payload, options),
        resolveTarget: (payload, options) => fabric.handoffs.resolveTarget(payload, options),
        getHandoff: (handoffId, options) => fabric.queries.getHandoff(handoffId, options),
      },
      waiter: new PollingAuxiliaryHandoffWaiter({
        queries: fabric.queries,
        poll_interval_ms: 20,
      }),
      state,
    }),
    capability_limits: {
      max_invocations_per_handoff: 4,
      max_query_invocations_per_handoff: 4,
      max_query_result_bytes: 131_072,
      allowed_namespaces: input.capabilityNamespaces,
    },
  };
  const host = new AgentRuntimeHost({
    config: { runtime_id: "daily-e2e-runtime", tenant_id: DAILY_E2E.tenantId, actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, max_active_runs: 1, queue_capacity: 8, run_lease_seconds: 60, progress_interval_ms: 1_000, workspace_root: workspaceRoot },
    startSession: () => gateway.start(), state, driver,
    packageLoader: new HandoffPackageLoader(fabric.queries, DAILY_E2E.tenantId, role), queries: fabric.queries,
    policy: new DeterministicAcceptancePolicy({ actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, allowed_capability_ids: ["information.synthesis"] }),
    ...capability,
  });
  await host.start();
  return { close: () => host.close(), statePath, workspaceRoot };
}

export async function runtimeRun(statePath: string, handoffId: string) {
  const state = new SqliteAgentRuntimeStateStore({ location: statePath, busy_timeout_ms: 5_000 });
  try { return await state.getRun(DAILY_E2E.tenantId, handoffId); } finally { await state.close(); }
}

export function resourceId(result: { readonly resource: unknown }): string {
  const resource = result.resource;
  if (resource === null || typeof resource !== "object" || Array.isArray(resource) || typeof (resource as Record<string, unknown>).resource_id !== "string") throw new Error(`offer did not return a Handoff resource: ${JSON.stringify(result)}`);
  return (resource as { readonly resource_id: string }).resource_id;
}

export function partitionId(handoffId: string): string {
  return `partition:${createHash("sha256").update(JSON.stringify({ root_handoff_id: handoffId, tenant_id: DAILY_E2E.tenantId })).digest("hex")}`;
}
