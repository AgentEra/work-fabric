import { createHash } from "node:crypto";
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
  FeishuCapabilitySchemaRegistry,
  feishuCalendarCapabilityDeclarations,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
  feishuDocumentCapabilityDeclarations,
  feishuMessageCapabilityDeclarations,
  SqliteFeishuCalendarStore,
} from "@work-fabric/provider-feishu";
import { prepareLocalFeishuEnvironment } from "../../../tools/local-feishu-common.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("local Feishu assistant stack", () => {
  it("schedules a group event through members, free/busy, Calendar and one semantic reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-full-stack-"));
    directories.push(directory);
    const capabilitySequence: string[] = [];
    const auxiliaryHandoffIds = (value: unknown): string[] => {
      const found = new Set<string>();
      const pending: unknown[] = [value];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === "string") {
          for (
            const match of current.matchAll(
              /(?:["']?auxiliary_handoff_id["']?\s*:\s*["']?)([A-Za-z0-9._:-]+)/g,
            )
          ) found.add(match[1]!);
        } else if (Array.isArray(current)) {
          pending.push(...current);
        } else if (current !== null && typeof current === "object") {
          const record = current as Record<string, unknown>;
          if (typeof record.auxiliary_handoff_id === "string") {
            found.add(record.auxiliary_handoff_id);
          }
          pending.push(...Object.values(record));
        }
      }
      return [...found];
    };
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
      }
      const item = value as Record<string, unknown>;
      return `{${Object.keys(item).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(item[key])}`
      ).join(",")}}`;
    };
    const schedulingProposal = {
      version: 1,
      title: "Work Fabric 日历联调",
      start_at: "2026-07-30T07:00:00.000Z",
      end_at: "2026-07-30T08:00:00.000Z",
      timezone: "Asia/Shanghai",
      participant_resource_uris: [
        "feishu://user/open-id/ou_1",
        "feishu://user/open-id/ou_2",
        "feishu://user/open-id/ou_3",
      ],
      summary_markdown:
        "明天 15:00–16:00 举行 Work Fabric 日历联调。",
    };
    const proposalDigest = `sha256:${createHash("sha256")
      .update(canonical(schedulingProposal))
      .digest("hex")}`;
    let proposalEvidence: string[] = [];
    const handoffIds: string[] = [];
    const model = await startFakeOpenAiCompatibleServer({
      structuredOutput: {},
      structuredOutputFactory: (request, index) => {
        if (index === 0) {
          capabilitySequence.push("feishu.conversation.members.list");
          return {
            turn_type: "capability_request",
            request_summary: "读取当前群成员",
            context_status: "needs_context",
            context_basis: "当前排期请求缺少受信群成员事实",
            missing_facts: ["当前群成员"],
            response: "",
            invocation_id: "invocation-members-1",
            capability_id: "feishu.conversation.members.list",
            version_constraint: "1.0.0",
            input: {
              conversation: { kind: "current_conversation" },
              page_size: 50,
            },
            reason: "需要获得当前群内的受信成员事实",
            private_state_action: "none",
            private_state: {},
          };
        }
        if (index === 1) {
          const evidence = auxiliaryHandoffIds(request);
          if (evidence.length === 0) {
            throw new Error("members capability evidence was not disclosed");
          }
          capabilitySequence.push("feishu.calendar.freebusy.query");
          return {
            turn_type: "capability_request",
            request_summary: "查询三位群成员的忙闲",
            context_status: "needs_context",
            context_basis: "已有群成员事实，但仍缺少排期所需的忙闲事实",
            missing_facts: ["参与人的忙闲时间"],
            response: "",
            invocation_id: "invocation-freebusy-1",
            capability_id: "feishu.calendar.freebusy.query",
            version_constraint: "1.0.0",
            input: {
              start_at: "2026-07-30T14:00:00+08:00",
              end_at: "2026-07-30T17:00:00+08:00",
              participants: [
                "feishu://user/open-id/ou_1",
                "feishu://user/open-id/ou_2",
                "feishu://user/open-id/ou_3",
              ],
              include_external_calendars: false,
              busy_only: true,
              authority_evidence: {
                capability_result_handoff_ids: [evidence.at(-1)!],
              },
            },
            reason: "需要用成员能力的结果作为用户目标权限证据",
            private_state_action: "none",
            private_state: {},
          };
        }
        if (index === 2) {
          const evidence = auxiliaryHandoffIds(request);
          if (evidence.length < 2) {
            throw new Error("proposal evidence was not disclosed");
          }
          proposalEvidence = evidence;
          return {
            request_summary: "形成共同空闲的一小时日程提案",
            response:
              "排期提案：明天 15:00–16:00 举行 Work Fabric 日历联调，并邀请当前群。请发起人确认。",
            private_state: {
              namespace: "daily-assistant.scheduling/v1",
              expected_version: 0,
              phase: "awaiting_confirmation",
              proposal: schedulingProposal,
              confirmed_proposal_digest: null,
              confirmation_handoff_id: null,
              calendar_result_uri: null,
              capability_result_handoff_ids: evidence,
            },
          };
        }
        if (index === 3) {
          const reviewInput = JSON.stringify(request);
          if (
            !reviewInput.includes("candidate_turn")
            || !reviewInput.includes("capability_transcript")
          ) throw new Error("proposal grounding evidence was not disclosed");
          return {
            request_summary: "形成共同空闲的一小时日程提案",
            response:
              "排期提案：明天 15:00–16:00 举行 Work Fabric 日历联调，并邀请当前群。请发起人确认。",
            private_state: {
              namespace: "daily-assistant.scheduling/v1",
              expected_version: 0,
              phase: "awaiting_confirmation",
              proposal: schedulingProposal,
              confirmed_proposal_digest: null,
              confirmation_handoff_id: null,
              calendar_result_uri: null,
              capability_result_handoff_ids: proposalEvidence,
            },
          };
        }
        if (index === 4) {
          if (
            handoffIds.length < 2 ||
            proposalEvidence.length < 2
          ) throw new Error("confirmed scheduling session was not disclosed");
          capabilitySequence.push("feishu.calendar.event.create");
          return {
            turn_type: "capability_request",
            request_summary: "发起人已确认，创建共同空闲日程",
            context_status: "sufficient",
            context_basis: "确认状态、参与人和时间事实均已具备",
            missing_facts: [],
            response: "",
            invocation_id: "invocation-calendar-create-1",
            capability_id: "feishu.calendar.event.create",
            version_constraint: "1.1.0",
            input: {
              calendar: { kind: "default_calendar" },
              title: "Work Fabric 日历联调",
              start_at: "2026-07-30T15:00:00+08:00",
              end_at: "2026-07-30T16:00:00+08:00",
              time_zone: "Asia/Shanghai",
              attendees: ["feishu://chat/oc-original"],
              notify_attendees: true,
              authority_evidence: {
                session_origin_handoff_id:
                  handoffIds[0],
                confirmation_handoff_id: handoffIds[1],
                proposal_digest: proposalDigest,
                capability_result_handoff_ids: proposalEvidence,
              },
            },
            reason: "原始发起人确认了当前提案",
            private_state_action: "none",
            private_state: {},
          };
        }
        return {
          turn_type: "final",
          request_summary: "日程已创建并邀请当前群",
          context_status: "sufficient",
          context_basis: "日程 Provider 已返回创建结果",
          missing_facts: [],
          response:
            "已创建日程：[Work Fabric 日历联调](https://feishu.example/calendar/event-local-1)，时间为 2026-07-30 15:00–16:00。",
          invocation_id: "",
          capability_id: "",
          version_constraint: "",
          input: {},
          reason: "",
          private_state_action: "update",
          private_state: {
            namespace: "daily-assistant.scheduling/v1",
            expected_version: 1,
            phase: "completed",
            proposal: null,
            confirmed_proposal_digest: proposalDigest,
            confirmation_handoff_id: handoffIds[1],
            calendar_result_uri:
              "feishu://calendar/cal-local/events/event-local-1",
            capability_result_handoff_ids:
              proposalEvidence,
          },
        };
      },
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
      `WORK_FABRIC_FEISHU_CURSOR_SECRET=${"h".repeat(32)}`,
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
    const eventEpoch = Date.now();
    const commandResponses: unknown[] = [];
    const workerObservations: AgentlyProcessDriverObservation[] = [];
    const invocationIdFor = (capabilityId: string): string | undefined => {
      for (const observation of workerObservations) {
        for (const line of observation.stdout.trim().split("\n")) {
          if (line.length === 0) continue;
          const record = JSON.parse(line) as {
            command_id?: unknown;
            request?: { capability_id?: unknown };
          };
          if (
            record.request?.capability_id === capabilityId &&
            typeof record.command_id === "string"
          ) {
            return `invocation-${record.command_id}`;
          }
        }
      }
      return undefined;
    };
    let externalEventCreates = 0;
    let attendeeMutations = 0;
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
          commandResponses.push(body);
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
        url.pathname === "/open-apis/im/v1/chats/oc-original/members"
      ) {
        return Response.json({
          code: 0,
          data: {
            items: [
              { member_id: "ou_1", member_id_type: "open_id", name: "甲" },
              { member_id: "ou_2", member_id_type: "open_id", name: "乙" },
              { member_id: "ou_3", member_id_type: "open_id", name: "丙" },
            ],
            has_more: false,
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/open-apis/calendar/v4/freebusy/batch"
      ) {
        return Response.json({
          code: 0,
          data: {
            freebusy_list: [
              {
                user_id: "ou_1",
                freebusy_list: [{
                  start_time: "2026-07-30T14:00:00+08:00",
                  end_time: "2026-07-30T15:00:00+08:00",
                }],
              },
              {
                user_id: "ou_2",
                freebusy_list: [{
                  start_time: "2026-07-30T16:00:00+08:00",
                  end_time: "2026-07-30T17:00:00+08:00",
                }],
              },
              { user_id: "ou_3", freebusy_list: [] },
            ],
          },
        });
      }
      if (
        request.method === "POST" &&
        /^\/open-apis\/calendar\/v4\/calendars\/cal-local\/events$/.test(
          url.pathname,
        )
      ) {
        externalEventCreates += 1;
        return Response.json({
          code: 0,
          data: {
            event: {
              event_id: "event-local-1",
              summary: "Work Fabric 日历联调",
              start_time: {
                timestamp: String(
                  Math.floor(
                    Date.parse("2026-07-30T15:00:00+08:00") / 1_000,
                  ),
                ),
                timezone: "Asia/Shanghai",
              },
              end_time: {
                timestamp: String(
                  Math.floor(
                    Date.parse("2026-07-30T16:00:00+08:00") / 1_000,
                  ),
                ),
                timezone: "Asia/Shanghai",
              },
              app_link: "https://feishu.example/calendar/event-local-1",
              create_time: String(Math.floor(eventEpoch / 1_000)),
              update_time: String(Math.floor(eventEpoch / 1_000)),
            },
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname ===
          "/open-apis/calendar/v4/calendars/cal-local/events/event-local-1/attendees"
      ) {
        attendeeMutations += 1;
        return Response.json({
          code: 0,
          data: {
            attendees: [{
              type: "chat",
              attendee_id: "oc-original",
            }],
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
      if (providerConfig.provider.state.type !== "sqlite") {
        throw new Error("calendar E2E requires SQLite Provider state");
      }
      const calendarStore = new SqliteFeishuCalendarStore(
        providerConfig.provider.state,
      );
      await calendarStore.bind({
        tenant_id: "tenant-local",
        alias: "calendar-e2e",
        resource_uri: "feishu://calendar/cal-local",
        external_calendar_id: "cal-local",
        calendar_type: "shared",
        access_role: "owner",
        is_default: true,
        active: true,
        bound_by_principal_id: "principal-work-fabric-admin",
        created_at: new Date(eventEpoch).toISOString(),
        updated_at: new Date(eventEpoch).toISOString(),
      }, 0);
      await calendarStore.close();
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
              : facet.facet === "calendar"
                ? feishuCalendarCapabilityDeclarations()
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
        new FeishuCapabilitySchemaRegistry(),
      ).list(["feishu."], new AbortController().signal)).resolves.toHaveLength(16);
      client.snapshot = {
        ...client.snapshot,
        state: "connected",
        code: "connected",
      };
      const inboundEvent = {
        schema: "2.0",
        header: {
          event_id: "event-full-stack-1",
          event_type: "im.message.receive_v1",
          create_time: String(eventEpoch),
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
              text:
                "@_user_1 请在明天下午 14:00–17:00 找出群内三位成员共同空闲的一小时，创建 Work Fabric 日历联调并邀请当前群",
            }),
            mentions: [{
              key: "@_user_1",
              id: { open_id: "ou-bot" },
              name: "Work Fabric",
            }],
          },
        },
      } as const;
      await expect(client.emit(inboundEvent)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
      });
      await expect(client.emit(inboundEvent)).resolves.toMatchObject({
        accepted: true,
        duplicate: true,
      });
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
        expect(model.requests).toHaveLength(4);
        expect(externalEventCreates).toBe(0);
        const proposalRun =
          handoffIds[0] === undefined || agentState === undefined
            ? null
            : await agentState.getRun(
                "tenant-local",
                handoffIds[0],
              );
        expect(sent, JSON.stringify({
          handoffIds,
          proposalRun,
          workerObservations,
          commandResponses,
        })).toHaveLength(1);
        const proposalContent = JSON.parse(
          String(sent[0]!.content),
        ) as {
          zh_cn: { content: Array<Array<{ text: string }>> };
        };
        expect(proposalContent.zh_cn.content[0]?.[0]?.text).toContain(
          '<at user_id="ou-human">发起人</at>',
        );
      }, 20_000);
      const confirmationEvent = {
        ...inboundEvent,
        header: {
          ...inboundEvent.header,
          event_id: "event-full-stack-confirmation-1",
        },
        event: {
          ...inboundEvent.event,
          message: {
            ...inboundEvent.event.message,
            message_id: "om-full-stack-confirmation-1",
            content: JSON.stringify({
              text: "@_user_1 可以，就这么安排",
            }),
          },
        },
      } as const;
      await expect(client.emit(confirmationEvent)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
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
        const confirmationHandoffId = handoffIds[1];
        const run = confirmationHandoffId === undefined ||
            agentState === undefined
          ? null
          : await agentState.getRun(
              "tenant-local",
              confirmationHandoffId,
            );
        const invocation =
          confirmationHandoffId === undefined ||
              agentState === undefined ||
              invocationIdFor("feishu.calendar.event.create") === undefined
            ? null
            : await agentState.getInvocation(
                "tenant-local",
                confirmationHandoffId,
                invocationIdFor("feishu.calendar.event.create")!,
              );
        expect(externalEventCreates, JSON.stringify({
          model_requests: model.requests,
          commandResponses,
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
        expect(attendeeMutations).toBe(1);
        expect(capabilitySequence).toEqual([
          "feishu.conversation.members.list",
          "feishu.calendar.freebusy.query",
          "feishu.calendar.event.create",
        ]);
        expect(model.requests, JSON.stringify({
          sent,
          handoffIds,
          workerObservations,
          run,
          invocation,
        })).toHaveLength(5);
        expect(sent).toHaveLength(2);
        expect(JSON.stringify(sent[1])).toContain(
          "https://feishu.example/calendar/event-local-1",
        );
        expect(JSON.stringify(sent)).not.toMatch(
          /handoff-|State:|offered|accepted/,
        );
      }, 20_000);
      const originalHandoff = await agentClient.queries.getHandoff(
        handoffIds[0]!,
      );
      expect(originalHandoff.state.package.context).toBeNull();
      if (agentState === undefined) throw new Error("expected Agent state");
      const membersInvocation = await agentState.getInvocation(
        "tenant-local",
        handoffIds[0]!,
        invocationIdFor("feishu.conversation.members.list")!,
      );
      const freeBusyInvocation = await agentState.getInvocation(
        "tenant-local",
        handoffIds[0]!,
        invocationIdFor("feishu.calendar.freebusy.query")!,
      );
      const createInvocation = await agentState.getInvocation(
        "tenant-local",
        handoffIds[1]!,
        invocationIdFor("feishu.calendar.event.create")!,
      );
      expect(JSON.stringify(membersInvocation?.result)).toContain(
        "feishu://user/open-id/ou_3",
      );
      expect(JSON.stringify(freeBusyInvocation?.result)).toContain(
        "2026-07-30T14:00:00+08:00",
      );
      expect(JSON.stringify(createInvocation?.result)).toContain(
        "feishu://calendar/cal-local/events/event-local-1",
      );
      expect(JSON.stringify(originalHandoff.state.result)).toContain(
        "text/markdown",
      );
      expect(JSON.stringify(originalHandoff.state.result)).toContain(
        "请发起人确认",
      );
      const confirmationHandoff =
        await agentClient.queries.getHandoff(handoffIds[1]!);
      expect(JSON.stringify(confirmationHandoff.state.result)).toContain(
        "https://feishu.example/calendar/event-local-1",
      );
      expect(workerObservations.some((observation) =>
        observation.task_json.includes(
          '"active_session":{"version":1',
        ) &&
        observation.task_json.includes(
          `"handoff_id":"${handoffIds[1]}"`,
        )
      )).toBe(true);
    } finally {
      await agent?.host.close().catch(() => undefined);
      await provider?.close().catch(() => undefined);
      await service?.close().catch(() => undefined);
      await model.close();
    }
  }, 40_000);
});
