import { describe, expect, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import type { JsonObject } from "@work-fabric/exchange-spi";

import {
  FeishuLongConnectionSource,
  type FeishuLongConnectionClient,
  type FeishuLongConnectionHandler,
  type FeishuLongConnectionStatus,
} from "../src/index.js";

const status: FeishuLongConnectionStatus = {
  state: "connected",
  code: "connected",
  reconnect_attempts: 0,
  changed_at: "2026-07-17T00:00:00.000Z",
};

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
  startError: Error | undefined;
  stopError: Error | undefined;
  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    this.started += 1;
    return this.startError === undefined
      ? Promise.resolve()
      : Promise.reject(this.startError);
  }
  status(): FeishuLongConnectionStatus { return status; }
  stop(): Promise<void> {
    this.stopped += 1;
    return this.stopError === undefined
      ? Promise.resolve()
      : Promise.reject(this.stopError);
  }
}

function createFixture() {
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
  return { client, source, store };
}

describe("FeishuLongConnectionSource", () => {
  it("returns a bounded client status snapshot", () => {
    const client = new FakeLongConnection();

    expect(client.status()).toEqual(status);
  });

  it("starts the client once when started twice", async () => {
    const { client, source } = createFixture();

    await source.start();
    await source.start();

    expect(client.started).toBe(1);
  });

  it("stops the client once when stopped twice", async () => {
    const { client, source } = createFixture();

    await source.start();
    await source.stop();
    await source.stop();

    expect(client.stopped).toBe(1);
  });

  it("releases an owned client once when stopped before start", async () => {
    const { client, source } = createFixture();

    await source.stop();
    await source.stop();

    expect(client.started).toBe(0);
    expect(client.stopped).toBe(1);
  });

  it("retries client release after stop rejects", async () => {
    const { client, source } = createFixture();
    client.stopError = new Error("client stop failed");

    await expect(source.stop()).rejects.toThrow("client stop failed");
    client.stopError = undefined;
    await source.stop();
    await source.stop();

    expect(client.stopped).toBe(2);
  });

  it("stops a client whose start installed resources before rejecting", async () => {
    const { client, source } = createFixture();
    client.startError = new Error("client start failed");

    await expect(source.start()).rejects.toThrow("client start failed");
    await source.stop();

    expect(client.stopped).toBe(1);
  });

  it("uses the same normalizer and durable dedupe without mapping inline", async () => {
    const { client, source, store } = createFixture();

    await source.start();
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
  });
});
