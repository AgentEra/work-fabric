import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { AgentlyRuntimeDriverFactory, validateAgentlyRuntimeDriverConfig } from "@work-fabric/adapter-agent-runtime-agently";
import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import {
  CatalogCapabilityResolver,
  CatalogCapabilityDisclosure,
  HandoffCapabilityInvocationPort,
  JsonSchemaInvocationValidator,
  PollingAuxiliaryHandoffWaiter,
  type AuxiliaryHandoffWaiter,
  type InvocationAuthorityProvider,
  type InvocationSchemaValidator,
} from "@work-fabric/agent-capability-runtime";
import { AgentGateway, type AgentGatewayConfig } from "@work-fabric/agent-gateway";
import {
  DeterministicAcceptancePolicy,
  HandoffPackageLoader,
  composeAgentRuntimeHost,
  loadAgentRuntimeConfiguration,
  type LoadedAgentRuntimeConfiguration,
} from "@work-fabric/agent-runtime-host";
import {
  isCapabilityAwareAgentRuntimeDriver,
  type AgentCapabilityInvocationStore,
  type AgentRuntimeDriver,
  type AgentRuntimeStateStore,
} from "@work-fabric/agent-runtime-spi";
import { FeishuCapabilitySchemaRegistry } from "@work-fabric/provider-feishu";
import { BearerTokenProvider, WorkFabricClient } from "@work-fabric/sdk-typescript";

import { LocalInvocationAuthorityProvider } from "./local-invocation-authority.js";
import { dailyAssistantGatewayConfig } from "./subscription.js";

export interface RuntimeComposition {
  readonly runtimeId: string;
  readonly role: LoadedAgentRuntimeConfiguration["role"];
  readonly acceptanceCapabilityIds: readonly string[];
  readonly gatewayConfig: AgentGatewayConfig;
  readonly host: ReturnType<typeof composeAgentRuntimeHost>;
}

export async function composeAgentRuntime(
  loaded: LoadedAgentRuntimeConfiguration,
  dependencies: {
    readonly fetch?: typeof globalThis.fetch;
    readonly driver: AgentRuntimeDriver;
    readonly state: AgentRuntimeStateStore & AgentCapabilityInvocationStore;
    readonly capability?: {
      readonly authority: InvocationAuthorityProvider;
      readonly schemas: InvocationSchemaValidator;
      readonly waiter: AuxiliaryHandoffWaiter;
    };
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
  let capabilityHostDependencies = {};
  if (loaded.service.capability_invocation.enabled) {
    if (
      !isCapabilityAwareAgentRuntimeDriver(dependencies.driver)
    ) {
      throw new TypeError(
        "A capability-aware Driver is required",
      );
    }
    const schemaRegistry = new FeishuCapabilitySchemaRegistry();
    const capability = dependencies.capability ?? {
      authority: new LocalInvocationAuthorityProvider({
        tenant_id: loaded.service.work_fabric.tenant_id,
        agent_actor_id: loaded.participant.actor_id,
        queries: client.queries,
        allowed_namespaces:
          loaded.service.capability_invocation.allowed_namespaces,
      }),
      schemas: new JsonSchemaInvocationValidator(
        schemaRegistry,
      ),
      waiter: new PollingAuxiliaryHandoffWaiter({
        queries: client.queries,
      }),
    };
    const invocations = new HandoffCapabilityInvocationPort({
      tenant_id: loaded.service.work_fabric.tenant_id,
      owner_id: `${loaded.service.runtime_id}:capability-invocations`,
      verifier: {
        actor_id: loaded.participant.actor_id,
        actor_type: "agent",
      },
      resolver: new CatalogCapabilityResolver(client.citizens),
      schemas: capability.schemas,
      authority: capability.authority,
      handoffs: {
        offer: (payload, options) => client.handoffs.offer(payload, options),
        resolveTarget: (payload, options) =>
          client.handoffs.resolveTarget(payload, options),
        getHandoff: (handoffId, options) =>
          client.queries.getHandoff(handoffId, options),
      },
      waiter: capability.waiter,
      state: dependencies.state,
    });
    capabilityHostDependencies = {
      turn_driver: dependencies.driver,
      capability_disclosure: new CatalogCapabilityDisclosure(
        client.citizens,
        schemaRegistry,
      ),
      capability_invocations: invocations,
      capability_limits: {
        max_invocations_per_handoff:
          loaded.service.capability_invocation.max_invocations_per_handoff,
        allowed_namespaces:
          loaded.service.capability_invocation.allowed_namespaces,
      },
    };
  }
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
      allowed_capability_ids: loaded.service.acceptance.allowed_capability_ids,
    }),
    ...capabilityHostDependencies,
  });
  return Object.freeze({
    runtimeId: loaded.service.runtime_id, role: loaded.role,
    acceptanceCapabilityIds: loaded.service.acceptance.allowed_capability_ids,
    gatewayConfig, host,
  });
}

export function createRuntimeStateStore(
  state: LoadedAgentRuntimeConfiguration["service"]["state"],
): AgentRuntimeStateStore & AgentCapabilityInvocationStore {
  return new SqliteAgentRuntimeStateStore({ location: state.location, busy_timeout_ms: state.busy_timeout_ms });
}

/**
 * System ancestors are checked only for symlinks and directory type. The
 * trusted boundary and every descendant through the workspace root are
 * Runtime-owned: current UID and mode 0700 (or stricter) are required.
 */
export async function ensureTrustedWorkspaceRoot(root: string, trustedBoundary: string): Promise<void> {
  const resolved = resolve(root);
  const boundary = resolve(trustedBoundary);
  const suffix = relative(boundary, resolved);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new TypeError("workspace_root must be inside the trusted Runtime boundary");
  }
  const parsed = parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("workspace_root must not contain a symlink or non-directory component");
    }
    const boundarySuffix = relative(boundary, current);
    const isRuntimeOwned = boundarySuffix === ""
      || (!isAbsolute(boundarySuffix)
        && boundarySuffix !== ".."
        && !boundarySuffix.startsWith(`..${sep}`));
    if (!isRuntimeOwned) continue;
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new TypeError("workspace_root trusted components must be owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new TypeError("workspace_root trusted components must have private permissions");
    }
  }
}

export async function startComposedRuntime(composition: RuntimeComposition): Promise<RuntimeComposition> {
  try {
    await composition.host.start();
    return composition;
  } catch (error) {
    await composition.host.close();
    throw error;
  }
}

export async function startAgentRuntime(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<RuntimeComposition> {
  const loaded = await loadAgentRuntimeConfiguration({ environment });
  const trustedBoundary = dirname(resolve(loaded.service.state.location));
  await ensureTrustedWorkspaceRoot(loaded.driver.config.workspace_root, trustedBoundary);
  const driverConfig = validateAgentlyRuntimeDriverConfig(loaded.driver.config, "plugins.instances.agently-primary.config", { config_directory: process.cwd() });
  const driver = await new AgentlyRuntimeDriverFactory().create(driverConfig);
  const state = createRuntimeStateStore(loaded.service.state);
  let composed = false;
  try {
    const composition = await composeAgentRuntime(
      { ...loaded, driver: { ...loaded.driver, config: driverConfig } },
      { driver, state },
    );
    composed = true;
    return await startComposedRuntime(composition);
  } catch (error) {
    if (!composed) await state.close();
    throw error;
  }
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
