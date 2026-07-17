import type {
  FeishuLongConnectionAcceptance,
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionHandler,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";
import type { JsonObject } from "@work-fabric/exchange-spi";
import { describe, expect, it } from "vitest";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

class FakeLongConnectionClient implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  snapshot: FeishuLongConnectionStatus = {
    state: "connecting",
    code: "connecting",
    reconnect_attempts: 0,
    changed_at: "2026-07-17T00:00:00.000Z",
  };

  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  status(): FeishuLongConnectionStatus {
    return { ...this.snapshot };
  }

  stop(): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      state: "stopped",
      code: "stopped",
    };
    return Promise.resolve();
  }

  emit(body: JsonObject): Promise<FeishuLongConnectionAcceptance> {
    if (this.handler === undefined) throw new Error("fake_not_started");
    return this.handler(body);
  }
}

class FakeLongConnectionClientFactory
implements FeishuLongConnectionClientFactory {
  readonly clients: FakeLongConnectionClient[] = [];

  create(): FeishuLongConnectionClient {
    const client = new FakeLongConnectionClient();
    this.clients.push(client);
    return client;
  }
}

describe("Feishu long connection collaboration channel E2E", () => {
  it("connects one duplicate-safe explicit mention to durable ingress, one Intake Handoff, and both chat routes", async () => {
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
    const longConnections = new FakeLongConnectionClientFactory();
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
      await expect(client.emit(event)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
      });
      await expect(client.emit(event)).resolves.toMatchObject({
        accepted: true,
        duplicate: true,
      });

      const deadline = Date.now() + 4_000;
      while (sent.length < 2 && Date.now() < deadline) {
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
      expect(sent.map((item) => item.receive_id).sort()).toEqual([
        "oc-original",
        "oc-project",
      ]);
      expect(sent.every((item) => item.msg_type === "text")).toBe(true);
      expect(localRequests.some((request) =>
        request.pathname.startsWith("/v1/connectors/feishu/")
      )).toBe(false);
    } finally {
      await service.close();
    }

    expect(longConnections.clients).toHaveLength(1);
    expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
  }, 10_000);
});
