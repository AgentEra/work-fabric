import { createHash } from "node:crypto";
import { join } from "node:path";

import { AgentlyProcessDriver } from "@work-fabric/adapter-agent-runtime-agently";
import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import { AgentGateway } from "@work-fabric/agent-gateway";
import { AgentRuntimeHost, DeterministicAcceptancePolicy, HandoffPackageLoader } from "@work-fabric/agent-runtime-host";
import { BearerTokenProvider, WorkFabricClient, type HandoffOfferPayload } from "@work-fabric/sdk-typescript";
import {
  composeNodeService,
  parseServiceConfig,
  type NodeServiceCompositionOptions,
} from "@work-fabric/service-node";

import { dailyAssistantEndpointRegistration, dailyAssistantGatewayConfig } from "../src/subscription.js";

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
});

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
      { tenant_id: DAILY_E2E.tenantId, principal_id: "principal-human", actor_id: DAILY_E2E.humanActorId, actor_type: "human", endpoint_id: DAILY_E2E.humanEndpointId, action: "workfabric.handoff.offer.v1", resource_id: null },
      ...humanRules,
    ],
    listen: { host: "127.0.0.1", port: 0 },
  }), {
    ...options.composition,
    ids: { nextId(kind) { return kind === "handoff" ? `handoff-daily-${++handoffSequence}` : `${kind}-daily-${++otherSequence}`; } },
    ...(options.runtimeAuthority === false ? {} : {
      agent_runtime_authority: { grants: { "daily-assistant": { tenant_id: DAILY_E2E.tenantId, principal_id: DAILY_E2E.runtimePrincipalId, actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, subscription_id: DAILY_E2E.subscriptionId } } },
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

export async function startRealAgentlyRuntime(input: {
  readonly baseUrl: string;
  readonly modelBaseUrl: string;
  readonly directory: string;
  readonly timeoutSeconds?: number;
}) {
  const statePath = join(input.directory, "runtime-state.db");
  const workspaceRoot = join(input.directory, "workspaces");
  const state = new SqliteAgentRuntimeStateStore({ location: statePath, busy_timeout_ms: 5_000 });
  const driver = new AgentlyProcessDriver({
    python: { executable: join(process.cwd(), "runtimes/agently-worker/.venv/bin/python"), module: "work_fabric_agently_runtime" },
    workspace_root: workspaceRoot, execution_timeout_seconds: input.timeoutSeconds ?? 20, cancellation_grace_seconds: 1,
    provider: { type: "OpenAICompatible", base_url: input.modelBaseUrl, model: "fake-work-fabric-model", api_key: DAILY_E2E.modelToken }, development_mode: true,
  });
  const fabric = e2eClient(input.baseUrl, DAILY_E2E.runtimeToken, DAILY_E2E.runtimeActorId, DAILY_E2E.runtimeEndpointId);
  const gateway = new AgentGateway({ endpoints: fabric.endpoints, subscriptions: fabric.subscriptions, queries: fabric.queries, handoffs: fabric.handoffs }, dailyAssistantGatewayConfig({ actorId: DAILY_E2E.runtimeActorId, endpointId: DAILY_E2E.runtimeEndpointId, subscriptionId: DAILY_E2E.subscriptionId, queueCapacity: 8 }));
  const role = { role_id: "daily-assistant", version: 1, display_name: "Daily Assistant", description: "E2E runtime", capability_ids: ["information.synthesis"] } as const;
  const host = new AgentRuntimeHost({
    config: { runtime_id: "daily-e2e-runtime", tenant_id: DAILY_E2E.tenantId, actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, max_active_runs: 1, queue_capacity: 8, run_lease_seconds: 60, progress_interval_ms: 1_000, workspace_root: workspaceRoot },
    startSession: () => gateway.start(), state, driver,
    packageLoader: new HandoffPackageLoader(fabric.queries, DAILY_E2E.tenantId, role), queries: fabric.queries,
    policy: new DeterministicAcceptancePolicy({ actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId, allowed_capability_ids: ["information.synthesis"] }),
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
