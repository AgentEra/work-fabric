import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  FeishuCapabilityExecutor,
  FeishuCapabilityExecutorPortAdapter,
  FeishuCapabilitySchemaRegistry,
  SqliteFeishuProviderStore,
  feishuCapabilityDeclarations,
  type FeishuCapabilityBackend,
} from "@work-fabric/provider-feishu";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type EndpointRegistration,
} from "@work-fabric/sdk-typescript";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

import { CapabilityProviderDriver } from "@work-fabric/capability-provider-runtime";

const TENANT = "tenant-feishu-http-loop";
const EXCHANGE = "exchange-feishu-http-loop";
const CITIZEN_ID = "feishu-actions";
const PROVIDER = Object.freeze({
  token: "provider-loop-token",
  principal: "principal-feishu-provider",
  actor: "actor-feishu-provider",
  endpoint: "endpoint-feishu-provider",
  subscription: "subscription-feishu-provider",
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
) {
  return {
    tenant_id: TENANT,
    principal_id: identity.principal,
    actor_id: identity.actor,
    actor_type: "agent" as const,
    endpoint_id: identity.endpoint,
    action,
    resource_id,
  };
}

function providerCapability(
  declaration: ReturnType<typeof feishuCapabilityDeclarations>[number],
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
): AgentGatewayConfig {
  const now = new Date().toISOString();
  return {
    endpoint_id: PROVIDER.endpoint,
    subscription: {
      subscription_id: PROVIDER.subscription,
      owner: { actor_id: PROVIDER.actor, actor_type: "agent" },
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
      expected_registration_version: 1,
    },
    inbox_refresh_ms: 50,
    max_active_partitions: 8,
    incoming_queue_capacity: 8,
    heartbeat_retry_count: 2,
    heartbeat_backoff_ms: 10,
    graceful_close_timeout_ms: 5_000,
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

describe("public Agent -> auxiliary Handoff -> Feishu Provider loop", () => {
  it("uses SQLite plus public HTTP/SSE and preserves the original Agent responsibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-feishu-http-"));
    directories.push(directory);
    const declaration = feishuCapabilityDeclarations().find(
      (item) => item.declaration_id === "feishu.document.create",
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
          principal: {
            principal_id: PROVIDER.principal,
            tenant_id: TENANT,
            actor_claims: [{
              actor_id: PROVIDER.actor,
              actor_type: "agent",
              endpoint_ids: [PROVIDER.endpoint],
            }],
            attributes: {},
          },
        },
      ],
      authority_rules: [
        rule(ADMIN, "workfabric.endpoint.provision.v1", PROVIDER.endpoint),
        rule(ADMIN, "workfabric.citizen.provision.v1", CITIZEN_ID),
        rule(PROVIDER, "workfabric.citizen.session.open.v1", CITIZEN_ID),
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
          return `${kind}-feishu-http-${id}`;
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
            tenant_id: TENANT,
            principal_id: PROVIDER.principal,
            actor_id: PROVIDER.actor,
            endpoint_id: PROVIDER.endpoint,
            subscription_id: PROVIDER.subscription,
          },
        },
      },
    });
    let providerHost: AgentRuntimeHost | undefined;
    let providerStore: SqliteFeishuProviderStore | undefined;
    let invocationState: SqliteAgentRuntimeStateStore | undefined;
    try {
      const { origin } = await service.listen();
      await service.start();
      const admin = client(origin, ADMIN);
      const assistant = client(origin, ASSISTANT);
      const provider = client(origin, PROVIDER);

      const registration: EndpointRegistration = {
        endpoint_id: PROVIDER.endpoint,
        actor: { actor_id: PROVIDER.actor, actor_type: "agent" },
        endpoint_type: "workfabric.dev/capability_provider",
        display_name: "Feishu Capability Provider",
        protocol_versions: ["1.0"],
        bindings: [{
          binding_type: "http_sse",
          uri: "urn:work-fabric:provider:feishu",
          security_schemes: ["bearer"],
          extensions: {},
        }],
        allowed_capability_ids: [declaration.declaration_id],
        limits: {
          max_inline_content_bytes: 262_144,
          max_concurrent_handoffs: 1,
        },
        administrative_state: "enabled",
        registration_version: 1,
      };
      await admin.endpoints.provision(PROVIDER.endpoint, registration);
      await admin.citizens.provision(CITIZEN_ID, {
        citizen_id: CITIZEN_ID,
        citizen_kind: "capability-provider",
        principal_id: PROVIDER.principal,
        allowed_actor: { actor_id: PROVIDER.actor, actor_type: "agent" },
        allowed_endpoint_id: PROVIDER.endpoint,
        allowed_declaration_namespaces: ["feishu"],
        maximum_risk: "destructive",
        administrative_state: "enabled",
        registration_version: 1,
      });
      await provider.citizens.openSession(CITIZEN_ID, {
        client_session_id: "feishu-citizen-http-loop",
        descriptor: {
          citizen_id: CITIZEN_ID,
          citizen_kind: "capability-provider",
          version: "1.0.0",
          identity: {
            principal_id: PROVIDER.principal,
            actor: { actor_id: PROVIDER.actor, actor_type: "agent" },
            endpoint_id: PROVIDER.endpoint,
          },
          protocol: {
            versions: ["1"],
            bindings: ["workfabric+https"],
          },
          declarations: {
            count: 1,
            digest: canonicalCitizenDigest([declaration]),
          },
          availability: "available",
          extensions: {},
        },
        declarations: [declaration],
        requested_lease_seconds: 300,
        expected_registration_version: 1,
      });

      const backend: FeishuCapabilityBackend = {
        createDocument: vi.fn(async (input) => ({
          document_token: "doc-http-loop",
          url: "https://feishu.example/docx/doc-http-loop",
          title: input.title,
          revision: "1",
        })),
        sendMessage: vi.fn(),
        readDocument: vi.fn(),
        replaceDocument: vi.fn(),
        appendDocument: vi.fn(),
        deleteDocument: vi.fn(),
      };
      providerStore = new SqliteFeishuProviderStore({
        location: join(directory, "feishu-provider.db"),
        busy_timeout_ms: 5_000,
      });
      const executor = new FeishuCapabilityExecutorPortAdapter(
        new FeishuCapabilityExecutor({
          citizen_id: CITIZEN_ID,
          endpoint_id: PROVIDER.endpoint,
          backend,
          executions: providerStore,
          ownership: providerStore,
          confirmation: { consume: async () => false },
          targets: {
            resolveCurrentConversation: async () => ({
              kind: "chat_id",
              id: "chat-http-loop",
            }),
          },
          shared_folder: {
            token: "fld-shared-team",
            policy_ref: "feishu.shared-folder.default",
          },
        }),
      );
      const gateway = new AgentGateway(
        {
          endpoints: provider.endpoints,
          subscriptions: provider.subscriptions,
          queries: provider.queries,
          handoffs: provider.handoffs,
        },
        gatewayConfig([capability]),
      );
      const providerState = new SqliteAgentRuntimeStateStore({
        location: join(directory, "provider-runtime.db"),
        busy_timeout_ms: 5_000,
      });
      const providerSession = await gateway.start();
      const providerIncoming =
        providerSession.incoming()[Symbol.asyncIterator]();
      const providerDriver = new CapabilityProviderDriver({
        citizen_id: CITIZEN_ID,
        endpoint_id: PROVIDER.endpoint,
        capabilities: [declaration.declaration_id],
        executor,
      });
      const providerLoader = new HandoffPackageLoader(
        provider.queries,
        TENANT,
        {
          role_id: "feishu-provider",
          version: 1,
          display_name: "Feishu Provider",
          description: "Typed Feishu capabilities",
          capability_ids: [declaration.declaration_id],
        },
      );
      providerHost = new AgentRuntimeHost({
        config: {
          runtime_id: "feishu-provider-http-loop",
          tenant_id: TENANT,
          actor_id: PROVIDER.actor,
          endpoint_id: PROVIDER.endpoint,
          max_active_runs: 1,
          queue_capacity: 8,
          run_lease_seconds: 60,
          progress_interval_ms: 1_000,
          workspace_root: join(directory, "provider-workspaces"),
        },
        session: providerSession,
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
          new FeishuCapabilitySchemaRegistry(),
        ),
        authority: {
          authorize: async ({ request, candidate }) => ({
            delegation_id: "delegation-feishu-http-loop",
            scopes: ["capability:invoke"],
            resource_refs: [
              `urn:work-fabric:capability-invocation:${request.original_handoff_id}:${request.invocation_id}`,
            ],
            expires_at: request.deadline,
            may_redelegate: false,
            extensions: {
              "workfabric.dev/capability_authority": {
                original_handoff_id: request.original_handoff_id,
                invocation_id: request.invocation_id,
                initiating_actor_id: "actor-human-requester",
                capability_version: candidate.capability_version,
                contract_digest: candidate.contract_digest,
                allowed_target_refs: [],
                allowed_document_tokens: [],
                allowed_resource_policy_refs: [
                  "feishu.shared-folder.default",
                ],
                confirmation_proof_refs: [],
              },
            },
          }),
        },
        handoffs: {
          offer: async (payload, options) => {
            const outcome = await assistant.handoffs.offer(payload, options);
            if (outcome.operation_status !== "accepted") {
              throw new Error(`offer:${JSON.stringify(outcome)}`);
            }
            return outcome;
          },
          resolveTarget: async (payload, options) => {
            const outcome = await assistant.handoffs.resolveTarget(
              payload,
              options,
            );
            if (outcome.operation_status !== "accepted") {
              throw new Error(`resolve:${JSON.stringify(outcome)}`);
            }
            return outcome;
          },
          getHandoff: (handoffId, options) =>
            assistant.queries.getHandoff(handoffId, options),
        },
        waiter: new PollingAuxiliaryHandoffWaiter({
          queries: assistant.queries,
          poll_interval_ms: 20,
        }),
        state: invocationState,
      });

      const invocation = invocationPort.invoke({
        invocation_id: "invocation-http-loop",
        original_handoff_id: "handoff-original-owned-by-assistant",
        thread_id: "thread-http-loop",
        capability_id: declaration.declaration_id,
        version_constraint: "1.0.0",
        input: {
          title: "客户项目需求",
          content: {
            media_type: "text/markdown",
            text: "# 客户项目需求",
          },
        },
        reason: "建立共享需求文档",
        deadline: new Date(Date.now() + 60_000).toISOString(),
      }, new AbortController().signal);
      const incoming = await within(providerIncoming.next(), 3_000, async () => {
        const events = await assistant.queries.listHandoffEvents(
          "handoff-feishu-http-1",
        );
        return new Error(
          `Provider did not receive the auxiliary Handoff:${JSON.stringify(events)}`,
        );
      });
      if (incoming.done) throw new Error("Provider Gateway closed unexpectedly");
      await providerHost.handle(incoming.value);
      const result = await within(invocation, 3_000, async () => {
        const [snapshot, inbox, subscription, run] = await Promise.all([
          assistant.queries.getHandoff("handoff-feishu-http-1"),
          provider.endpoints.listInboxPartitions(PROVIDER.endpoint),
          provider.subscriptions.get(PROVIDER.subscription),
          providerState.getRun(TENANT, "handoff-feishu-http-1"),
        ]);
        return new Error(`Capability invocation stalled:${JSON.stringify({
          snapshot,
          inbox,
          subscription,
          run,
        })}`);
      });

      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "succeeded",
        invocation_id: "invocation-http-loop",
        data: {
          document_token: "doc-http-loop",
          title: "客户项目需求",
          revision: "1",
        },
      });
      if (result.auxiliary_handoff_id === null) {
        throw new Error("expected auxiliary Handoff");
      }
      await expect(
        assistant.queries.getHandoff(result.auxiliary_handoff_id),
      ).resolves.toMatchObject({
        state: {
          lifecycle_state: "result_returned",
          initiator: {
            actor_id: ASSISTANT.actor,
            actor_type: "agent",
          },
          recipient: {
            actor_id: PROVIDER.actor,
            actor_type: "agent",
          },
        },
      });
      expect(backend.createDocument).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(
        /app_secret|access_token|credential_ref|vendor_response/i,
      );
    } finally {
      await providerHost?.close().catch(() => undefined);
      await invocationState?.close().catch(() => undefined);
      await providerStore?.close().catch(() => undefined);
      await service.close();
    }
  }, 30_000);
});
