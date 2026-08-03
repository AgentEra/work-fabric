import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { SqliteAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-sqlite";
import {
  CatalogCapabilityResolver,
  HandoffCapabilityInvocationPort,
  JsonSchemaInvocationValidator,
  PollingAuxiliaryHandoffWaiter,
} from "@work-fabric/agent-capability-runtime";
import { AgentGateway, type AgentGatewayConfig } from "@work-fabric/agent-gateway";
import {
  AgentRuntimeHost,
  DeterministicAcceptancePolicy,
  HandoffPackageLoader,
} from "@work-fabric/agent-runtime-host";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";
import {
  GitHubCapabilityCitizenRuntime,
  GitHubCapabilityExecutor,
  GitHubCapabilitySchemaRegistry,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  githubReadCapabilityDeclarations,
  type GitHubPullRequestRecord,
  type GitHubReadApi,
} from "@work-fabric/provider-github";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type EndpointRegistration,
} from "@work-fabric/sdk-typescript";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

import { CapabilityProviderDriver } from "@work-fabric/capability-provider-runtime";
import { githubProviderEvidenceIdentity } from "../../../examples/github-capability-provider/src/composition.js";

type ActorType = "human" | "agent" | "service" | "system";
type AuthorityRule = {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly actor_type: ActorType;
  readonly endpoint_id: string;
  readonly action: string;
  readonly resource_id: string | null;
};

function unifiedGitHubProviderFixture() {
  const bundle = parse(readFileSync(
    new URL("../../../examples/config/local-feishu-assistant.bundle.yaml", import.meta.url),
    "utf8",
  )) as {
    applications: {
      "work-fabric": {
        service: {
          tenant_id: string;
          exchange_id: string;
          identities: Array<{
            authentication_evidence: { bearer_token: string };
            principal: {
              principal_id: string;
              tenant_id: string;
              actor_claims: Array<{
                actor_id: string;
                actor_type: ActorType;
                endpoint_ids: string[];
              }>;
              attributes: Record<string, unknown>;
            };
          }>;
          authority_rules: AuthorityRule[];
        };
        agent_runtime_authority: {
          grants: {
            "github-provider": {
              tenant_id: string;
              principal_id: string;
              actor_id: string;
              actor_type?: ActorType;
              endpoint_id: string;
              subscription_id: string;
            };
          };
        };
      };
      "github-provider": {
        service: {
          work_fabric: {
            tenant_id: string;
            exchange_id: string;
            subscription_id: string;
          };
        };
        plugins: {
          instances: {
            "github-primary": {
              config: {
                citizen: {
                  citizen_id: string;
                  principal_id: string;
                  actor_id: string;
                  endpoint_id: string;
                  registration_version: number;
                };
              };
            };
          };
        };
      };
    };
  };
  const workFabric = bundle.applications["work-fabric"];
  const providerApplication = bundle.applications["github-provider"];
  const grant = workFabric.agent_runtime_authority.grants["github-provider"];
  const identity = workFabric.service.identities.find((item) =>
    item.authentication_evidence.bearer_token === "${GITHUB_PROVIDER_ACCESS_TOKEN}"
  );
  const claim = identity?.principal.actor_claims[0];
  const citizen = providerApplication.plugins.instances["github-primary"].config.citizen;
  if (
    identity === undefined || claim === undefined ||
    grant.actor_type !== "system" ||
    grant.tenant_id !== workFabric.service.tenant_id ||
    providerApplication.service.work_fabric.tenant_id !== grant.tenant_id ||
    providerApplication.service.work_fabric.exchange_id !== workFabric.service.exchange_id ||
    providerApplication.service.work_fabric.subscription_id !== grant.subscription_id ||
    identity.principal.principal_id !== grant.principal_id ||
    identity.principal.tenant_id !== grant.tenant_id ||
    claim.actor_id !== grant.actor_id ||
    claim.actor_type !== grant.actor_type ||
    claim.endpoint_ids.length !== 1 || claim.endpoint_ids[0] !== grant.endpoint_id ||
    citizen.principal_id !== grant.principal_id ||
    citizen.actor_id !== grant.actor_id ||
    citizen.endpoint_id !== grant.endpoint_id
  ) {
    throw new TypeError("unified bundle GitHub Provider identity, grant, and Citizen must agree");
  }
  const authorityRules = workFabric.service.authority_rules.filter((item) =>
    item.principal_id === grant.principal_id
  );
  if (
    authorityRules.length === 0 ||
    authorityRules.some((item) =>
      item.tenant_id !== grant.tenant_id ||
      item.actor_id !== grant.actor_id ||
      item.actor_type !== grant.actor_type ||
      item.endpoint_id !== grant.endpoint_id ||
      item.resource_id !== citizen.citizen_id
    )
  ) {
    throw new TypeError("unified bundle GitHub Provider Authority rules must match its grant");
  }
  return Object.freeze({
    tenant_id: grant.tenant_id,
    exchange_id: workFabric.service.exchange_id,
    grant: Object.freeze({ ...grant, actor_type: grant.actor_type }),
    principal: Object.freeze(identity.principal),
    citizen: Object.freeze(citizen),
    authority_rules: Object.freeze(authorityRules),
  });
}

const UNIFIED_GITHUB = unifiedGitHubProviderFixture();
const TENANT = UNIFIED_GITHUB.tenant_id;
const EXCHANGE = UNIFIED_GITHUB.exchange_id;
const CITIZEN_ID = UNIFIED_GITHUB.citizen.citizen_id;
const PROVIDER = Object.freeze({
  token: "provider-loop-token",
  principal: UNIFIED_GITHUB.principal.principal_id,
  actor: UNIFIED_GITHUB.grant.actor_id,
  endpoint: UNIFIED_GITHUB.grant.endpoint_id,
  subscription: UNIFIED_GITHUB.grant.subscription_id,
});
const ASSISTANT = Object.freeze({
  token: "assistant-loop-token",
  principal: "principal-daily-assistant",
  actor: "actor-daily-assistant",
  endpoint: "endpoint-daily-assistant",
  subscription: "subscription-daily-assistant",
});
const ADMIN = Object.freeze({
  token: "admin-loop-token",
  principal: "principal-admin",
  actor: "actor-admin",
  endpoint: "endpoint-admin",
});
const repository = { owner: "AgentEra", name: "work-fabric" } as const;
const pullRequests: readonly GitHubPullRequestRecord[] = [1, 2].map((number) => ({
  repository,
  number,
  title: `PR ${number}`,
  url: `https://github.com/AgentEra/work-fabric/pull/${number}`,
  author: "octocat",
  draft: false,
  base_branch: "main",
  head_branch: `feature-${number}`,
  head_sha: `abc123${number}`,
  assignees: [],
  requested_reviewers: [],
  labels: [],
  mergeable: true,
  created_at: `2026-08-0${number}T09:00:00.000Z`,
  updated_at: `2026-08-0${number}T10:00:00.000Z`,
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function client(
  origin: string,
  identity: {
    readonly token: string;
    readonly actor: string;
    readonly endpoint: string;
  },
): WorkFabricClient {
  return new WorkFabricClient({
    baseUrl: origin,
    tenantId: TENANT,
    exchangeId: EXCHANGE,
    representation: {
      actorId: identity.actor,
      endpointId: identity.endpoint,
    },
    authentication: new BearerTokenProvider(identity.token),
    streamReconnect: {
      baseDelayMs: 10,
      maxDelayMs: 25,
      maxReconnects: 8,
    },
  });
}

function rule(
  identity: {
    readonly principal: string;
    readonly actor: string;
    readonly endpoint: string;
  },
  action: string,
  resource_id: string | null,
  actor_type: "agent" | "system" = "agent",
) {
  return {
    tenant_id: TENANT,
    principal_id: identity.principal,
    actor_id: identity.actor,
    actor_type,
    endpoint_id: identity.endpoint,
    action,
    resource_id,
  };
}

function providerCapability(
  declaration: ReturnType<typeof githubReadCapabilityDeclarations>[number],
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
      selected_citizen_id: CITIZEN_ID,
      contract_digest: canonicalCitizenDigest(declaration),
    },
    extensions: {},
  };
}

function gatewayConfig(
  capabilities: readonly CapabilityDescriptor[],
  actorType: "system",
  registrationVersion: number,
): AgentGatewayConfig {
  const now = new Date().toISOString();
  return {
    endpoint_id: PROVIDER.endpoint,
    subscription: {
      subscription_id: PROVIDER.subscription,
      owner: { actor_id: PROVIDER.actor, actor_type: actorType },
      endpoint_id: PROVIDER.endpoint,
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
    },
    open_session: {
      client_session_id: "provider-http-loop",
      protocol_version: "1.0",
      capabilities,
      availability: "available",
      requested_lease_seconds: 60,
      expected_registration_version: registrationVersion,
    },
    inbox_refresh_ms: 50,
    max_active_partitions: 8,
    incoming_queue_capacity: 8,
    heartbeat_retry_count: 2,
    heartbeat_backoff_ms: 10,
    graceful_close_timeout_ms: 5_000,
  };
}

function readApi(): GitHubReadApi {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected GitHub API call");
  };
  return {
    getIdentity: unused,
    listRepositories: unused,
    getRepository: unused,
    listPullRequests: async () => ({ items: pullRequests }),
    searchPullRequests: unused,
    getPullRequest: unused,
    listReviews: unused,
    listIssueComments: unused,
    listReviewComments: unused,
    listFiles: unused,
    listPullRequestCommits: unused,
    getChecks: unused,
    listWorkflowRuns: unused,
    listCommits: unused,
  };
}

async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  timeout: () => Error | Promise<Error>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(timeout()).then(reject, reject);
    }, milliseconds);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("public Agent -> auxiliary Handoff -> GitHub Citizen loop", () => {
  it("uses delivery, runtime claim/accept, and Fabric Result while Daily Assistant remains verifier", async () => {
    const providerActorType = UNIFIED_GITHUB.grant.actor_type;
    expect(providerActorType).toBe("system");
    expect(PROVIDER).toMatchObject({
      principal: "principal-github-provider",
      actor: "actor-github-provider",
      endpoint: "endpoint-github-provider",
      subscription: "subscription-github-provider",
    });
    if (providerActorType !== "system") throw new Error("unified bundle GitHub Provider must be system-typed");
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-http-"));
    directories.push(directory);
    const declaration = githubReadCapabilityDeclarations().find(
      (item) => item.declaration_id === "github.pull_request.list",
    )!;
    const capability = providerCapability(declaration);
    let id = 0;
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "sqlite-local",
      role: "all",
      development_mode: true,
      tenant_id: TENANT,
      exchange_id: EXCHANGE,
      cursor_secret: "c".repeat(32),
      sqlite: {
        location: join(directory, "work-fabric.db"),
        busy_timeout_ms: 5_000,
      },
      identities: [
        {
          authentication_evidence: { bearer_token: ADMIN.token },
          principal: {
            principal_id: ADMIN.principal,
            tenant_id: TENANT,
            actor_claims: [{
              actor_id: ADMIN.actor,
              actor_type: "agent",
              endpoint_ids: [ADMIN.endpoint],
            }],
            attributes: {},
          },
        },
        {
          authentication_evidence: { bearer_token: ASSISTANT.token },
          principal: {
            principal_id: ASSISTANT.principal,
            tenant_id: TENANT,
            actor_claims: [{
              actor_id: ASSISTANT.actor,
              actor_type: "agent",
              endpoint_ids: [ASSISTANT.endpoint],
            }],
            attributes: {},
          },
        },
        {
          authentication_evidence: { bearer_token: PROVIDER.token },
          principal: UNIFIED_GITHUB.principal,
        },
      ],
      authority_rules: [
        rule(ADMIN, "workfabric.endpoint.provision.v1", PROVIDER.endpoint),
        rule(ADMIN, "workfabric.citizen.provision.v1", CITIZEN_ID),
        ...UNIFIED_GITHUB.authority_rules,
        rule(ASSISTANT, "workfabric.handoff.offer.v1", null),
        rule(ASSISTANT, "workfabric.citizen.discover.v1", null),
        rule(
          ASSISTANT,
          "workfabric.citizen.declaration.read.v1",
          `${CITIZEN_ID}/${declaration.declaration_id}`,
        ),
      ],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      ids: {
        nextId(kind) {
          id += 1;
          return `${kind}-github-http-${id}`;
        },
      },
      agent_runtime_authority: {
        grants: {
          assistant: {
            tenant_id: TENANT,
            principal_id: ASSISTANT.principal,
            actor_id: ASSISTANT.actor,
            endpoint_id: ASSISTANT.endpoint,
            subscription_id: ASSISTANT.subscription,
          },
          provider: {
            ...UNIFIED_GITHUB.grant,
          },
        },
      },
    });
    let providerHost: AgentRuntimeHost | undefined;
    let invocationState: SqliteAgentRuntimeStateStore | undefined;
    let citizenRuntime: GitHubCapabilityCitizenRuntime | undefined;
    const citizenShutdown = new AbortController();
    try {
      const { origin } = await service.listen();
      await service.start();
      const admin = client(origin, ADMIN);
      const assistant = client(origin, ASSISTANT);
      const provider = client(origin, PROVIDER);

      const registration: EndpointRegistration = {
        endpoint_id: PROVIDER.endpoint,
        actor: { actor_id: PROVIDER.actor, actor_type: providerActorType },
        endpoint_type: "workfabric.dev/capability_provider",
        display_name: "GitHub Capability Provider",
        protocol_versions: ["1.0"],
        bindings: [{
          binding_type: "http_sse",
          uri: "urn:work-fabric:provider:github",
          security_schemes: ["bearer"],
          extensions: {},
        }],
        allowed_capability_ids: [declaration.declaration_id],
        limits: {
          max_inline_content_bytes: 262_144,
          max_concurrent_handoffs: 1,
        },
        administrative_state: "enabled",
        registration_version: UNIFIED_GITHUB.citizen.registration_version,
      };
      await admin.endpoints.provision(PROVIDER.endpoint, registration);
      await admin.citizens.provision(CITIZEN_ID, {
        citizen_id: CITIZEN_ID,
        citizen_kind: "capability-provider",
        principal_id: PROVIDER.principal,
        allowed_actor: {
          actor_id: PROVIDER.actor,
          actor_type: providerActorType,
        },
        allowed_endpoint_id: PROVIDER.endpoint,
        allowed_declaration_namespaces: ["github"],
        maximum_risk: "destructive",
        administrative_state: "enabled",
        registration_version: UNIFIED_GITHUB.citizen.registration_version,
      });

      const evidenceIdentity = githubProviderEvidenceIdentity("12345", Buffer.alloc(32, 4));
      const query = new GitHubQueryService({
        api: readApi(),
        policy: new GitHubPolicyEvaluator({
          allowed_owners: ["AgentEra"],
          allowed_repositories: [repository],
          maximum_page_size: 5,
          maximum_aggregate_repositories: 10,
        }),
        cursor: new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 4) }),
        api_version: evidenceIdentity.api_version,
        now: () => "2026-08-02T10:00:01.000Z",
      });
      const executor = new GitHubCapabilityExecutor({
        query_service: query,
        installation_id_hash: evidenceIdentity.installation_id_hash,
        now: () => "2026-08-02T10:00:01.000Z",
      });
      const citizenExecute = vi.spyOn(executor, "execute");
      citizenRuntime = new GitHubCapabilityCitizenRuntime({
        citizen_id: CITIZEN_ID,
        client_session_id: "github-citizen-http-loop",
        expected_registration_version: UNIFIED_GITHUB.citizen.registration_version,
        principal_id: PROVIDER.principal,
        actor_id: PROVIDER.actor,
        endpoint_id: PROVIDER.endpoint,
        executor,
      });
      await citizenRuntime.start({
        tenant_id: TENANT,
        client: provider.citizens,
        clock: {
          now: () => new Date().toISOString(),
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        requested_lease_seconds: 300,
        heartbeat_safety_margin_ms: 5_000,
        signal: citizenShutdown.signal,
      });
      await expect(citizenRuntime.health()).resolves.toMatchObject({
        status: "available",
      });

      const gateway = new AgentGateway(
        {
          endpoints: provider.endpoints,
          subscriptions: provider.subscriptions,
          queries: provider.queries,
          handoffs: provider.handoffs,
        },
        gatewayConfig(
          [capability],
          providerActorType,
          UNIFIED_GITHUB.citizen.registration_version,
        ),
      );
      const providerState = new SqliteAgentRuntimeStateStore({
        location: join(directory, "provider-runtime.db"),
        busy_timeout_ms: 5_000,
      });
      const lifecycleOrder: string[] = [];
      const claimRun = providerState.claimRun.bind(providerState);
      vi.spyOn(providerState, "claimRun").mockImplementation(async (input) => {
        lifecycleOrder.push("claim");
        return claimRun(input);
      });
      const providerSession = await gateway.start();
      const providerIncoming = providerSession.incoming()[Symbol.asyncIterator]();
      const accept = providerSession.handoffs.accept.bind(providerSession.handoffs);
      const instrumentedHandoffs = {
        accept: async (...args: Parameters<typeof accept>) => {
          lifecycleOrder.push("accept");
          return accept(...args);
        },
        decline: providerSession.handoffs.decline.bind(providerSession.handoffs),
        reportStatus:
          providerSession.handoffs.reportStatus.bind(providerSession.handoffs),
        returnResult:
          providerSession.handoffs.returnResult.bind(providerSession.handoffs),
      } as typeof providerSession.handoffs;
      const instrumentedSession = {
        session_id: providerSession.session_id,
        handoffs: instrumentedHandoffs,
        closed: providerSession.closed,
        incoming: () => providerSession.incoming(),
        close: (options?: { readonly signal?: AbortSignal }) =>
          providerSession.close(options),
      };
      const providerDriver = new CapabilityProviderDriver({
        citizen_id: CITIZEN_ID,
        endpoint_id: PROVIDER.endpoint,
        capabilities: [declaration.declaration_id],
        executor: citizenRuntime.executor,
      });
      const providerLoader = new HandoffPackageLoader(
        provider.queries,
        TENANT,
        {
          role_id: "github-provider",
          version: 1,
          display_name: "GitHub Provider",
          description: "Typed read-only GitHub capabilities",
          capability_ids: [declaration.declaration_id],
        },
      );
      providerHost = new AgentRuntimeHost({
        config: {
          runtime_id: "github-provider-http-loop",
          tenant_id: TENANT,
          actor_id: PROVIDER.actor,
          actor_type: providerActorType,
          endpoint_id: PROVIDER.endpoint,
          max_active_runs: 1,
          queue_capacity: 8,
          run_lease_seconds: 60,
          progress_interval_ms: 1_000,
          workspace_root: join(directory, "provider-workspaces"),
        },
        session: instrumentedSession,
        state: providerState,
        driver: providerDriver,
        packageLoader: providerLoader,
        policy: new DeterministicAcceptancePolicy({
          actor_id: PROVIDER.actor,
          endpoint_id: PROVIDER.endpoint,
          allowed_capability_ids: [declaration.declaration_id],
        }),
        queries: provider.queries,
      });

      invocationState = new SqliteAgentRuntimeStateStore({
        location: join(directory, "assistant-invocations.db"),
        busy_timeout_ms: 5_000,
      });
      const invocationPort = new HandoffCapabilityInvocationPort({
        tenant_id: TENANT,
        owner_id: "daily-assistant:http-loop",
        verifier: {
          actor_id: ASSISTANT.actor,
          actor_type: "agent",
        },
        resolver: new CatalogCapabilityResolver(assistant.citizens),
        schemas: new JsonSchemaInvocationValidator(
          new GitHubCapabilitySchemaRegistry(),
        ),
        authority: {
          authorize: async ({ request, candidate }) => ({
            delegation_id: "delegation-github-http-loop",
            scopes: ["capability:invoke", "github:read"],
            resource_refs: [
              `urn:work-fabric:capability-invocation:${request.original_handoff_id}:${request.invocation_id}`,
            ],
            expires_at: request.deadline,
            may_redelegate: false,
            extensions: {
              "workfabric.dev/capability_authority": {
                original_handoff_id: request.original_handoff_id,
                invocation_id: request.invocation_id,
                represented_actor_id: "actor-human-requester",
                delegation_id: "delegation-github-http-loop",
                parent_delegation_id: "delegation-human-agent",
                delegation_scopes: ["github:read"],
                delegation_expires_at: request.deadline,
                capability_version: candidate.capability_version,
                contract_digest: candidate.contract_digest,
                allowed_target_refs: [],
                confirmation_proof_refs: [],
              },
            },
          }),
        },
        handoffs: {
          offer: (payload, options) => assistant.handoffs.offer(payload, options),
          resolveTarget: (payload, options) =>
            assistant.handoffs.resolveTarget(payload, options),
          getHandoff: (handoffId, options) =>
            assistant.queries.getHandoff(handoffId, options),
        },
        waiter: new PollingAuxiliaryHandoffWaiter({
          queries: assistant.queries,
          poll_interval_ms: 20,
        }),
        state: invocationState,
      });

      const discovered = await invocationPort.discover({
        capability_id: declaration.declaration_id,
        version_constraint: declaration.version,
      });
      expect(discovered).toEqual([{
        citizen_id: CITIZEN_ID,
        endpoint_id: PROVIDER.endpoint,
        capability_id: declaration.declaration_id,
        capability_version: declaration.version,
        contract_digest: canonicalCitizenDigest(declaration),
      }]);

      const invocation = invocationPort.invoke({
        invocation_id: "invocation-github-http-loop",
        original_handoff_id: "handoff-original-owned-by-assistant",
        thread_id: "thread-github-http-loop",
        capability_id: declaration.declaration_id,
        version_constraint: declaration.version,
        input: {
          target: { owner: "AgentEra" },
          state: "open",
          page_size: 5,
        },
        reason: "current pull request facts",
        deadline: new Date(Date.now() + 60_000).toISOString(),
      }, new AbortController().signal);
      const incoming = await within(providerIncoming.next(), 3_000, () =>
        new Error("GitHub Provider did not receive the auxiliary Handoff"));
      if (incoming.done) throw new Error("Provider Gateway closed unexpectedly");
      await providerHost.handle(incoming.value);
      const result = await within(invocation, 3_000, () =>
        new Error("GitHub capability invocation stalled"));

      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "succeeded",
        invocation_id: "invocation-github-http-loop",
        data: {
          state: "complete",
          items: [{ number: 1 }, { number: 2 }],
          evidence: { provider: "github", complete: true },
        },
      });
      if (result.auxiliary_handoff_id === null) {
        throw new Error("expected auxiliary Handoff");
      }
      const [snapshot, events, run] = await Promise.all([
        assistant.queries.getHandoff(result.auxiliary_handoff_id),
        assistant.queries.listHandoffEvents(result.auxiliary_handoff_id),
        providerState.getRun(TENANT, result.auxiliary_handoff_id),
      ]);
      expect(snapshot).toMatchObject({
        state: {
          lifecycle_state: "result_returned",
          initiator: {
            actor_id: ASSISTANT.actor,
            actor_type: "agent",
          },
          recipient: {
            actor_id: PROVIDER.actor,
          actor_type: providerActorType,
          },
          package: {
            target: {
              capability_requirement: {
                constraints: {
                  selected_citizen_id: CITIZEN_ID,
                  contract_digest: canonicalCitizenDigest(declaration),
                },
              },
            },
          },
          target_binding: {
            target: { endpoint_id: PROVIDER.endpoint },
            evidence: [{
              content: {
                data: {
                  citizen_id: CITIZEN_ID,
                  declaration_id: declaration.declaration_id,
                  declaration_version: declaration.version,
                  contract_digest: canonicalCitizenDigest(declaration),
                },
              },
            }],
          },
          verifier: {
            actor_id: ASSISTANT.actor,
            actor_type: "agent",
          },
          current_responsible_actor: {
            actor_id: ASSISTANT.actor,
            actor_type: "agent",
          },
        },
      });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "workfabric.handoff.target_resolution_requested.v1",
        "workfabric.handoff.target_resolved.v1",
        "workfabric.handoff.accepted.v1",
        "workfabric.handoff.status_reported.v1",
        "workfabric.handoff.result_returned.v1",
      ]));
      expect(lifecycleOrder.slice(0, 2)).toEqual(["claim", "accept"]);
      expect(run).toMatchObject({ state: "succeeded" });
      expect(citizenExecute).toHaveBeenCalledOnce();
      expect(citizenExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          capability_id: declaration.declaration_id,
          contract_digest: canonicalCitizenDigest(declaration),
        }),
        expect.objectContaining({
          citizen_id: CITIZEN_ID,
          endpoint_id: PROVIDER.endpoint,
        }),
      );
      expect(JSON.stringify({ result, snapshot })).not.toMatch(
        /access_token|private_key|credential_ref|vendor_response/i,
      );
    } finally {
      await providerHost?.close().catch(() => undefined);
      citizenShutdown.abort();
      await citizenRuntime?.close().catch(() => undefined);
      await invocationState?.close().catch(() => undefined);
      await service.close();
    }
  }, 30_000);
});
