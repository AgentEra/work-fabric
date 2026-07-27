import type { JsonObject } from "@work-fabric/exchange-spi";
import { composeNodeService, parseServiceConfig } from "@work-fabric/service-node";
import { describe, expect, it } from "vitest";

import {
  DAILY_E2E,
  partitionId,
  provisionDailyAssistant,
  runtimeRun,
  startDailyAssistantWorkFabric,
  startRealAgentlyRuntime,
} from "./daily-assistant-e2e-builders.js";
import {
  FakeFeishuLongConnectionClientFactory,
  NeutralE2eFixture,
  eventually,
} from "./e2e-support.js";
import { startFakeOpenAiCompatibleServer } from "./fake-openai-compatible-server.js";

const dailyFixtureSecrets = Object.freeze([
  DAILY_E2E.runtimeToken,
  DAILY_E2E.modelToken,
  DAILY_E2E.adminToken,
  DAILY_E2E.humanToken,
]);

function assertNoDailyFixtureSecrets(...surfaces: readonly unknown[]): void {
  for (const surface of surfaces) {
    const text = typeof surface === "string" ? surface : JSON.stringify(surface);
    for (const secret of dailyFixtureSecrets) expect(text).not.toContain(secret);
  }
}

describe("Feishu long connection collaboration channel E2E", () => {
  it("connects one duplicate-safe explicit mention to durable ingress and both chat routes without a Webhook endpoint", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const localRequests: Array<{
      method: string;
      pathname: string;
      body: unknown;
      status: number;
      response: unknown;
    }> = [];
    const systemFetch = globalThis.fetch.bind(globalThis);
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const requestBody = request.method === "GET"
        ? undefined
        : JSON.parse(await request.clone().text()) as unknown;
      if (url.hostname !== "open.feishu.cn") {
        const response = await systemFetch(input, init);
        const responseText = await response.clone().text();
        localRequests.push({
          method: request.method,
          pathname: url.pathname,
          body: requestBody,
          status: response.status,
          response: responseText.length === 0
            ? undefined
            : JSON.parse(responseText) as unknown,
        });
        return response;
      }
      if (url.pathname.includes("tenant_access_token")) {
        return new Response(JSON.stringify({
          code: 0,
          msg: "success",
          tenant_access_token: "tenant-token",
          expire: 7200,
        }), { status: 200 });
      }
      sent.push(requestBody as Record<string, unknown>);
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: { message_id: `om-notification-${sent.length}` },
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const identity = {
      authentication_evidence: { bearer_token: "connector-token" },
      principal: {
        principal_id: "principal-connector",
        tenant_id: "tenant-local",
        actor_claims: [{
          actor_id: "actor-human",
          actor_type: "human" as const,
          endpoint_ids: ["endpoint-human"],
        }],
        attributes: {},
      },
    };
    const offerRule = {
      tenant_id: "tenant-local",
      principal_id: "principal-connector",
      actor_id: "actor-human",
      actor_type: "human" as const,
      endpoint_id: "endpoint-human",
      action: "workfabric.handoff.offer.v1",
      resource_id: null,
    };
    const ingressRule = {
      ...offerRule,
      action: "workfabric.operations.connector-ingress.read.v1",
      resource_id: "feishu-primary",
    };
    const plugin = {
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key",
      bot_open_id: "ou-bot",
      credentials: {
        app_id: "app",
        app_secret: "secret",
        work_fabric_access_token: "connector-token",
      },
      inbound: {
        enabled: true,
        transport: "long_connection",
        mention_only: true,
        intake_target: {
          actor_id: "actor-agent",
          endpoint_id: "endpoint-agent",
        },
      },
      outbound: {
        enabled: true,
        default_render_mode: "text",
        channels: {
          project: { receive_id_type: "chat_id", receive_id: "oc-project" },
        },
        subscriptions: {
          project: {
            channel_ref: "project",
            owner: {
              actor_id: "actor-human",
              actor_type: "human",
              endpoint_id: "endpoint-human",
            },
            filter: { event_types: ["workfabric.handoff.offered.v1"] },
          },
        },
      },
      identities: [{
        external_open_id: "ou-human",
        actor_id: "actor-human",
        actor_type: "human",
        endpoint_id: "endpoint-human",
      }],
      worker: {
        poll_interval_ms: 10,
        lease_seconds: 30,
        batch_limit: 10,
        max_attempts: 3,
      },
    };
    const longConnections = new FakeFeishuLongConnectionClientFactory();
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      role: "all",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [offerRule, ingressRule],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      configuration_revision: "e2e:long-connection",
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: plugin,
        },
      },
      fetch,
      feishu_long_connection_client_factory: longConnections,
    });
    await service.listen();
    await service.start();
    const client = longConnections.clients[0];
    if (client === undefined) throw new Error("fake_client_not_created");
    client.snapshot = {
      ...client.snapshot,
      state: "connected",
      code: "connected",
    };
    const event: JsonObject = {
      schema: "2.0",
      header: {
        event_id: "event-1",
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
          message_id: "om-1",
          chat_id: "oc-original",
          chat_type: "group",
          message_type: "text",
          content: '{"text":"@_user_1 create a requirement"}',
          mentions: [{
            key: "@_user_1",
            id: { open_id: "ou-bot" },
            name: "Work Fabric",
          }],
        },
      },
    };

    try {
      const webhookCallback = await service.http.dispatch({
        method: "POST",
        url: "/v1/connectors/feishu/feishu-primary/events",
        headers: { "content-type": "application/json" },
        payload: event,
      });
      expect(webhookCallback.status_code).toBe(404);

      await expect(client.emit(event)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
      });
      await expect(client.emit(event)).resolves.toMatchObject({
        accepted: true,
        duplicate: true,
      });

      const deadline = Date.now() + 4_000;
      while (sent.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const ingress = await service.http.dispatch({
        method: "GET",
        url: "/v1/operations/connectors/feishu-primary/ingress",
        headers: {
          authorization: "Bearer connector-token",
          "x-wf-actor-id": "actor-human",
          "x-wf-endpoint-id": "endpoint-human",
        },
      });
      expect(ingress.status_code).toBe(200);
      expect(ingress.json()).toMatchObject({
        items: [{
          connector_id: "feishu-primary",
          external_event_id: "event-1",
          state: "completed",
        }],
      });
      expect((ingress.json() as { items: unknown[] }).items).toHaveLength(1);

      const offers = localRequests.filter((request) =>
        request.method === "POST"
        && request.pathname === "/v1/commands"
        && (request.body as { message_type?: unknown }).message_type
          === "workfabric.handoff.offer.v1"
      );
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        status: 200,
        body: {
          actor_id: "actor-human",
          endpoint_id: "endpoint-human",
          payload: {
            target: { actor_id: "actor-agent" },
            intent: [{ text: "create a requirement" }],
          },
        },
        response: {
          operation_status: "accepted",
          resource: { resource_type: "handoff", resource_version: 1 },
        },
      });
      expect(sent.map((item) => item.receive_id)).toEqual(["oc-project"]);
      expect(sent.every((item) => item.msg_type === "text")).toBe(true);
      expect(localRequests.some((request) =>
        request.pathname.startsWith("/v1/connectors/feishu/")
      )).toBe(false);
    } finally {
      await service.close();
    }

    expect(longConnections.clients).toHaveLength(1);
    expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
    expect(sent).toHaveLength(1);
  }, 10_000);

  it("passes a Feishu mention through the Daily Assistant Runtime and renders its Result", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-feishu-daily-");
    const sent: Array<Record<string, unknown>> = [];
    const longConnections = new FakeFeishuLongConnectionClientFactory();
    const systemFetch = globalThis.fetch.bind(globalThis);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "open.feishu.cn") return systemFetch(input, init);
      if (url.pathname.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "tenant-token", expire: 7200 }), { status: 200 });
      }
      sent.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
      return new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: `om-result-${sent.length}` } }), { status: 200 });
    }) as typeof globalThis.fetch;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: {
        request_summary: "创建一个新需求", response: "需求已整理，建议交给需求分析角色确认", missing_information: ["期望上线日期"],
        handoff_draft_required: true, handoff_draft_reason: "需要专业需求分析", handoff_draft_capability: "requirements.analysis",
        handoff_draft_intent: "梳理需求范围并确认验收标准", handoff_draft_acceptance_criteria: ["范围得到业务方确认"],
      } });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({
        directory: fixture.directory,
        composition: {
          configuration_revision: "e2e:feishu-daily-assistant",
          fetch,
          feishu_long_connection_client_factory: longConnections,
          plugins: {
            "feishu-primary": {
              type: "collaboration-channel.feishu",
              enabled: true,
              config: {
                connector_id: "feishu-primary", external_tenant_id: "tenant-key", bot_open_id: "ou-bot",
                credentials: { app_id: "app", app_secret: "secret", work_fabric_access_token: DAILY_E2E.humanToken },
                inbound: { enabled: true, transport: "long_connection", mention_only: true, intake_target: { actor_id: DAILY_E2E.runtimeActorId, endpoint_id: DAILY_E2E.runtimeEndpointId } },
                outbound: {
                  enabled: true, default_render_mode: "text",
                  channels: { results: { receive_id_type: "chat_id", receive_id: "oc-results" } },
                  subscriptions: {
                    results: {
                      channel_ref: "results",
                      owner: { actor_id: DAILY_E2E.humanActorId, actor_type: "human", endpoint_id: DAILY_E2E.humanEndpointId },
                      filter: { event_types: ["workfabric.handoff.result_returned.v1"] },
                    },
                  },
                },
                identities: [{ external_open_id: "ou-human", actor_id: DAILY_E2E.humanActorId, actor_type: "human", endpoint_id: DAILY_E2E.humanEndpointId }],
                worker: { poll_interval_ms: 10, lease_seconds: 30, batch_limit: 10, max_attempts: 3 },
              },
            },
          },
        },
      });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory });
      fixture.register(() => runtime!.close());
      const client = longConnections.clients[0];
      if (client === undefined) throw new Error("fake long connection did not start");
      client.snapshot = { ...client.snapshot, state: "connected", code: "connected" };
      const mention: JsonObject = {
        schema: "2.0",
        header: { event_id: "event-daily-1", event_type: "im.message.receive_v1", create_time: "1784073600000", tenant_key: "tenant-key" },
        event: {
          sender: { sender_id: { open_id: "ou-human" }, sender_type: "user" },
          message: {
            message_id: "om-daily-1", chat_id: "oc-original", chat_type: "group", message_type: "text",
            content: '{"text":"@_user_1 创建一个新需求"}',
            mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Work Fabric" }],
          },
        },
      };
      await expect(client.emit(mention)).resolves.toMatchObject({ accepted: true, duplicate: false });
      await expect(client.emit(mention)).resolves.toMatchObject({ accepted: true, duplicate: true });
      const handoffId = "handoff-daily-1";
      await eventually(async () => {
        const handoff = await service!.human.queries.getHandoff(handoffId);
        expect(handoff.state.lifecycle_state).toBe("result_returned");
        // Ingress targets the Agent identity.  The Gateway binding and
        // delivery below prove that it was consumed by this exact Endpoint;
        // it deliberately does not make a channel connector choose an
        // execution endpoint when an Agent role later has several Endpoints.
        expect(handoff.state).toMatchObject({ package: { target: { actor_id: DAILY_E2E.runtimeActorId } } });
        expect(await service!.runtime.endpoints.listInboxPartitions(DAILY_E2E.runtimeEndpointId))
          .toMatchObject({ items: [{ partition_id: partitionId(handoffId) }] });
        expect((await runtimeRun(runtime!.statePath, handoffId))?.state).toBe("succeeded");
      }, 15_000);
      // The fake retains only bounded request metadata, never prompt bodies.
      // Replaying the exact same Feishu ingress must therefore still yield one
      // and only one model invocation for this isolated fixture.
      await eventually(async () => expect(model!.requests).toHaveLength(1), 5_000);
      await eventually(async () => {
        expect(sent).toHaveLength(2);
        expect(sent.map((message) => message.receive_id).sort()).toEqual([
          "oc-original",
          "oc-results",
        ]);
        for (const message of sent) {
          const content = JSON.stringify(message);
          expect(content).toContain(
            "需求已整理，建议交给需求分析角色确认",
          );
          expect(content).not.toMatch(
            /workfabric\.handoff|handoff-daily-1|result_returned|State:/,
          );
        }
      }, 10_000);
      const completed = await service.human.queries.getHandoff(handoffId);
      const events = await service.human.queries.listHandoffEvents(handoffId);
      expect(completed.state.child_handoff_id).toBeNull();
      // Ingress is duplicate-safe, delivery reaches the external Runtime once,
      // and neither the public channel payload nor the model fake's deliberately
      // bounded metadata retains a service/runtime/model/human credential.
      assertNoDailyFixtureSecrets(completed, events, model.requests, sent);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
