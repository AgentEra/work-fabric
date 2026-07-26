import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentlyProcessDriver } from "@work-fabric/adapter-agent-runtime-agently";
import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import { AgentGateway } from "@work-fabric/agent-gateway";
import { AgentRuntimeHost, DeterministicAcceptancePolicy, HandoffPackageLoader } from "@work-fabric/agent-runtime-host";
import { BearerTokenProvider, WorkFabricClient, type HandoffOfferPayload } from "@work-fabric/sdk-typescript";
import { composeNodeService, parseServiceConfig } from "@work-fabric/service-node";
import { describe, expect, it } from "vitest";

import { dailyAssistantEndpointRegistration, dailyAssistantGatewayConfig } from "../../../examples/agently-agent-runtime/src/subscription.js";
import { startFakeOpenAiCompatibleServer } from "./fake-openai-compatible-server.js";

const tenantId = "tenant-daily-e2e";
const exchangeId = "exchange-daily-e2e";
const runtimeToken = "runtime-test-token";
const modelToken = "model-test-token";

function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function client(origin: string, token: string, actorId: string, endpointId: string): WorkFabricClient {
  return new WorkFabricClient({
    baseUrl: origin,
    tenantId,
    exchangeId,
    representation: { actorId, endpointId },
    authentication: new BearerTokenProvider(token),
    streamReconnect: { baseDelayMs: 10, maxDelayMs: 25, maxReconnects: 8 },
  });
}

function dailyAssistantOffer(target: HandoffOfferPayload["target"] = { actor_id: "actor-intake-agent" }): HandoffOfferPayload {
  return {
    work_reference: { uri: "urn:work-fabric:e2e:daily-assistant", extensions: {} },
    target,
    intent: [{ kind: "text", media_type: "text/plain", text: "创建一个新需求" }],
    authority_scope: {
      delegation_id: "delegation-daily-e2e", scopes: ["work:read", "result:write"], resource_refs: ["urn:work-fabric:e2e:daily-assistant"],
      expires_at: future(3_600), may_redelegate: false,
    },
    acceptance_criteria: [{ criterion_id: "assistant-response", description: "Returns a structured assistant response", required: true, result_schema_ref: null, required_evidence_types: [] }],
    verifier: { actor_id: "actor-human", actor_type: "human" },
    priority: "normal", accept_by: future(1_800), result_due_at: future(3_600),
  };
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await assertion(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw last;
}

async function startSqliteWorkFabric(directory: string) {
  let handoffSequence = 0;
  let otherSequence = 0;
  const identities = [
    { authentication_evidence: { bearer_token: "admin-test-token" }, principal: { principal_id: "principal-admin", tenant_id: tenantId, actor_claims: [{ actor_id: "actor-work-fabric-admin", actor_type: "system" as const, endpoint_ids: ["endpoint-work-fabric-admin"] }], attributes: {} } },
    { authentication_evidence: { bearer_token: "human-test-token" }, principal: { principal_id: "principal-human", tenant_id: tenantId, actor_claims: [{ actor_id: "actor-human", actor_type: "human" as const, endpoint_ids: ["endpoint-human"] }], attributes: {} } },
    { authentication_evidence: { bearer_token: runtimeToken }, principal: { principal_id: "principal-intake-agent", tenant_id: tenantId, actor_claims: [{ actor_id: "actor-intake-agent", actor_type: "agent" as const, endpoint_ids: ["endpoint-intake-agent"] }], attributes: {} } },
  ];
  const service = await composeNodeService(parseServiceConfig({
    storage_profile: "sqlite-local", role: "all", development_mode: true, tenant_id: tenantId, exchange_id: exchangeId,
    cursor_secret: "c".repeat(32), sqlite: { location: join(directory, "work-fabric.db"), busy_timeout_ms: 5_000 },
    admission: { subject_fingerprint_key: "f".repeat(32), grant_active_key_id: "primary", grant_keys: { primary: "g".repeat(32) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 100 },
    identities,
    authority_rules: [
      { tenant_id: tenantId, principal_id: "principal-admin", actor_id: "actor-work-fabric-admin", actor_type: "system", endpoint_id: "endpoint-work-fabric-admin", action: "workfabric.endpoint.provision.v1", resource_id: "endpoint-intake-agent" },
      { tenant_id: tenantId, principal_id: "principal-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human", action: "workfabric.handoff.offer.v1", resource_id: null },
      { tenant_id: tenantId, principal_id: "principal-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human", action: "workfabric.query.handoff.read.v1", resource_id: "handoff-daily-1" },
      { tenant_id: tenantId, principal_id: "principal-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human", action: "workfabric.query.handoff.read.v1", resource_id: "handoff-daily-2" },
      { tenant_id: tenantId, principal_id: "principal-intake-agent", actor_id: "actor-intake-agent", actor_type: "agent", endpoint_id: "endpoint-intake-agent", action: "workfabric.subscription.pull.v1", resource_id: "subscription-intake-agent" },
    ],
    listen: { host: "127.0.0.1", port: 0 },
  }), {
    ids: {
      nextId(kind) {
        if (kind === "handoff") return `handoff-daily-${++handoffSequence}`;
        return `${kind}-daily-${++otherSequence}`;
      },
    },
    agent_runtime_authority: { grants: { "daily-assistant": { tenant_id: tenantId, principal_id: "principal-intake-agent", actor_id: "actor-intake-agent", endpoint_id: "endpoint-intake-agent", subscription_id: "subscription-intake-agent" } } },
  });
  const { origin } = await service.listen();
  await service.start();
  return { service, origin, human: client(origin, "human-test-token", "actor-human", "endpoint-human") };
}

async function provisionDailyAssistant(origin: string): Promise<void> {
  await client(origin, "admin-test-token", "actor-work-fabric-admin", "endpoint-work-fabric-admin")
    .endpoints.provision("endpoint-intake-agent", dailyAssistantEndpointRegistration());
}

async function startRealAgentlyRuntime(input: { baseUrl: string; modelBaseUrl: string; directory: string; timeoutSeconds?: number }) {
  const statePath = join(input.directory, "runtime-state.db");
  const workspaceRoot = join(input.directory, "workspaces");
  const state = new SqliteAgentRuntimeStateStore({ location: statePath, busy_timeout_ms: 5_000 });
  const driverConfiguration = {
    python: { executable: join(process.cwd(), "runtimes/agently-worker/.venv/bin/python"), module: "work_fabric_agently_runtime" },
    workspace_root: workspaceRoot, execution_timeout_seconds: input.timeoutSeconds ?? 20, cancellation_grace_seconds: 1,
    provider: { type: "OpenAICompatible", base_url: input.modelBaseUrl, model: "fake-work-fabric-model", api_key: modelToken }, development_mode: true,
  } as const;
  const driver = new AgentlyProcessDriver(driverConfiguration);
  const fabric = client(input.baseUrl, runtimeToken, "actor-intake-agent", "endpoint-intake-agent");
  const gateway = new AgentGateway({
    endpoints: fabric.endpoints,
    subscriptions: fabric.subscriptions,
    queries: fabric.queries,
    handoffs: fabric.handoffs,
  }, dailyAssistantGatewayConfig({ actorId: "actor-intake-agent", endpointId: "endpoint-intake-agent", subscriptionId: "subscription-intake-agent", queueCapacity: 8 }));
  const role = { role_id: "daily-assistant", version: 1, display_name: "Daily Assistant", description: "E2E runtime", capability_ids: ["information.synthesis"] } as const;
  const host = new AgentRuntimeHost({
    config: { runtime_id: "daily-e2e-runtime", tenant_id: tenantId, actor_id: "actor-intake-agent", endpoint_id: "endpoint-intake-agent", max_active_runs: 1, queue_capacity: 8, run_lease_seconds: 60, progress_interval_ms: 1_000, workspace_root: workspaceRoot },
    startSession: () => gateway.start(), state, driver,
    packageLoader: new HandoffPackageLoader(fabric.queries, tenantId, role), queries: fabric.queries,
    policy: new DeterministicAcceptancePolicy({ actor_id: "actor-intake-agent", endpoint_id: "endpoint-intake-agent", allowed_capability_ids: ["information.synthesis"] }),
  });
  await host.start();
  return { close: () => host.close(), statePath, workspaceRoot };
}

async function runtimeRun(statePath: string, handoffId: string) {
  const state = new SqliteAgentRuntimeStateStore({ location: statePath, busy_timeout_ms: 5_000 });
  try { return await state.getRun(tenantId, handoffId); } finally { await state.close(); }
}

function resourceId(result: { readonly resource: unknown }): string {
  const resource = result.resource;
  if (resource === null || typeof resource !== "object" || Array.isArray(resource) || typeof (resource as Record<string, unknown>).resource_id !== "string") {
    throw new Error(`offer did not return a Handoff resource: ${JSON.stringify(result)}`);
  }
  return (resource as { readonly resource_id: string }).resource_id;
}

function partitionId(handoffId: string): string {
  return `partition:${createHash("sha256").update(JSON.stringify({ root_handoff_id: handoffId, tenant_id: tenantId })).digest("hex")}`;
}

describe("Daily Assistant real boundaries", () => {
  it("completes and recovers the Daily Assistant Handoff through real boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-daily-e2e-"));
    const model = await startFakeOpenAiCompatibleServer({ structuredOutput: {
      request_summary: "创建一个新需求", response: "需求已整理，建议交给需求分析角色确认", missing_information: ["期望上线日期"],
      handoff_draft_required: true, handoff_draft_reason: "需要专业需求分析", handoff_draft_capability: "requirements.analysis",
      handoff_draft_intent: "梳理需求范围并确认验收标准", handoff_draft_acceptance_criteria: ["范围得到业务方确认"],
    } });
    const service = await startSqliteWorkFabric(directory);
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    try {
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory });
      if (runtime === undefined) throw new Error("runtime did not start");
      const firstRuntime = runtime;
      const offered = await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-e2e-offer-1" });
      const handoffId = resourceId(offered);
      expect(await service.human.queries.listHandoffEvents(handoffId)).toHaveLength(1);
      await eventually(async () => expect(
        await client(service.origin, runtimeToken, "actor-intake-agent", "endpoint-intake-agent")
          .endpoints.listInboxPartitions("endpoint-intake-agent"),
      ).toMatchObject({ items: [{ partition_id: partitionId(handoffId) }] }));
      await expect(
        client(service.origin, runtimeToken, "actor-intake-agent", "endpoint-intake-agent")
          .subscriptions.get("subscription-intake-agent"),
      ).resolves.toMatchObject({ endpoint_id: "endpoint-intake-agent", delivery: { mode: "sse" } });
      await expect(
        client(service.origin, runtimeToken, "actor-intake-agent", "endpoint-intake-agent")
          .queries.getHandoff(handoffId),
      ).resolves.toMatchObject({ state: { lifecycle_state: "offered" } });
      await eventually(async () => expect(await runtimeRun(firstRuntime.statePath, handoffId)).not.toBeNull(), 7_000);
      await eventually(async () => expect(model.requests).toHaveLength(1), 7_000);
      await eventually(async () => {
        const handoff = await service.human.queries.getHandoff(handoffId);
        expect(handoff.state.lifecycle_state).toBe("result_returned");
        const result = handoff.state.result;
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("expected Handoff result");
        const extensions = (result as Record<string, unknown>).extensions;
        if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) throw new Error("expected result extensions");
        expect((extensions as Record<string, unknown>)["workfabric.agent/assistant_output"]).toMatchObject({ handoff_draft_required: true });
      });
      await runtime.close();
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory });
      expect(model.requests).toHaveLength(1);
      const second = await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-e2e-offer-2" });
      const secondHandoffId = resourceId(second);
      await eventually(async () => {
        expect((await service.human.queries.getHandoff(secondHandoffId)).state.lifecycle_state).toBe("result_returned");
      });
      expect(model.requests).toHaveLength(2);
      const persisted = await readFile(join(directory, "runtime-state.db"));
      expect(persisted.toString("utf8")).not.toContain(modelToken);
      expect(persisted.toString("utf8")).not.toContain(runtimeToken);
    } finally {
      await runtime?.close().catch(() => undefined);
      await service.service.close();
      await model.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
