import { describe, expect, it } from "vitest";

import { reconstructFeishuMessageEvent } from "../src/event-envelope.js";

function validEvent(): Record<string, unknown> {
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
      mentions: [{
        key: "@_user_1",
        id: { open_id: "ou-bot" },
        name: "Work Fabric",
      }],
    },
  };
}

describe("reconstructFeishuMessageEvent", () => {
  it("reconstructs only the normalized message envelope fields", () => {
    const input = validEvent();
    Object.assign(input, { raw_secret: "must-not-pass" });
    Object.assign(input.sender as object, { union_id: "on-secret" });
    Object.assign(input.message as object, {
      root_id: "om-root",
      parent_id: "om-parent",
      upper_message_id: "must-not-pass",
    });

    expect(reconstructFeishuMessageEvent(input)).toEqual({
      schema: "2.0",
      header: {
        event_id: "event-1",
        event_type: "im.message.receive_v1",
        create_time: "1784160000000",
        tenant_key: "tenant-key-1",
      },
      event: {
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
          root_id: "om-root",
          parent_id: "om-parent",
          mentions: [{
            key: "@_user_1",
            id: { open_id: "ou-bot" },
            name: "Work Fabric",
          }],
        },
      },
    });
  });

  it.each([
    ["missing event_id", (input: Record<string, unknown>) => delete input.event_id],
    ["non-string event_id", (input: Record<string, unknown>) => { input.event_id = 1; }],
    ["empty event_id", (input: Record<string, unknown>) => { input.event_id = ""; }],
    ["over-bound event_id", (input: Record<string, unknown>) => { input.event_id = "x".repeat(513); }],
    ["over-bound create_time", (input: Record<string, unknown>) => { input.create_time = "1".repeat(65); }],
    ["missing sender", (input: Record<string, unknown>) => delete input.sender],
    ["non-object sender", (input: Record<string, unknown>) => { input.sender = []; }],
    ["missing sender open_id", (input: Record<string, unknown>) => {
      delete ((input.sender as { sender_id: Record<string, unknown> }).sender_id.open_id);
    }],
    ["missing message", (input: Record<string, unknown>) => delete input.message],
    ["empty content", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).content = "";
    }],
    ["over-bound root_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).root_id = "x".repeat(513);
    }],
    ["malformed mentions", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).mentions = {};
    }],
    ["too many mentions", (input: Record<string, unknown>) => {
      const message = input.message as Record<string, unknown>;
      message.mentions = Array.from({ length: 101 }, () => ({
        key: "@user", id: { open_id: "ou-bot" },
      }));
    }],
    ["malformed mention name", (input: Record<string, unknown>) => {
      const message = input.message as { mentions: Array<Record<string, unknown>> };
      message.mentions[0]!.name = 42;
    }],
    ["non-JSON SDK metadata", (input: Record<string, unknown>) => {
      input.metadata = { invalid: undefined };
    }],
  ])("rejects %s", (_name, mutate) => {
    const input = validEvent();
    mutate(input);
    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new TypeError("feishu_long_connection_event_invalid"),
    );
  });

  it("rejects unsupported event types with a stable local error", () => {
    const input = validEvent();
    input.event_type = "card.action.trigger";
    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new TypeError("feishu_long_connection_event_type_unsupported"),
    );
  });

  it("rejects oversized raw SDK metadata before discarding it", () => {
    const input = validEvent();
    input.metadata = "secret".repeat(50_000);
    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new RangeError("feishu_long_connection_event_too_large"),
    );
  });
});
