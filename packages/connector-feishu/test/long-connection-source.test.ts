import { describe, expect, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import type { JsonObject } from "@work-fabric/exchange-spi";

import {
  FeishuLongConnectionSource,
  type FeishuLongConnectionClient,
  type FeishuLongConnectionHandler,
} from "../src/index.js";

const body: JsonObject = {
  schema: "2.0",
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

class FakeLongConnection implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  started = 0;
  stopped = 0;
  async start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    this.started += 1;
  }
  async stop(): Promise<void> { this.stopped += 1; }
}

describe("FeishuLongConnectionSource", () => {
  it("uses the same normalizer and durable dedupe without mapping inline", async () => {
    const client = new FakeLongConnection();
    const store = new MemoryConnectorIngressStore();
    const source = new FeishuLongConnectionSource({
      client,
      ingress: store,
      scope: {
        tenant_id: "tenant-1",
        connector_id: "feishu-primary",
        expected_external_tenant_id: "tenant-key-1",
      },
      clock: { now: () => "2026-07-16T00:00:01Z" },
    });
    await source.start();
    expect(client.started).toBe(1);
    await expect(client.handler?.(body)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    });
    await expect(client.handler?.(body)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
    const page = await store.list({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    await source.stop();
    expect(client.stopped).toBe(1);
  });
});
