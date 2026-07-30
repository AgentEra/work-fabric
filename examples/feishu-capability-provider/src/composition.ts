import { randomBytes, randomUUID } from "node:crypto";
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
import type {
  DocumentAccessAuthorizer,
  DocumentPlacementResolver,
} from "@work-fabric/document-provider-spi";
import type {
  ConversationContextMaterializer,
  ConversationContextRequest,
} from "@work-fabric/channel-spi";
import {
  FeishuOpenApiClient,
  FeishuTenantAccessTokenProvider,
} from "@work-fabric/connector-feishu";
import type {
  CitizenDeclaration,
  CitizenHealth,
  CitizenJsonObject,
  CitizenRuntimeContext,
} from "@work-fabric/network-citizen-spi";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";
import {
  enabledFeishuProviderFacets,
  FeishuCapabilityCitizenRuntime,
  FeishuCalendarCapabilityExecutor,
  FeishuCalendarOpenApiBackend,
  FeishuCapabilityExecutor,
  FeishuCapabilityExecutorRouter,
  FeishuCapabilityExecutorPortAdapter,
  FeishuConversationContextProvider,
  FeishuConversationMembersExecutor,
  FeishuContextCitizenRuntime,
  FeishuDocumentContextProvider,
  FeishuMessageQueryExecutor,
  FeishuOpenApiCapabilityBackend,
  FeishuOpenApiConversationMembersClient,
  FeishuOpenApiRequestClient,
  HmacConversationCursorCodec,
  MemoryFeishuProviderStore,
  MemoryFeishuCalendarStore,
  SqliteFeishuCalendarStore,
  SqliteFeishuProviderStore,
  feishuCalendarCapabilityDeclarations,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
  feishuDocumentCapabilityDeclarations,
  feishuMessageCapabilityDeclarations,
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
import {
  createConfiguredDocumentServices,
} from "./development-document-access.js";

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
    readonly capability_citizens: readonly string[];
    readonly context_citizen: string;
  }>;
  close(): Promise<void>;
}

export interface ManagedFeishuProviderCompositionDependencies {
  readonly capability_citizens: readonly {
    readonly citizen_id: string;
    readonly lifecycle: LifecycleCitizen;
  }[];
  readonly context_citizen_id: string;
  readonly context_citizen: LifecycleCitizen;
  readonly host: LifecycleHost;
  readonly close_provider_store: () => Promise<void>;
}

export class ManagedFeishuProviderComposition
  implements FeishuProviderComposition {
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private capabilityStarted = 0;
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
      for (const citizen of this.dependencies.capability_citizens) {
        await citizen.lifecycle.start();
        this.capabilityStarted += 1;
      }
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
        capability_citizens: this.dependencies.capability_citizens.map(
          (citizen) => citizen.citizen_id,
        ),
        context_citizen: this.dependencies.context_citizen_id,
      };
    }
    const [capabilities, context] = await Promise.all([
      Promise.all(this.dependencies.capability_citizens.map(
        (citizen) => citizen.lifecycle.health(),
      )),
      this.dependencies.context_citizen.health(),
    ]);
    return {
      provider:
        capabilities.every((capability) =>
          capability.status === "available"
        ) && context.status === "available"
          ? "ready"
          : "failed",
      capability_citizens: this.dependencies.capability_citizens.map(
        (citizen) => citizen.citizen_id,
      ),
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
    while (this.capabilityStarted > 0) {
      this.capabilityStarted -= 1;
      await this.dependencies.capability_citizens[
        this.capabilityStarted
      ]!.lifecycle.close().catch(() => undefined);
    }
    if (!this.providerStoreClosed) {
      this.providerStoreClosed = true;
      await this.dependencies.close_provider_store().catch(() => undefined);
    }
  }
}

function capabilityDescriptor(
  declaration: CitizenDeclaration,
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
    constraints: {
      selected_citizen_id: citizenId,
      contract_digest: canonicalCitizenDigest(declaration),
    },
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
    max_active_partitions:
      loaded.service.concurrency.max_active_partitions,
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

interface FeishuContextProviders {
  readonly document: {
    read(
      input: Parameters<FeishuDocumentContextProvider["read"]>[0],
    ): ReturnType<FeishuDocumentContextProvider["read"]>;
  };
  readonly conversation: ConversationContextMaterializer;
}

export async function resolveFeishuContextRequest(
  providers: FeishuContextProviders,
  request: CitizenJsonObject,
  signal: AbortSignal,
): Promise<CitizenJsonObject> {
  if (request.declaration_id === "feishu.conversation.context") {
    const input =
      request.input !== null &&
      typeof request.input === "object" &&
      !Array.isArray(request.input)
        ? request.input
        : null;
    if (input === null) {
      throw new TypeError("Feishu conversation context request is invalid");
    }
    const result = await providers.conversation.materialize(
      input as unknown as ConversationContextRequest,
      signal,
    );
    if (result.kind !== "materialized") {
      throw new Error(result.code);
    }
    return result.bundle as CitizenJsonObject;
  }
  const authority =
    request.authority !== null &&
    typeof request.authority === "object" &&
    !Array.isArray(request.authority)
      ? request.authority as CitizenJsonObject
      : {};
  if (
    typeof request.tenant_id !== "string" ||
    request.document === null ||
    typeof request.document !== "object" ||
    Array.isArray(request.document) ||
    !Number.isSafeInteger(request.max_bytes) ||
    typeof authority.represented_actor_id !== "string" ||
    typeof authority.delegation_id !== "string" ||
    !Array.isArray(authority.delegation_scopes) ||
    authority.delegation_scopes.some((item) => typeof item !== "string") ||
    typeof authority.delegation_expires_at !== "string"
  ) throw new TypeError("Feishu context request is invalid");
  return providers.document.read({
    tenant_id: request.tenant_id,
    document: request.document as { readonly resource_uri: string },
    max_bytes: request.max_bytes as number,
    represented_actor_id: authority.represented_actor_id,
    delegation_id: authority.delegation_id,
    delegation_scopes: authority.delegation_scopes as string[],
    delegation_expires_at: authority.delegation_expires_at,
    signal,
  }) as Promise<CitizenJsonObject>;
}

export async function composeFeishuProvider(
  loaded: LoadedFeishuProviderConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  documentServices?: {
    readonly document_access: DocumentAccessAuthorizer;
    readonly placement: DocumentPlacementResolver;
  },
): Promise<FeishuProviderComposition> {
  const resolvedDocumentServices = documentServices ??
    createConfiguredDocumentServices(loaded.service, environment);
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
  const configuredFacets = enabledFeishuProviderFacets(loaded.provider);
  const calendarEnabled = configuredFacets.some((facet) =>
    facet.facet === "calendar"
  );
  const cursorKey = loaded.provider.cursor_signing_key === undefined
    ? randomBytes(32)
    : Buffer.from(loaded.provider.cursor_signing_key, "utf8");
  const cursorCodec = new HmacConversationCursorCodec({ key: cursorKey });
  const queryExecutor = new FeishuMessageQueryExecutor({
    api: messages,
    credential_ref: loaded.provider.credential_ref,
    cursors: cursorCodec,
  });
  const requestClient = new FeishuOpenApiRequestClient({
    credential_ref: loaded.provider.credential_ref,
    token_provider: tokenProvider,
    fetch: fetchImplementation,
    base_url: loaded.provider.open_api.base_url,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
    max_response_bytes: loaded.provider.open_api.max_response_bytes,
  });
  const membersExecutor = new FeishuConversationMembersExecutor({
    client: new FeishuOpenApiConversationMembersClient(requestClient),
    cursors: cursorCodec,
  });
  const calendarStore = !calendarEnabled
    ? null
    : loaded.provider.state.type === "sqlite"
    ? new SqliteFeishuCalendarStore(loaded.provider.state)
    : new MemoryFeishuCalendarStore();
  const calendarBackend = calendarEnabled
    ? new FeishuCalendarOpenApiBackend({ requests: requestClient })
    : null;
  const facetPorts = configuredFacets.map((facet) => {
    if (facet.facet === "calendar") {
      if (calendarStore === null || calendarBackend === null) {
        throw new Error("Feishu Calendar facet dependencies are unavailable");
      }
      const declarations = feishuCalendarCapabilityDeclarations;
      const capabilityIds = declarations().map((item) => item.declaration_id);
      const executor = new FeishuCalendarCapabilityExecutor({
        citizen_id: facet.citizen.citizen_id,
        endpoint_id: facet.citizen.endpoint_id,
        backend: calendarBackend,
        store: calendarStore,
        confirmation: { consume: async () => false },
      });
      return Object.freeze({
        facet,
        declarations,
        capability_ids: Object.freeze(capabilityIds),
        port: new FeishuCapabilityExecutorPortAdapter(
          executor,
          { declarations },
        ),
      });
    }
    const standardExecutor = new FeishuCapabilityExecutor({
      citizen_id: facet.citizen.citizen_id,
      endpoint_id: facet.citizen.endpoint_id,
      backend,
      executions: providerStore,
      ownership: providerStore,
      confirmation: { consume: async () => false },
      targets: {
        resolveCurrentConversation: async () => {
          throw new Error("current conversation context is unavailable");
        },
      },
      document_access: resolvedDocumentServices.document_access,
      placement: resolvedDocumentServices.placement,
    });
    const declarations = facet.facet === "message"
      ? feishuMessageCapabilityDeclarations
      : facet.facet === "document"
        ? feishuDocumentCapabilityDeclarations
        : feishuCapabilityDeclarations;
    const capabilityIds = declarations().map((item) => item.declaration_id);
    const executor = facet.facet === "document"
      ? standardExecutor
      : new FeishuCapabilityExecutorRouter([
          {
            capability_ids: ["feishu.message.send"],
            executor: standardExecutor,
          },
          {
            capability_ids: ["feishu.conversation.history.read"],
            executor: queryExecutor,
          },
          {
            capability_ids: ["feishu.conversation.members.list"],
            executor: membersExecutor,
          },
          ...(facet.facet === "aggregate"
            ? [{
                capability_ids: feishuDocumentCapabilityDeclarations().map(
                  (item) => item.declaration_id,
                ),
                executor: standardExecutor,
              }]
            : []),
        ]);
    return Object.freeze({
      facet,
      declarations,
      capability_ids: Object.freeze(capabilityIds),
      port: new FeishuCapabilityExecutorPortAdapter(
        executor,
        { declarations },
      ),
    });
  });
  const documentContext = new FeishuDocumentContextProvider({
    backend,
    document_access: resolvedDocumentServices.document_access,
  });
  const conversationContext = new FeishuConversationContextProvider({
    api: messages,
    credential_ref: loaded.provider.credential_ref,
  });
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
  const capabilityRuntimes = facetPorts.map((facet) => ({
    citizen_id: facet.facet.citizen.citizen_id,
    runtime: new FeishuCapabilityCitizenRuntime({
      ...facet.facet.citizen,
      actor_type: "agent",
      client_session_id:
        `feishu-${facet.facet.facet}-${process.pid}-${randomUUID()}`,
      expected_registration_version:
        facet.facet.citizen.registration_version,
      declarations: facet.declarations,
      execute: (request, context) => facet.port.execute(request, context),
    }),
  }));
  const contextRuntime = new FeishuContextCitizenRuntime({
    ...loaded.provider.context_citizen,
    actor_type: "agent",
    client_session_id: `feishu-context-${process.pid}-${randomUUID()}`,
    expected_registration_version:
      loaded.provider.context_citizen.registration_version,
    declarations: feishuContextDeclarations,
    resolve: (request, signal) =>
      resolveFeishuContextRequest({
        document: documentContext,
        conversation: conversationContext,
      }, request, signal),
  });
  const capabilities = facetPorts.flatMap((facet) =>
    facet.declarations().map((declaration) =>
      capabilityDescriptor(
        declaration,
        facet.facet.citizen.citizen_id,
      ),
    )
  );
  const gateway = new AgentGateway(client, gatewayConfiguration(
    loaded,
    capabilities,
  ));
  const runtimeState = new SqliteAgentRuntimeStateStore({
    location: loaded.service.runtime_state.location,
    busy_timeout_ms: loaded.service.runtime_state.busy_timeout_ms,
  });
  const executorByCapability = new Map(
    facetPorts.flatMap((facet) =>
      facet.capability_ids.map((capabilityId) =>
        [capabilityId, facet.port] as const
      )
    ),
  );
  const combinedExecutor = {
    describeCapabilities: () => facetPorts.flatMap(
      (facet) => facet.declarations(),
    ),
    execute: (
      request: Parameters<FeishuCapabilityExecutorPortAdapter["execute"]>[0],
      context: Parameters<FeishuCapabilityExecutorPortAdapter["execute"]>[1],
    ) => {
      const executor = executorByCapability.get(request.capability_id);
      if (executor === undefined) {
        throw new TypeError("Feishu capability is unavailable");
      }
      return executor.execute(request, context);
    },
  };
  const citizenIdByCapability = Object.fromEntries(facetPorts.flatMap(
    (facet) => facet.capability_ids.map((capabilityId) => [
      capabilityId,
      facet.facet.citizen.citizen_id,
    ]),
  ));
  const driver = new CapabilityProviderDriver({
    citizen_id: configuredFacets[0]!.citizen.citizen_id,
    citizen_id_by_capability: citizenIdByCapability,
    endpoint_id: loaded.participant.endpoint_id,
    capabilities: capabilities.map((item) => item.capability_id),
    executor: combinedExecutor,
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
  return new ManagedFeishuProviderComposition({
    capability_citizens: capabilityRuntimes.map((item) => ({
      citizen_id: item.citizen_id,
      lifecycle: {
        start: () => item.runtime.start(citizenContext),
        health: () => item.runtime.health(),
        close: () => item.runtime.close(),
      },
    })),
    context_citizen_id: loaded.provider.context_citizen.citizen_id,
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
      try {
        if ("close" in providerStore) await providerStore.close();
      } finally {
        await calendarStore?.close();
      }
    },
  });
}

export async function createFeishuProviderComposition(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FeishuProviderComposition> {
  const loaded = await loadFeishuProviderConfiguration({ environment });
  return composeFeishuProvider(loaded, environment);
}
