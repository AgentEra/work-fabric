import { createHash, randomUUID } from "node:crypto";

import {
  createGitHubAppOctokit,
  OctokitGitHubReadApi,
} from "@work-fabric/adapter-github-octokit";
import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import { AgentGateway, type AgentGatewayConfig } from "@work-fabric/agent-gateway";
import {
  DeterministicAcceptancePolicy,
  HandoffPackageLoader,
  composeAgentRuntimeHost,
} from "@work-fabric/agent-runtime-host";
import { CapabilityProviderDriver } from "@work-fabric/capability-provider-runtime";
import {
  EnvironmentSecretResolver,
  resolveDeclaredSecrets,
} from "@work-fabric/configuration-runtime";
import {
  GitHubCapabilityCitizenRuntime,
  GitHubCapabilityExecutor,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  githubReadCapabilityDeclarations,
} from "@work-fabric/provider-github";
import { canonicalCitizenDigest, type CitizenDeclaration, type CitizenHealth } from "@work-fabric/network-citizen-spi";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

import {
  type LoadedGitHubProviderConfiguration,
} from "./configuration.js";
import { EnvironmentGitHubCredentialProvider } from "./credentials.js";

interface LifecycleCitizen {
  start(): Promise<void>;
  health(): Promise<Pick<CitizenHealth, "status">>;
  close(): Promise<void>;
}

interface LifecycleHost {
  start(): Promise<void>;
  active(): boolean;
  close(): Promise<void>;
}

export interface GitHubProviderComposition {
  start(): Promise<void>;
  health(): Promise<{ readonly provider: "ready" | "starting" | "failed"; readonly citizen: string }>;
  close(): Promise<void>;
}

export interface ManagedGitHubProviderCompositionDependencies {
  readonly citizen_id: string;
  readonly citizen: LifecycleCitizen;
  readonly host: LifecycleHost;
}

/** Owns only the provider process lifecycle; GitHub queries remain in the executor. */
export class ManagedGitHubProviderComposition implements GitHubProviderComposition {
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private starting: Promise<void> | null = null;
  private citizenAttempted = false;
  private hostAttempted = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly dependencies: ManagedGitHubProviderCompositionDependencies) {}

  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "failed" || this.state === "closed") {
      return Promise.reject(new Error("GitHub Provider composition cannot be restarted"));
    }
    if (this.starting !== null) return this.starting;
    const starting = this.startInternal();
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = null;
    }).catch(() => undefined);
    return starting;
  }

  private async startInternal(): Promise<void> {
    try {
      this.citizenAttempted = true;
      await this.dependencies.citizen.start();
      this.hostAttempted = true;
      await this.dependencies.host.start();
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      await this.rollback();
      throw error;
    }
  }

  async health(): ReturnType<GitHubProviderComposition["health"]> {
    if (this.state !== "ready") {
      return {
        provider: this.state === "starting" ? "starting" : "failed",
        citizen: this.dependencies.citizen_id,
      };
    }
    const citizen = await this.dependencies.citizen.health();
    return {
      provider: citizen.status === "available" && this.dependencies.host.active()
        ? "ready"
        : "failed",
      citizen: this.dependencies.citizen_id,
    };
  }

  close(): Promise<void> {
    this.closing ??= this.closeInternal();
    return this.closing;
  }

  private async closeInternal(): Promise<void> {
    const starting = this.starting;
    if (starting !== null) await starting.catch(() => undefined);
    await this.rollback();
    this.state = "closed";
  }

  private async rollback(): Promise<void> {
    if (this.hostAttempted) {
      this.hostAttempted = false;
      await this.dependencies.host.close().catch(() => undefined);
    }
    if (this.citizenAttempted) {
      this.citizenAttempted = false;
      await this.dependencies.citizen.close().catch(() => undefined);
    }
  }
}

function descriptor(declaration: CitizenDeclaration, citizenId: string): CapabilityDescriptor {
  return {
    capability_id: declaration.declaration_id,
    version: declaration.version,
    name: declaration.name,
    description: declaration.description,
    input_media_types: ["application/json"],
    output_media_types: ["application/json"],
    input_schema_refs: declaration.input_schema === undefined ? [] : [declaration.input_schema.uri],
    output_schema_refs: declaration.output_schema === undefined ? [] : [declaration.output_schema.uri],
    interaction_modes: ["asynchronous"],
    constraints: {
      selected_citizen_id: citizenId,
      contract_digest: canonicalCitizenDigest(declaration),
    },
    extensions: {},
  };
}

export function githubCapabilityDescriptors(citizenId: string): readonly CapabilityDescriptor[] {
  return Object.freeze(githubReadCapabilityDeclarations().map((item) => descriptor(item, citizenId)));
}

export function installationIdHash(installationId: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(installationId, "utf8").digest("hex")}`;
}

function gatewayConfiguration(
  loaded: LoadedGitHubProviderConfiguration,
  capabilities: readonly CapabilityDescriptor[],
): AgentGatewayConfig {
  const now = new Date().toISOString();
  const subscription: SubscriptionDocument = {
    subscription_id: loaded.service.work_fabric.subscription_id,
    owner: { actor_id: loaded.provider.citizen.actor_id, actor_type: "system" },
    endpoint_id: loaded.provider.citizen.endpoint_id,
    filter: {
      event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [],
      work_reference_uris: [], capability_ids: [], lifecycle_states: [],
    },
    delivery: { mode: "sse" },
    state: "active",
    cursor: null,
    created_at: now,
    updated_at: now,
  };
  return {
    endpoint_id: loaded.provider.citizen.endpoint_id,
    subscription,
    open_session: {
      client_session_id: `github-provider-${process.pid}-${randomUUID()}`,
      protocol_version: "1.0",
      capabilities,
      availability: "available",
      requested_lease_seconds: loaded.service.citizen_lease.requested_lease_seconds,
      expected_registration_version: loaded.provider.citizen.registration_version,
    },
    inbox_refresh_ms: 1_000,
    max_active_partitions: loaded.service.concurrency.max_active_partitions,
    incoming_queue_capacity: loaded.service.concurrency.queue_capacity,
    heartbeat_retry_count: 3,
    heartbeat_backoff_ms: 250,
    graceful_close_timeout_ms: 10_000,
  };
}

async function resolvedRuntimeConfiguration(
  loaded: LoadedGitHubProviderConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return resolveDeclaredSecrets(
    { service: loaded.service, provider: loaded.provider },
    ["service.work_fabric.access_token", "provider.cursor_signing_key"],
    { resolver: new EnvironmentSecretResolver(environment), allow_literals: false },
  );
}

/** Constructs all local dependencies before starting a Citizen lease or Fabric stream. */
export async function composeGitHubProvider(
  loaded: LoadedGitHubProviderConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GitHubProviderComposition> {
  const resolved = await resolvedRuntimeConfiguration(loaded, environment);
  const credentialProvider = new EnvironmentGitHubCredentialProvider({
    ...loaded.provider.authentication,
    environment,
  });
  const credentials = await credentialProvider.load();
  const octokit = createGitHubAppOctokit(credentials);
  const api = new OctokitGitHubReadApi(octokit);
  const queryService = new GitHubQueryService({
    api,
    policy: new GitHubPolicyEvaluator(loaded.provider.policy),
    cursor: new HmacGitHubCursorCodec({ key: Buffer.from(resolved.provider.cursor_signing_key, "utf8") }),
    api_version: "github-v3",
  });
  const executor = new GitHubCapabilityExecutor({
    query_service: queryService,
    installation_id_hash: installationIdHash(credentials.installation_id),
  });
  const client = new WorkFabricClient({
    baseUrl: loaded.service.work_fabric.base_url,
    tenantId: loaded.service.work_fabric.tenant_id,
    exchangeId: loaded.service.work_fabric.exchange_id,
    representation: {
      actorId: loaded.provider.citizen.actor_id,
      endpointId: loaded.provider.citizen.endpoint_id,
    },
    authentication: new BearerTokenProvider(resolved.service.work_fabric.access_token),
  });
  const shutdown = new AbortController();
  const citizen = new GitHubCapabilityCitizenRuntime({
    citizen_id: loaded.provider.citizen.citizen_id,
    client_session_id: `github-citizen-${process.pid}-${randomUUID()}`,
    expected_registration_version: loaded.provider.citizen.registration_version,
    principal_id: loaded.provider.citizen.principal_id,
    actor_id: loaded.provider.citizen.actor_id,
    endpoint_id: loaded.provider.citizen.endpoint_id,
    executor,
  });
  const capabilities = githubCapabilityDescriptors(loaded.provider.citizen.citizen_id);
  const gateway = new AgentGateway(client, gatewayConfiguration(loaded, capabilities));
  const host = composeAgentRuntimeHost({
    config: {
      runtime_id: loaded.service.runtime_id,
      tenant_id: loaded.service.work_fabric.tenant_id,
      actor_id: loaded.provider.citizen.actor_id,
      actor_type: "system",
      endpoint_id: loaded.provider.citizen.endpoint_id,
      max_active_runs: loaded.service.concurrency.max_active_runs,
      queue_capacity: loaded.service.concurrency.queue_capacity,
      run_lease_seconds: 60,
      progress_interval_ms: 1_000,
      workspace_root: ".",
    },
    startSession: () => gateway.start({ signal: shutdown.signal }),
    state: new MemoryAgentRuntimeStateStore(),
    driver: new CapabilityProviderDriver({
      citizen_id: loaded.provider.citizen.citizen_id,
      endpoint_id: loaded.provider.citizen.endpoint_id,
      capabilities: capabilities.map((item) => item.capability_id),
      executor,
    }),
    packageLoader: new HandoffPackageLoader(client.queries, loaded.service.work_fabric.tenant_id, {
      role_id: "github-provider",
      version: 1,
      display_name: "GitHub Capability Provider",
      description: "Read-only GitHub capability provider",
      capability_ids: capabilities.map((item) => item.capability_id),
    }),
    policy: new DeterministicAcceptancePolicy({
      actor_id: loaded.provider.citizen.actor_id,
      endpoint_id: loaded.provider.citizen.endpoint_id,
      allowed_capability_ids: capabilities.map((item) => item.capability_id),
    }),
    queries: client.queries,
  });
  let hostActive = false;
  return new ManagedGitHubProviderComposition({
    citizen_id: loaded.provider.citizen.citizen_id,
    citizen: {
      start: () => citizen.start({
        tenant_id: loaded.service.work_fabric.tenant_id,
        client: client.citizens,
        clock: {
          now: () => new Date().toISOString(),
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        requested_lease_seconds: loaded.service.citizen_lease.requested_lease_seconds,
        heartbeat_safety_margin_ms: loaded.service.citizen_lease.heartbeat_safety_margin_ms,
        signal: shutdown.signal,
      }),
      health: () => citizen.health(),
      close: () => citizen.close(),
    },
    host: {
      start: async () => {
        await host.start();
        hostActive = true;
        void host.waitForSessionClose().then(() => { hostActive = false; });
      },
      active: () => hostActive,
      close: async () => {
        hostActive = false;
        try {
          await host.close();
        } finally {
          shutdown.abort();
        }
      },
    },
  });
}
