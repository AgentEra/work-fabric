import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentlyRuntimeDriverFactory, validateAgentlyRuntimeDriverConfig } from "@work-fabric/adapter-agent-runtime-agently";
import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import { AgentGateway, type AgentGatewayConfig } from "@work-fabric/agent-gateway";
import {
  DeterministicAcceptancePolicy,
  HandoffPackageLoader,
  composeAgentRuntimeHost,
  loadAgentRuntimeConfiguration,
  type LoadedAgentRuntimeConfiguration,
} from "@work-fabric/agent-runtime-host";
import type { AgentRuntimeDriver, AgentRuntimeStateStore } from "@work-fabric/agent-runtime-spi";
import { BearerTokenProvider, WorkFabricClient } from "@work-fabric/sdk-typescript";

import { DAILY_ASSISTANT_CAPABILITY_IDS } from "./capabilities.js";
import { dailyAssistantGatewayConfig } from "./subscription.js";

export interface RuntimeComposition {
  readonly runtimeId: string;
  readonly role: LoadedAgentRuntimeConfiguration["role"];
  readonly gatewayConfig: AgentGatewayConfig;
  readonly host: ReturnType<typeof composeAgentRuntimeHost>;
}

export async function composeAgentRuntime(
  loaded: LoadedAgentRuntimeConfiguration,
  dependencies: {
    readonly fetch?: typeof globalThis.fetch;
    readonly driver: AgentRuntimeDriver;
    readonly state: AgentRuntimeStateStore;
  },
): Promise<RuntimeComposition> {
  const client = new WorkFabricClient({
    baseUrl: loaded.service.work_fabric.base_url,
    tenantId: loaded.service.work_fabric.tenant_id,
    exchangeId: loaded.service.work_fabric.exchange_id,
    representation: { actorId: loaded.participant.actor_id, endpointId: loaded.participant.endpoint_id },
    authentication: new BearerTokenProvider(loaded.service.work_fabric.access_token),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const gatewayConfig = dailyAssistantGatewayConfig({
    actorId: loaded.participant.actor_id, endpointId: loaded.participant.endpoint_id,
    subscriptionId: loaded.service.work_fabric.subscription_id, queueCapacity: loaded.service.concurrency.queue_capacity,
  });
  const gateway = new AgentGateway(client, gatewayConfig);
  const host = composeAgentRuntimeHost({
    config: {
      runtime_id: loaded.service.runtime_id, tenant_id: loaded.service.work_fabric.tenant_id,
      actor_id: loaded.participant.actor_id, endpoint_id: loaded.participant.endpoint_id,
      max_active_runs: loaded.service.concurrency.max_active_runs, queue_capacity: loaded.service.concurrency.queue_capacity,
      run_lease_seconds: 60, progress_interval_ms: 1_000, workspace_root: loaded.driver.config.workspace_root,
    },
    startSession: () => gateway.start(), state: dependencies.state, driver: dependencies.driver,
    packageLoader: new HandoffPackageLoader(client.queries, loaded.service.work_fabric.tenant_id, loaded.role),
    queries: client.queries,
    policy: new DeterministicAcceptancePolicy({
      actor_id: loaded.participant.actor_id, endpoint_id: loaded.participant.endpoint_id,
      allowed_capability_ids: DAILY_ASSISTANT_CAPABILITY_IDS,
    }),
  });
  return Object.freeze({ runtimeId: loaded.service.runtime_id, role: loaded.role, gatewayConfig, host });
}

export function createRuntimeStateStore(
  state: LoadedAgentRuntimeConfiguration["service"]["state"],
): AgentRuntimeStateStore {
  return new SqliteAgentRuntimeStateStore({ location: state.location, busy_timeout_ms: state.busy_timeout_ms });
}

/** The composition owns this root, so it never accepts a symlink or a writable shared directory. */
export async function ensureTrustedWorkspaceRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError("workspace_root must be a non-symlink directory owned by this Runtime");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new TypeError("workspace_root must not be group or world writable");
  }
}

export async function startAgentRuntime(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<RuntimeComposition> {
  const loaded = await loadAgentRuntimeConfiguration({ environment });
  await ensureTrustedWorkspaceRoot(loaded.driver.config.workspace_root);
  const driverConfig = validateAgentlyRuntimeDriverConfig(loaded.driver.config, "plugins.instances.agently-primary.config", { config_directory: process.cwd() });
  const driver = await new AgentlyRuntimeDriverFactory().create(driverConfig);
  const composition = await composeAgentRuntime(
    { ...loaded, driver: { ...loaded.driver, config: driverConfig } },
    { driver, state: createRuntimeStateStore(loaded.service.state) },
  );
  await composition.host.start();
  return composition;
}

async function executable(): Promise<void> {
  const composition = await startAgentRuntime();
  const { runtimeId, role, gatewayConfig } = composition;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= composition.host.close().finally(() => process.exitCode = 0);
    return closing;
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  console.log(`Runtime ready: ${runtimeId}; role=${role.role_id}; actor=${gatewayConfig.subscription.owner.actor_id}; endpoint=${gatewayConfig.endpoint_id}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void executable().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Runtime startup failed");
    process.exitCode = 1;
  });
}
