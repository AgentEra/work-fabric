import { describe, expect, it } from "vitest";

import { snapshotFeishuSdkEvent } from "../src/sdk-event-boundary.js";

function callback(): Record<string | symbol, unknown> {
  return {
    event_id: "event-1",
    event_type: "im.message.receive_v1",
    create_time: "1784160000000",
    tenant_key: "tenant-key-1",
    sender: {
      sender_id: { open_id: "ou-human" },
      sender_type: "user",
    },
    message: {
      message_id: "om-1",
      chat_id: "oc-1",
      chat_type: "group",
      message_type: "text",
      content: "{\"text\":\"hello\"}",
    },
  };
}

function withSdkEventType(
  input: Record<string | symbol, unknown>,
  value = "im.message.receive_v1",
): Record<string | symbol, unknown> {
  Object.defineProperty(input, Symbol("event-type"), {
    enumerable: true,
    configurable: true,
    value,
  });
  return input;
}

describe("snapshotFeishuSdkEvent", () => {
  it("accepts and removes the official top-level SDK event-type symbol", () => {
    const result = snapshotFeishuSdkEvent(withSdkEventType(callback()));

    expect(Reflect.ownKeys(result).every((key) => typeof key === "string"))
      .toBe(true);
    expect(result.event_type).toBe("im.message.receive_v1");
  });

  it.each([
    ["unknown top-level symbol", () => {
      const input = callback();
      Object.defineProperty(input, Symbol("unknown"), {
        enumerable: true,
        value: "im.message.receive_v1",
      });
      return input;
    }],
    ["mismatched SDK event type", () => withSdkEventType(callback(), "other.event")],
    ["multiple top-level symbols", () => {
      const input = withSdkEventType(callback());
      Object.defineProperty(input, Symbol("event-type"), {
        enumerable: true,
        value: "im.message.receive_v1",
      });
      return input;
    }],
    ["nested symbol", () => {
      const input = withSdkEventType(callback());
      Object.defineProperty(input.message as object, Symbol("event-type"), {
        enumerable: true,
        value: "im.message.receive_v1",
      });
      return input;
    }],
    ["SDK symbol accessor", () => {
      const input = callback();
      Object.defineProperty(input, Symbol("event-type"), {
        enumerable: true,
        get: () => "im.message.receive_v1",
      });
      return input;
    }],
    ["hostile proxy", () => new Proxy(withSdkEventType(callback()), {
      ownKeys() {
        throw new Error("escaped_proxy_error");
      },
    })],
  ])("rejects %s", (_name, create) => {
    expect(() => snapshotFeishuSdkEvent(create())).toThrow(
      new TypeError("feishu_long_connection_event_invalid"),
    );
  });
});
