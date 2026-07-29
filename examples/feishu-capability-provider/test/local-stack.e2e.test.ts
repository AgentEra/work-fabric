import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  AgentlyProcessDriver,
  validateAgentlyRuntimeDriverConfig,
  type AgentlyProcessDriverObservation,
} from "@work-fabric/adapter-agent-runtime-agently";
import { CatalogCapabilityDisclosure } from "@work-fabric/agent-capability-runtime";
import { composeNodeService } from "@work-fabric/service-node";
import {
  BearerTokenProvider,
  WorkFabricClient,
} from "@work-fabric/sdk-typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  composeAgentRuntime,
  createRuntimeStateStore,
  startComposedRuntime,
} from "../../agently-agent-runtime/src/main.js";
import { dailyAssistantEndpointRegistration } from "../../agently-agent-runtime/src/subscription.js";
import {
  FakeFeishuLongConnectionClientFactory,
  eventually,
} from "../../agently-agent-runtime/test/e2e-support.js";
import { startFakeOpenAiCompatibleServer } from "../../agently-agent-runtime/test/fake-openai-compatible-server.js";
import { loadAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";
import { loadNodeConfiguration } from "../../../packages/service-node/src/configuration-loader.js";
import {
  composeFeishuProvider,
} from "../src/composition.js";
import { loadFeishuProviderConfiguration } from "../src/configuration.js";
import { provisionFeishuProviderRecords } from "../src/provision.js";
import {
  enabledFeishuProviderFacets,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
  feishuDocumentCapabilityDeclarations,
  feishuMessageCapabilityDeclarations,
} from "@work-fabric/provider-feishu";
import { prepareLocalFeishuEnvironment } from "../../../tools/local-feishu-common.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("local Feishu assistant stack", () => {
  it("lets the Agent query prior Feishu messages, create one document, and author one semantic reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-full-stack-"));
    directories.push(directory);
    const model = await startFakeOpenAiCompatibleServer({
      structuredOutput: {},
      structuredOutputs: [{
        turn_type: "capability_request",
        request_summary: "需要读取当前会话的历史消息",
        response: "",
        invocation_id: "invocation-history-1",
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 20,
        },
        reason: "当前请求引用了上面的消息，需要读取有界历史证据",
      }, {
        turn_type: "capability_request",
        request_summary: "需要创建飞书文档",
        response: "",
        invocation_id: "invocation-create-doc-1",
        capability_id: "feishu.document.create",
        version_constraint: "2.0.0",
        input: {
          title: "本地联调需求",
          content: {
            media_type: "text/markdown",
            text: "# 本地联调需求\n这是端到端测试",
          },
        },
        reason: "用户明确要求创建共享文档",
      }, {
        turn_type: "final",
        request_summary: "已总结历史并创建飞书文档",
        response: "你上面提到了项目范围和交付日期；已创建《本地联调需求》：https://feishu.example/docx/doc-local-1",
        invocation_id: "",
        capability_id: "",
        version_constraint: "",
        input: {},
        reason: "",
      }],
    });
    const source = join(directory, "bundle.yaml");
    const resolvedConfig = join(directory, "resolved.yaml");
    const envFile = join(directory, "local.env");
    const original = await readFile(
      resolve("examples/config/local-feishu-assistant.bundle.yaml"),
      "utf8",
    );
    await writeFile(
      source,
      original
        .replaceAll("./var/", `${directory}/`)
        .replace("https://api.deepseek.com", model.baseUrl),
    );
    await writeFile(envFile, [
      `WORK_FABRIC_CURSOR_SECRET=${"c".repeat(32)}`,
      `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
      `WORK_FABRIC_ADMISSION_FINGERPRINT_KEY=${"f".repeat(32)}`,
      `WORK_FABRIC_ADMISSION_GRANT_KEY=${"g".repeat(32)}`,
      "FEISHU_APP_ID=app-id",
      "FEISHU_APP_SECRET=app-secret",
      `FEISHU_CONNECTOR_ACCESS_TOKEN=${"x".repeat(32)}`,
      `INTAKE_AGENT_ACCESS_TOKEN=${"i".repeat(32)}`,
      `FEISHU_PROVIDER_ACCESS_TOKEN=${"p".repeat(32)}`,
      "AGENTLY_MODEL_API_KEY=model-key",
      "FEISHU_EXTERNAL_TENANT_ID=tenant-key",
      "FEISHU_BOT_OPEN_ID=ou-bot",
      "WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true",
    ].join("\n"));
    const environment = await prepareLocalFeishuEnvironment({
      WORK_FABRIC_ENV_FILE: envFile,
      WORK_FABRIC_CONFIG: source,
      WORK_FABRIC_RESOLVED_CONFIG: resolvedConfig,
    });

    const sent: Record<string, unknown>[] = [];
    const historyQueries: string[] = [];
    const documentAuthorizations: Array<{
      readonly represented_actor_id: string;
      readonly operation: string;
    }> = [];
    const handoffIds: string[] = [];
    const workerObservations: AgentlyProcessDriverObservation[] = [];
    let documentsCreated = 0;
    const systemFetch = globalThis.fetch.bind(globalThis);
    const feishuFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "open.feishu.cn") {
        const response = await systemFetch(input, init);
        if (
          request.method === "POST" &&
          url.pathname === "/v1/commands"
        ) {
          const body = await response.clone().json() as {
            resource?: { resource_id?: unknown } | null;
          };
          const id = body.resource?.resource_id;
          if (typeof id === "string" && !handoffIds.includes(id)) {
            handoffIds.push(id);
          }
        }
        return response;
      }
      if (url.pathname.includes("tenant_access_token")) {
        return Response.json({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/contact/v3/users/batch")) {
        return Response.json({
          code: 0,
          data: {
            items: [{
              open_id: "ou-human",
              status: { is_activated: true, is_exited: false },
            }],
          },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/open-apis/drive/v1/files"
      ) {
        return Response.json({
          code: 0,
          data: { files: [], has_more: false },
        });
      }
      if (url.pathname.includes("/permissions/")) {
        return Response.json({
          code: 0,
          data: {
            permission_public: { link_share_entity: "tenant_readable" },
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/open-apis/docx/v1/documents"
      ) {
        documentsCreated += 1;
        const body = JSON.parse(await request.clone().text()) as {
          title: string;
        };
        return Response.json({
          code: 0,
          data: {
            document: {
              document_id: "doc-local-1",
              title: body.title,
              url: "https://feishu.example/docx/doc-local-1",
            },
          },
        });
      }
      if (url.pathname.endsWith("/children")) {
        return Response.json({
          code: 0,
          data: { document_revision_id: 2 },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/open-apis/im/v1/messages"
      ) {
        historyQueries.push(url.toString());
        return Response.json({
          code: 0,
          data: {
            items: [{
              message_id: "om-full-stack-1",
              msg_type: "text",
              create_time: "1784073600000",
              update_time: "1784073600000",
              deleted: false,
              updated: false,
              chat_id: "oc-original",
              sender: {
                id: "ou-human",
                id_type: "open_id",
                sender_type: "user",
                tenant_key: "tenant-key",
              },
              body: {
                content: JSON.stringify({
                  text: "@_user_1 总结上面的消息，并创建一份本地联调需求文档",
                }),
              },
            }, {
              message_id: "om-history-scope",
              msg_type: "text",
              create_time: "1784070000000",
              update_time: "1784070000000",
              deleted: false,
              updated: false,
              chat_id: "oc-original",
              sender: {
                id: "ou-human",
                id_type: "open_id",
                sender_type: "user",
                tenant_key: "tenant-key",
              },
              body: {
                content: JSON.stringify({ text: "项目范围是飞书协作接入" }),
              },
            }, {
              message_id: "om-history-delivery",
              msg_type: "text",
              create_time: "1784066400000",
              update_time: "1784066400000",
              deleted: false,
              updated: false,
              chat_id: "oc-original",
              sender: {
                id: "ou-human",
                id_type: "open_id",
                sender_type: "user",
                tenant_key: "tenant-key",
              },
              body: {
                content: JSON.stringify({ text: "交付日期定在本周五" }),
              },
            }],
            has_more: false,
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/open-apis/im/v1/messages"
      ) {
        sent.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
        return Response.json({
          code: 0,
          data: { message_id: `om-reply-${sent.length}` },
        });
      }
      return Response.json({ code: 0, data: {} });
    }) as typeof globalThis.fetch;
    const longConnections = new FakeFeishuLongConnectionClientFactory();
    let service: Awaited<ReturnType<typeof composeNodeService>> | undefined;
    let provider: Awaited<ReturnType<typeof composeFeishuProvider>> | undefined;
    let agent: Awaited<ReturnType<typeof composeAgentRuntime>> | undefined;
    let agentState: ReturnType<typeof createRuntimeStateStore> | undefined;
    try {
      const serviceConfig = await loadNodeConfiguration(environment);
      service = await composeNodeService(serviceConfig.service, {
        configuration_revision: serviceConfig.revision,
        plugins: serviceConfig.plugins,
        admission: serviceConfig.admission,
        agent_runtime_authority: serviceConfig.agent_runtime_authority,
        fetch: feishuFetch,
        feishu_long_connection_client_factory: longConnections,
      });
      const { origin } = await service.listen();
      await service.start();
      const admin = new WorkFabricClient({
        baseUrl: origin,
        tenantId: "tenant-local",
        exchangeId: "exchange-local",
        representation: {
          actorId: "actor-work-fabric-admin",
          endpointId: "endpoint-work-fabric-admin",
        },
        authentication: new BearerTokenProvider(
          environment.WORK_FABRIC_ADMIN_TOKEN!,
        ),
      });
      await admin.endpoints.provision(
        "endpoint-intake-agent",
        dailyAssistantEndpointRegistration(),
      );
      const providerConfig = await loadFeishuProviderConfiguration({
        environment,
      });
      await provisionFeishuProviderRecords({
        endpoints: admin.endpoints,
        citizens: admin.citizens,
        participant: providerConfig.participant,
        capability_facets: enabledFeishuProviderFacets(
          providerConfig.provider,
        ).map((facet) => ({
          citizen: facet.citizen,
          declarations: facet.facet === "message"
            ? feishuMessageCapabilityDeclarations()
            : facet.facet === "document"
              ? feishuDocumentCapabilityDeclarations()
              : feishuCapabilityDeclarations(),
        })),
        context_citizen: providerConfig.provider.context_citizen,
        context_declarations: feishuContextDeclarations(),
      });
      provider = await composeFeishuProvider({
        ...providerConfig,
        service: {
          ...providerConfig.service,
          work_fabric: {
            ...providerConfig.service.work_fabric,
            base_url: origin,
          },
        },
      }, environment, feishuFetch, {
        document_access: {
          async authorize(input) {
            documentAuthorizations.push({
              represented_actor_id: input.represented_actor_id,
              operation: input.operation,
            });
            return {
              decision: "allow",
              evidence_ref: "native-acl-e2e-1",
              valid_until: input.expires_at,
            };
          },
        },
        placement: {
          async resolve() {
            return {
              resource_uri: "feishu://drive/folder/folder-local",
            };
          },
        },
      });
      await provider.start();
      const agentConfig = await loadAgentRuntimeConfiguration({ environment });
      const loadedAgent = {
        ...agentConfig,
        driver: {
          ...agentConfig.driver,
          config: validateAgentlyRuntimeDriverConfig(
            {
              ...agentConfig.driver.config,
              development_mode: true,
            },
            "plugins.instances.agently-primary.config",
            { config_directory: process.cwd() },
          ),
        },
        service: {
          ...agentConfig.service,
          work_fabric: {
            ...agentConfig.service.work_fabric,
            base_url: origin,
          },
        },
      };
      const driver = new AgentlyProcessDriver(
        loadedAgent.driver.config,
        { observer: (observation) => workerObservations.push(observation) },
      );
      agentState = createRuntimeStateStore(loadedAgent.service.state);
      agent = await composeAgentRuntime(loadedAgent, {
        driver,
        state: agentState,
      });
      await startComposedRuntime(agent);

      const client = longConnections.clients[0]!;
      await expect(new CatalogCapabilityDisclosure(
        new WorkFabricClient({
          baseUrl: origin,
          tenantId: "tenant-local",
          exchangeId: "exchange-local",
          representation: {
            actorId: "actor-intake-agent",
            endpointId: "endpoint-intake-agent",
          },
          authentication: new BearerTokenProvider(
            environment.INTAKE_AGENT_ACCESS_TOKEN!,
          ),
        }).citizens,
      ).list(["feishu."], new AbortController().signal)).resolves.toHaveLength(7);
      client.snapshot = {
        ...client.snapshot,
        state: "connected",
        code: "connected",
      };
      await expect(client.emit({
        schema: "2.0",
        header: {
          event_id: "event-full-stack-1",
          event_type: "im.message.receive_v1",
          create_time: "1784073600000",
          tenant_key: "tenant-key",
        },
        event: {
          sender: {
            sender_id: { open_id: "ou-human" },
            sender_type: "user",
          },
          message: {
            message_id: "om-full-stack-1",
            chat_id: "oc-original",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({
              text: "@_user_1 总结上面的消息，并创建一份本地联调需求文档",
            }),
            mentions: [{
              key: "@_user_1",
              id: { open_id: "ou-bot" },
              name: "Work Fabric",
            }],
          },
        },
      })).resolves.toMatchObject({ accepted: true, duplicate: false });
      const connector = new WorkFabricClient({
        baseUrl: origin,
        tenantId: "tenant-local",
        exchangeId: "exchange-local",
        representation: {
          actorId: "actor-feishu-user",
          endpointId: "endpoint-feishu-user",
        },
        authentication: new BearerTokenProvider(
          environment.FEISHU_CONNECTOR_ACCESS_TOKEN!,
        ),
      });
      const agentClient = new WorkFabricClient({
        baseUrl: origin,
        tenantId: "tenant-local",
        exchangeId: "exchange-local",
        representation: {
          actorId: "actor-intake-agent",
          endpointId: "endpoint-intake-agent",
        },
        authentication: new BearerTokenProvider(
          environment.INTAKE_AGENT_ACCESS_TOKEN!,
        ),
      });
      await eventually(async () => {
        const ingress = await connector.operations.listConnectorIngress({
          connectorId: "feishu-primary",
          limit: 10,
        });
        const inbox = await agentClient.endpoints.listInboxPartitions(
          "endpoint-intake-agent",
        );
        const claimable = await agentClient.endpoints.listClaimableHandoffs(
          "endpoint-intake-agent",
        );
        const run = handoffIds[0] === undefined || agentState === undefined
          ? null
          : await agentState.getRun("tenant-local", handoffIds[0]);
        const invocation =
          handoffIds[0] === undefined || agentState === undefined
            ? null
            : await agentState.getInvocation(
                "tenant-local",
                handoffIds[0],
                "invocation-create-doc-1",
              );
        expect(documentsCreated, JSON.stringify({
          model_requests: model.requests,
          sent,
          handoffIds,
          workerObservations,
          ingress,
          inbox,
          claimable,
          run,
          invocation,
          citizens: {
            capability: provider === undefined ? "missing" : "started",
          },
        })).toBe(1);
        expect(model.requests, JSON.stringify({
          sent,
          handoffIds,
          workerObservations,
          run,
          invocation,
        })).toHaveLength(3);
        expect(sent).toHaveLength(1);
        expect(JSON.stringify(sent[0])).toContain(
          "https://feishu.example/docx/doc-local-1",
        );
        expect(JSON.stringify(sent[0])).not.toMatch(
          /handoff-|State:|offered|accepted/,
        );
      }, 20_000);
      expect(historyQueries).toHaveLength(1);
      expect(documentAuthorizations).toHaveLength(1);
      expect(documentAuthorizations[0]).toEqual({
        represented_actor_id: expect.stringMatching(/^actor_admission_/),
        operation: "create",
      });
      const historyQuery = new URL(historyQueries[0]!);
      expect(Object.fromEntries(historyQuery.searchParams)).toMatchObject({
        container_id_type: "chat",
        container_id: "oc-original",
        sort_type: "ByCreateTimeDesc",
        page_size: "20",
      });
      const originalHandoff = await agentClient.queries.getHandoff(
        handoffIds[0]!,
      );
      expect(originalHandoff.state.package.context).toBeNull();
      if (agentState === undefined) throw new Error("expected Agent state");
      const historyInvocation = await agentState.getInvocation(
        "tenant-local",
        handoffIds[0]!,
        "invocation-history-1",
      );
      const historyEvidence = JSON.stringify(historyInvocation?.result);
      expect(historyEvidence).toContain("om-history-delivery");
      expect(historyEvidence).toContain("om-history-scope");
      expect(historyEvidence).not.toContain(
        "\"message_id\":\"om-full-stack-1\",\"sender\"",
      );
      expect(historyEvidence).toContain("项目范围是飞书协作接入");
      expect(historyEvidence).toContain("交付日期定在本周五");
    } finally {
      await agent?.host.close().catch(() => undefined);
      await provider?.close().catch(() => undefined);
      await service?.close().catch(() => undefined);
      await model.close();
    }
  }, 40_000);
});
