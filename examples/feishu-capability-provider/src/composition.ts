import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import { AgentGateway, type AgentGatewayConfig } from "@work-fabric/agent-gateway";
import {
  DeterministicAcceptancePolicy,
  HandoffPackageLoader,
  composeAgentRuntimeHost,
} from "@work-fabric/agent-runtime-host";
import { CapabilityProviderDriver } from "@work-fabric/capability-provider-runtime";
import {
  FeishuOpenApiClient,
  FeishuTenantAccessTokenProvider,
} from "@work-fabric/connector-feishu";
import type {
  CitizenHealth,
  CitizenJsonObject,
  CitizenRuntimeContext,
} from "@work-fabric/network-citizen-spi";
import {
  FeishuCapabilityCitizenRuntime,
  FeishuCapabilityExecutor,
  FeishuCapabilityExecutorPortAdapter,
  FeishuContextCitizenRuntime,
  FeishuDocumentContextProvider,
  FeishuOpenApiCapabilityBackend,
  FeishuSharedFolderPolicyVerifier,
  MemoryFeishuProviderStore,
  SqliteFeishuProviderStore,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
} from "@work-fabric/provider-feishu";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

import {
  loadFeishuProviderConfiguration,
  type LoadedFeishuProviderConfiguration,
} from "./configuration.js";
import { EnvironmentFeishuAppCredentialProvider } from "./credentials.js";

interface LifecycleCitizen {
  start(): Promise<void>;
  health(): Promise<Pick<CitizenHealth, "status">>;
  close(): Promise<void>;
}

interface LifecycleHost {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface FeishuProviderComposition {
  start(): Promise<void>;
  health(): Promise<{
    readonly provider: "ready" | "starting" | "failed";
    readonly capability_citizen: string;
    readonly context_citizen: string;
  }>;
  close(): Promise<void>;
}

export interface ManagedFeishuProviderCompositionDependencies {
  readonly capability_citizen_id: string;
  readonly context_citizen_id: string;
  readonly preflight: () => Promise<void>;
  readonly capability_citizen: LifecycleCitizen;
  readonly context_citizen: LifecycleCitizen;
  readonly host: LifecycleHost;
  readonly close_provider_store: () => Promise<void>;
}

export class ManagedFeishuProviderComposition
  implements FeishuProviderComposition {
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private capabilityStarted = false;
  private contextStarted = false;
  private hostStarted = false;
  private providerStoreClosed = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly dependencies:
      ManagedFeishuProviderCompositionDependencies,
  ) {}

  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "failed" || this.state === "closed") {
      throw new Error("Feishu Provider composition cannot be restarted");
    }
    try {
      await this.dependencies.preflight();
      await this.dependencies.capability_citizen.start();
      this.capabilityStarted = true;
      await this.dependencies.context_citizen.start();
      this.contextStarted = true;
      await this.dependencies.host.start();
      this.hostStarted = true;
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      await this.rollback();
      throw error;
    }
  }

  async health(): ReturnType<FeishuProviderComposition["health"]> {
    if (this.state !== "ready") {
      return {
        provider: this.state === "starting" ? "starting" : "failed",
        capability_citizen: this.dependencies.capability_citizen_id,
        context_citizen: this.dependencies.context_citizen_id,
      };
    }
    const [capability, context] = await Promise.all([
      this.dependencies.capability_citizen.health(),
      this.dependencies.context_citizen.health(),
    ]);
    return {
      provider:
        capability.status === "available" && context.status === "available"
          ? "ready"
          : "failed",
      capability_citizen: this.dependencies.capability_citizen_id,
      context_citizen: this.dependencies.context_citizen_id,
    };
  }

  close(): Promise<void> {
    this.closing ??= this.rollback().finally(() => {
      this.state = "closed";
    });
    return this.closing;
  }

  private async rollback(): Promise<void> {
    if (this.hostStarted) {
      this.hostStarted = false;
      await this.dependencies.host.close().catch(() => undefined);
    }
    // A failed start may have allocated resources before rejecting. Closing
    // both Citizen wrappers is safe and makes startup transactional.
    if (this.contextStarted || this.state === "failed") {
      this.contextStarted = false;
      await this.dependencies.context_citizen.close().catch(() => undefined);
    }
    if (this.capabilityStarted) {
      this.capabilityStarted = false;
      await this.dependencies.capability_citizen.close().catch(() => undefined);
    }
    if (!this.providerStoreClosed) {
      this.providerStoreClosed = true;
      await this.dependencies.close_provider_store().catch(() => undefined);
    }
  }
}

function capabilityDescriptor(
  declaration: ReturnType<typeof feishuCapabilityDeclarations>[number],
  citizenId: string,
): CapabilityDescriptor {
  return {
    capability_id: declaration.declaration_id,
    version: declaration.version,
    name: declaration.name,
    description: declaration.description,
    input_media_types: ["application/json"],
    output_media_types: ["application/json"],
    input_schema_refs:
      declaration.input_schema === undefined
        ? []
        : [declaration.input_schema.uri],
    output_schema_refs:
      declaration.output_schema === undefined
        ? []
        : [declaration.output_schema.uri],
    interaction_modes: ["asynchronous"],
    constraints: { selected_citizen_id: citizenId },
    extensions: {},
  };
}

function gatewayConfiguration(
  loaded: LoadedFeishuProviderConfiguration,
  capabilities: readonly CapabilityDescriptor[],
): AgentGatewayConfig {
  const now = new Date().toISOString();
  const subscription: SubscriptionDocument = {
    subscription_id: loaded.service.work_fabric.subscription_id,
    owner: {
      actor_id: loaded.participant.actor_id,
      actor_type: "agent",
    },
    endpoint_id: loaded.participant.endpoint_id,
    filter: {
      event_types: [],
      actor_ids: [],
      endpoint_ids: [],
      thread_ids: [],
      handoff_ids: [],
      work_reference_uris: [],
      capability_ids: [],
      lifecycle_states: [],
    },
    delivery: { mode: "sse" },
    state: "active",
    cursor: null,
    created_at: now,
    updated_at: now,
  };
  return {
    endpoint_id: loaded.participant.endpoint_id,
    subscription,
    open_session: {
      client_session_id: `feishu-provider-${process.pid}-${randomUUID()}`,
      protocol_version: "1.0",
      capabilities,
      availability: "available",
      requested_lease_seconds:
        loaded.service.citizen_lease.requested_lease_seconds,
      expected_registration_version: 1,
    },
    inbox_refresh_ms: 1_000,
    max_active_partitions: 8,
    incoming_queue_capacity: loaded.service.concurrency.queue_capacity,
    heartbeat_retry_count: 2,
    heartbeat_backoff_ms: 250,
    graceful_close_timeout_ms: 10_000,
  };
}

function runtimeContext(
  loaded: LoadedFeishuProviderConfiguration,
  client: WorkFabricClient,
  signal: AbortSignal,
): CitizenRuntimeContext {
  return {
    tenant_id: loaded.service.work_fabric.tenant_id,
    client: client.citizens,
    clock: {
      now: () => new Date().toISOString(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    requested_lease_seconds:
      loaded.service.citizen_lease.requested_lease_seconds,
    heartbeat_safety_margin_ms:
      loaded.service.citizen_lease.heartbeat_safety_margin_ms,
    signal,
  };
}

function contextRequest(
  provider: FeishuDocumentContextProvider,
  request: CitizenJsonObject,
  signal: AbortSignal,
): Promise<CitizenJsonObject> {
  const authority =
    request.authority !== null &&
    typeof request.authority === "object" &&
    !Array.isArray(request.authority)
      ? request.authority as CitizenJsonObject
      : {};
  const tokens = authority.allowed_document_tokens;
  if (
    typeof request.tenant_id !== "string" ||
    typeof request.document_token !== "string" ||
    !Number.isSafeInteger(request.max_bytes) ||
    !Array.isArray(tokens) ||
    tokens.some((item) => typeof item !== "string")
  ) throw new TypeError("Feishu context request is invalid");
  return provider.read({
    tenant_id: request.tenant_id,
    document_token: request.document_token,
    max_bytes: request.max_bytes as number,
    authority: { allowed_document_tokens: tokens as string[] },
    signal,
  }) as Promise<CitizenJsonObject>;
}

export async function composeFeishuProvider(
  loaded: LoadedFeishuProviderConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<FeishuProviderComposition> {
  for (const location of [
    loaded.service.runtime_state.location,
    loaded.provider.state.type === "sqlite"
      ? loaded.provider.state.location
      : null,
  ]) {
    if (location !== null && location !== ":memory:") {
      await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    }
  }
  const credentialProvider = new EnvironmentFeishuAppCredentialProvider({
    credential_ref: loaded.provider.credential_ref,
    environment,
  });
  const tokenProvider = new FeishuTenantAccessTokenProvider({
    credential_provider: credentialProvider,
    fetch: fetchImplementation,
    base_url: loaded.provider.open_api.base_url,
    clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1_000) },
    expiry_skew_seconds: 60,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
  });
  const messages = new FeishuOpenApiClient({
    token_provider: tokenProvider,
    fetch: fetchImplementation,
    base_url: loaded.provider.open_api.base_url,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
    max_response_bytes: loaded.provider.open_api.max_response_bytes,
  });
  const backend = new FeishuOpenApiCapabilityBackend({
    credential_ref: loaded.provider.credential_ref,
    token_provider: tokenProvider,
    messages,
    fetch: fetchImplementation,
    base_url: loaded.provider.open_api.base_url,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
    max_response_bytes: loaded.provider.open_api.max_response_bytes,
  });
  const providerStore = loaded.provider.state.type === "sqlite"
    ? new SqliteFeishuProviderStore(loaded.provider.state)
    : new MemoryFeishuProviderStore();
  const executorPort = new FeishuCapabilityExecutorPortAdapter(
    new FeishuCapabilityExecutor({
      citizen_id: loaded.provider.capability_citizen.citizen_id,
      endpoint_id: loaded.provider.capability_citizen.endpoint_id,
      backend,
      executions: providerStore,
      ownership: providerStore,
      confirmation: { consume: async () => false },
      targets: {
        resolveCurrentConversation: async () => {
          throw new Error("current conversation context is unavailable");
        },
      },
      shared_folder: {
        token: loaded.provider.shared_folder.token,
        policy_ref: loaded.provider.shared_folder.policy_ref,
      },
    }),
  );
  const documentContext = new FeishuDocumentContextProvider({ backend });
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
  const shutdown = new AbortController();
  const citizenContext = runtimeContext(loaded, client, shutdown.signal);
  const capabilityRuntime = new FeishuCapabilityCitizenRuntime({
    ...loaded.provider.capability_citizen,
    actor_type: "agent",
    client_session_id: `feishu-capability-${process.pid}-${randomUUID()}`,
    expected_registration_version:
      loaded.provider.capability_citizen.registration_version,
    declarations: feishuCapabilityDeclarations,
    execute: (request, context) => executorPort.execute(request, context),
  });
  const contextRuntime = new FeishuContextCitizenRuntime({
    ...loaded.provider.context_citizen,
    actor_type: "agent",
    client_session_id: `feishu-context-${process.pid}-${randomUUID()}`,
    expected_registration_version:
      loaded.provider.context_citizen.registration_version,
    declarations: feishuContextDeclarations,
    resolve: (request, signal) =>
      contextRequest(documentContext, request, signal),
  });
  const capabilities = feishuCapabilityDeclarations().map((declaration) =>
    capabilityDescriptor(
      declaration,
      loaded.provider.capability_citizen.citizen_id,
    ),
  );
  const gateway = new AgentGateway(client, gatewayConfiguration(
    loaded,
    capabilities,
  ));
  const runtimeState = new SqliteAgentRuntimeStateStore({
    location: loaded.service.runtime_state.location,
    busy_timeout_ms: loaded.service.runtime_state.busy_timeout_ms,
  });
  const driver = new CapabilityProviderDriver({
    citizen_id: loaded.provider.capability_citizen.citizen_id,
    endpoint_id: loaded.participant.endpoint_id,
    capabilities: capabilities.map((item) => item.capability_id),
    executor: executorPort,
  });
  const host = composeAgentRuntimeHost({
    config: {
      runtime_id: loaded.service.runtime_id,
      tenant_id: loaded.service.work_fabric.tenant_id,
      actor_id: loaded.participant.actor_id,
      endpoint_id: loaded.participant.endpoint_id,
      max_active_runs: loaded.service.concurrency.max_active_runs,
      queue_capacity: loaded.service.concurrency.queue_capacity,
      run_lease_seconds: 60,
      progress_interval_ms: 1_000,
      workspace_root: dirname(loaded.service.runtime_state.location),
    },
    startSession: () => gateway.start({ signal: shutdown.signal }),
    state: runtimeState,
    driver,
    packageLoader: new HandoffPackageLoader(
      client.queries,
      loaded.service.work_fabric.tenant_id,
      {
        role_id: "feishu-provider",
        version: 1,
        display_name: "Feishu Provider",
        description: "Typed Feishu capabilities",
        capability_ids: capabilities.map((item) => item.capability_id),
      },
    ),
    policy: new DeterministicAcceptancePolicy({
      actor_id: loaded.participant.actor_id,
      endpoint_id: loaded.participant.endpoint_id,
      allowed_capability_ids: capabilities.map((item) => item.capability_id),
    }),
    queries: client.queries,
  });
  const preflight = new FeishuSharedFolderPolicyVerifier({
    credential_ref: loaded.provider.credential_ref,
    token_provider: tokenProvider,
    fetch: fetchImplementation,
    base_url: loaded.provider.open_api.base_url,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
    max_response_bytes: loaded.provider.open_api.max_response_bytes,
    folder_token: loaded.provider.shared_folder.token,
    policy_ref: loaded.provider.shared_folder.policy_ref,
    visibility: loaded.provider.shared_folder.visibility,
  });
  return new ManagedFeishuProviderComposition({
    capability_citizen_id:
      loaded.provider.capability_citizen.citizen_id,
    context_citizen_id: loaded.provider.context_citizen.citizen_id,
    preflight: async () => { await preflight.verify(shutdown.signal); },
    capability_citizen: {
      start: () => capabilityRuntime.start(citizenContext),
      health: () => capabilityRuntime.health(),
      close: () => capabilityRuntime.close(),
    },
    context_citizen: {
      start: () => contextRuntime.start(citizenContext),
      health: () => contextRuntime.health(),
      close: () => contextRuntime.close(),
    },
    host: {
      start: () => host.start(),
      close: async () => {
        shutdown.abort();
        await host.close();
      },
    },
    close_provider_store: async () => {
      if ("close" in providerStore) await providerStore.close();
    },
  });
}

export async function createFeishuProviderComposition(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FeishuProviderComposition> {
  const loaded = await loadFeishuProviderConfiguration({ environment });
  return composeFeishuProvider(loaded, environment);
}
