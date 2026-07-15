import { describe, expect, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import type { ConnectorIngressStore } from "@work-fabric/connector-spi";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
  type FeishuWebhookBinding,
} from "../src/index.js";

const binding: FeishuWebhookBinding = {
  route_connector_id: "primary",
  tenant_id: "tenant-1",
  connector_id: "feishu-primary",
  external_tenant_id: "tenant-key-1",
  credential_ref: "credential-ref-1",
};

const event = {
  schema: "2.0",
  token: "verification-value",
  header: {
    event_id: "event-message-1",
    event_type: "im.message.receive_v1",
    create_time: "1784160000000",
    tenant_key: "tenant-key-1",
  },
  event: {
    sender: {
      sender_id: { open_id: "ou-human-1" },
      sender_type: "user",
    },
    message: {
      message_id: "om-message-1",
      chat_id: "oc-chat-1",
      chat_type: "group",
      message_type: "text",
      content: "{\"text\":\"hello\"}",
    },
  },
};

function service(store: ConnectorIngressStore = new MemoryConnectorIngressStore()) {
  return createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(),
    feishu_webhook: {
      ingress: store,
      credential_provider: {
        async loadWebhookCredentials() {
          return { verification_token: "verification-value" };
        },
      },
      binding_resolver: {
        async resolve(routeConnectorId) {
          return routeConnectorId === "primary" ? binding : null;
        },
      },
      clock: {
        now: () => "2026-07-16T00:00:01Z",
        nowEpochSeconds: () => 1_784_160_001,
      },
    },
  }, normalizeHttpServiceConfig({
    feishu_webhook_body_limit_bytes: 64_000,
    feishu_webhook_accept_timeout_ms: 1_000,
  }));
}

describe("Feishu HTTP webhook route", () => {
  it("handles a challenge without touching durable ingress", async () => {
    const store = new MemoryConnectorIngressStore();
    const http = service(store);
    const response = await http.dispatch({
      method: "POST",
      url: "/v1/connectors/feishu/primary/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        type: "url_verification",
        challenge: "challenge-1",
        token: "verification-value",
      }),
    });
    expect(response.status_code).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-1" });
    await expect(store.list({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      limit: 10,
    })).resolves.toEqual({ items: [] });
    await http.close();
  });

  it("acknowledges only after durable accept and deduplicates retries", async () => {
    const store = new MemoryConnectorIngressStore();
    const http = service(store);
    for (const duplicate of [false, true]) {
      const response = await http.dispatch({
        method: "POST",
        url: "/v1/connectors/feishu/primary/events",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(event),
      });
      expect(response.status_code).toBe(200);
      expect(response.json()).toMatchObject({ accepted: true, duplicate });
    }
    const page = await store.list({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.envelope.dedupe_key).toBe("message:om-message-1");
    await http.close();
  });

  it("rejects invalid verification and returns retryable failure on store errors", async () => {
    const invalid = service();
    const rejected = await invalid.dispatch({
      method: "POST",
      url: "/v1/connectors/feishu/primary/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...event, token: "wrong" }),
    });
    expect(rejected.status_code).toBe(401);
    await invalid.close();

    const failingStore = new Proxy(new MemoryConnectorIngressStore(), {
      get(target, property, receiver) {
        if (property === "accept") return async () => { throw new Error("offline"); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ConnectorIngressStore;
    const unavailable = service(failingStore);
    const failed = await unavailable.dispatch({
      method: "POST",
      url: "/v1/connectors/feishu/primary/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(event),
    });
    expect(failed.status_code).toBe(503);
    expect(failed.headers["retry-after"]).toBeDefined();
    await unavailable.close();
  });
});
