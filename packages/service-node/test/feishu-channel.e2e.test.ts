import { describe, expect, it } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

describe("Feishu collaboration channel E2E", () => {
  it("connects an explicit mention without fabricating an assistant reply before a Result", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const localResponses: Array<{ status: number; body: string }> = [];
    const systemFetch = globalThis.fetch.bind(globalThis);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname !== "open.feishu.cn") {
        const response = await systemFetch(input, init);
        localResponses.push({ status: response.status, body: await response.clone().text() });
        return response;
      }
      if (url.pathname.includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), { status: 200 });
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om-notification-1" } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const identity = { authentication_evidence: { bearer_token: "connector-token" }, principal: { principal_id: "principal-connector", tenant_id: "tenant-local", actor_claims: [{ actor_id: "actor-human", actor_type: "human" as const, endpoint_ids: ["endpoint-human"] }], attributes: {} } };
    const offerRule = { tenant_id: "tenant-local", principal_id: "principal-connector", actor_id: "actor-human", actor_type: "human" as const, endpoint_id: "endpoint-human", action: "workfabric.handoff.offer.v1", resource_id: null };
    const ingressRule = { ...offerRule, action: "workfabric.operations.connector-ingress.read.v1", resource_id: "feishu-primary" };
    const plugin = {
      connector_id: "feishu-primary", external_tenant_id: "tenant-key", bot_open_id: "ou-bot",
      credentials: { app_id: "app", app_secret: "secret", verification_token: "verify", work_fabric_access_token: "connector-token" },
      inbound: { enabled: true, transport: "webhook", route_id: "primary", mention_only: true, intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" } },
      outbound: {
        enabled: true,
        default_render_mode: "text",
        channels: {
          project: { receive_id_type: "chat_id", receive_id: "oc-project" },
          outsider: { receive_id_type: "chat_id", receive_id: "oc-outsider" },
        },
        subscriptions: {
          project: { channel_ref: "project", owner: { actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }, filter: { event_types: ["workfabric.handoff.offered.v1"] } },
          outsider: { channel_ref: "outsider", owner: { actor_id: "actor-outsider", actor_type: "human", endpoint_id: "endpoint-outsider" }, filter: { event_types: ["workfabric.handoff.offered.v1"] } },
        },
      },
      identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
      worker: { poll_interval_ms: 10, lease_seconds: 30, batch_limit: 10, max_attempts: 3 },
    };
    const service = await composeNodeService(parseServiceConfig({ storage_profile: "memory-demo", development_mode: true, tenant_id: "tenant-local", exchange_id: "exchange-local", cursor_secret: "x".repeat(32), identities: [identity], authority_rules: [offerRule, ingressRule], listen: { host: "127.0.0.1", port: 0 } }), { configuration_revision: "e2e", plugins: { "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: plugin } }, fetch });
    await service.listen();
    await service.start();
    try {
      const callback = await service.http.dispatch({ method: "POST", url: "/v1/connectors/feishu/feishu-primary/events", headers: { "content-type": "application/json" }, payload: {
        schema: "2.0", header: { event_id: "event-1", event_type: "im.message.receive_v1", create_time: "1784073600000", tenant_key: "tenant-key", token: "verify" },
        event: { sender: { sender_id: { open_id: "ou-human" }, sender_type: "user" }, message: { message_id: "om-1", chat_id: "oc-original", chat_type: "group", message_type: "text", content: '{"text":"@_user_1 create a requirement"}', mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Work Fabric" }] } },
      } });
      expect(callback.status_code).toBe(200);
      const duplicate = await service.http.dispatch({ method: "POST", url: "/v1/connectors/feishu/feishu-primary/events", headers: { "content-type": "application/json" }, payload: {
        schema: "2.0", header: { event_id: "event-1", event_type: "im.message.receive_v1", create_time: "1784073600000", tenant_key: "tenant-key", token: "verify" },
        event: { sender: { sender_id: { open_id: "ou-human" }, sender_type: "user" }, message: { message_id: "om-1", chat_id: "oc-original", chat_type: "group", message_type: "text", content: '{"text":"@_user_1 create a requirement"}', mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Work Fabric" }] } },
      } });
      expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
      const deadline = Date.now() + 4_000;
      while (sent.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const ingress = await service.http.dispatch({ method: "GET", url: "/v1/operations/connectors/feishu-primary/ingress", headers: { authorization: "Bearer connector-token", "x-wf-actor-id": "actor-human", "x-wf-endpoint-id": "endpoint-human" } });
      if (sent.length < 1) throw new Error(JSON.stringify({ ingress: ingress.json(), localResponses, sent }));
      expect(sent.map((item) => item.receive_id)).toEqual(["oc-project"]);
      expect(sent.every((item) => item.msg_type === "text")).toBe(true);
    } finally { await service.close(); }
  }, 10_000);
});
