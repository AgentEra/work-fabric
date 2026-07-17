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

  const invalidCases: ReadonlyArray<readonly [string, (input: Record<string, unknown>) => void]> = [
    ["missing event_id", (input: Record<string, unknown>) => delete input.event_id],
    ["non-string event_id", (input: Record<string, unknown>) => { input.event_id = 1; }],
    ["empty event_id", (input: Record<string, unknown>) => { input.event_id = ""; }],
    ["over-bound event_id", (input: Record<string, unknown>) => { input.event_id = "x".repeat(513); }],
    ["missing event_type", (input: Record<string, unknown>) => delete input.event_type],
    ["non-string event_type", (input: Record<string, unknown>) => { input.event_type = 1; }],
    ["empty event_type", (input: Record<string, unknown>) => { input.event_type = ""; }],
    ["over-bound event_type", (input: Record<string, unknown>) => { input.event_type = "x".repeat(513); }],
    ["missing create_time", (input: Record<string, unknown>) => delete input.create_time],
    ["non-string create_time", (input: Record<string, unknown>) => { input.create_time = 1; }],
    ["empty create_time", (input: Record<string, unknown>) => { input.create_time = ""; }],
    ["over-bound create_time", (input: Record<string, unknown>) => { input.create_time = "1".repeat(65); }],
    ["missing tenant_key", (input: Record<string, unknown>) => delete input.tenant_key],
    ["non-string tenant_key", (input: Record<string, unknown>) => { input.tenant_key = 1; }],
    ["empty tenant_key", (input: Record<string, unknown>) => { input.tenant_key = ""; }],
    ["over-bound tenant_key", (input: Record<string, unknown>) => { input.tenant_key = "x".repeat(513); }],
    ["missing sender", (input: Record<string, unknown>) => delete input.sender],
    ["non-object sender", (input: Record<string, unknown>) => { input.sender = []; }],
    ["missing sender_id", (input: Record<string, unknown>) => {
      delete (input.sender as Record<string, unknown>).sender_id;
    }],
    ["non-object sender_id", (input: Record<string, unknown>) => {
      (input.sender as Record<string, unknown>).sender_id = "ou-human";
    }],
    ["missing sender open_id", (input: Record<string, unknown>) => {
      delete ((input.sender as { sender_id: Record<string, unknown> }).sender_id.open_id);
    }],
    ["non-string sender open_id", (input: Record<string, unknown>) => {
      (input.sender as { sender_id: Record<string, unknown> }).sender_id.open_id = 1;
    }],
    ["empty sender open_id", (input: Record<string, unknown>) => {
      (input.sender as { sender_id: Record<string, unknown> }).sender_id.open_id = "";
    }],
    ["over-bound sender open_id", (input: Record<string, unknown>) => {
      (input.sender as { sender_id: Record<string, unknown> }).sender_id.open_id = "x".repeat(513);
    }],
    ["missing sender_type", (input: Record<string, unknown>) => {
      delete (input.sender as Record<string, unknown>).sender_type;
    }],
    ["non-string sender_type", (input: Record<string, unknown>) => {
      (input.sender as Record<string, unknown>).sender_type = 1;
    }],
    ["empty sender_type", (input: Record<string, unknown>) => {
      (input.sender as Record<string, unknown>).sender_type = "";
    }],
    ["over-bound sender_type", (input: Record<string, unknown>) => {
      (input.sender as Record<string, unknown>).sender_type = "x".repeat(513);
    }],
    ["missing message", (input: Record<string, unknown>) => delete input.message],
    ["non-object message", (input: Record<string, unknown>) => { input.message = []; }],
    ...(["message_id", "chat_id", "chat_type", "message_type"] as const).flatMap((field) => [
      [`missing ${field}`, (input: Record<string, unknown>) => {
        delete (input.message as Record<string, unknown>)[field];
      }],
      [`non-string ${field}`, (input: Record<string, unknown>) => {
        (input.message as Record<string, unknown>)[field] = 1;
      }],
      [`empty ${field}`, (input: Record<string, unknown>) => {
        (input.message as Record<string, unknown>)[field] = "";
      }],
      [`over-bound ${field}`, (input: Record<string, unknown>) => {
        (input.message as Record<string, unknown>)[field] = "x".repeat(513);
      }],
    ] as const),
    ["missing content", (input: Record<string, unknown>) => {
      delete (input.message as Record<string, unknown>).content;
    }],
    ["non-string content", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).content = 1;
    }],
    ["empty content", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).content = "";
    }],
    ["non-string root_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).root_id = 1;
    }],
    ["empty root_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).root_id = "";
    }],
    ["over-bound root_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).root_id = "x".repeat(513);
    }],
    ["non-string parent_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).parent_id = 1;
    }],
    ["empty parent_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).parent_id = "";
    }],
    ["over-bound parent_id", (input: Record<string, unknown>) => {
      (input.message as Record<string, unknown>).parent_id = "x".repeat(513);
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
    ["empty mention name", (input: Record<string, unknown>) => {
      const message = input.message as { mentions: Array<Record<string, unknown>> };
      message.mentions[0]!.name = "";
    }],
    ["over-bound mention name", (input: Record<string, unknown>) => {
      const message = input.message as { mentions: Array<Record<string, unknown>> };
      message.mentions[0]!.name = "x".repeat(513);
    }],
    ...(["key", "open_id"] as const).flatMap((field) => [
      [`missing mention ${field}`, (input: Record<string, unknown>) => {
        const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
        if (field === "key") delete mention.key;
        else delete (mention.id as Record<string, unknown>).open_id;
      }],
      [`non-string mention ${field}`, (input: Record<string, unknown>) => {
        const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
        if (field === "key") mention.key = 1;
        else (mention.id as Record<string, unknown>).open_id = 1;
      }],
      [`empty mention ${field}`, (input: Record<string, unknown>) => {
        const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
        if (field === "key") mention.key = "";
        else (mention.id as Record<string, unknown>).open_id = "";
      }],
      [`over-bound mention ${field}`, (input: Record<string, unknown>) => {
        const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
        if (field === "key") mention.key = "x".repeat(513);
        else (mention.id as Record<string, unknown>).open_id = "x".repeat(513);
      }],
    ] as const),
    ["missing mention id", (input: Record<string, unknown>) => {
      const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
      delete mention.id;
    }],
    ["non-object mention id", (input: Record<string, unknown>) => {
      const mention = (input.message as { mentions: Array<Record<string, unknown>> }).mentions[0]!;
      mention.id = "ou-bot";
    }],
    ["non-JSON SDK metadata", (input: Record<string, unknown>) => {
      input.metadata = { invalid: undefined };
    }],
  ];

  it.each(invalidCases)("rejects %s", (_name, mutate) => {
    const input = validEvent();
    mutate(input);
    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new TypeError("feishu_long_connection_event_invalid"),
    );
  });

  it("converts changing accessor failures to the stable invalid error", () => {
    const input = validEvent();
    let reads = 0;
    Object.defineProperty(input, "event_id", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads === 3) throw new Error("escaped_accessor_error");
        return "event-1";
      },
    });

    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new TypeError("feishu_long_connection_event_invalid"),
    );
  });

  it("reconstructs from data descriptors without rereading proxy properties", () => {
    const input = new Proxy(validEvent(), {
      get() {
        throw new Error("proxy_property_was_reread");
      },
    });

    const result = reconstructFeishuMessageEvent(input);
    expect((result.header as Record<string, unknown>).event_id).toBe("event-1");
  });

  it("snapshots array length from its data descriptor without proxy reads", () => {
    const input = validEvent();
    const message = input.message as { mentions: unknown[] };
    message.mentions = new Proxy(message.mentions, {
      get() {
        throw new Error("proxy_array_was_reread");
      },
    });

    expect(() => reconstructFeishuMessageEvent(input)).not.toThrow();
  });

  it("converts arbitrary proxy trap failures to the stable invalid error", () => {
    const input = new Proxy(validEvent(), {
      ownKeys() {
        throw new Error("escaped_proxy_error");
      },
    });

    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new TypeError("feishu_long_connection_event_invalid"),
    );
  });

  it("accepts omitted optional thread IDs and mention names without synthesizing them", () => {
    const input = validEvent();
    const message = input.message as { mentions: Array<Record<string, unknown>> };
    delete message.mentions[0]!.name;

    const result = reconstructFeishuMessageEvent(input);
    const outputMessage = (result.event as Record<string, unknown>).message as Record<string, unknown>;
    const outputMention = (outputMessage.mentions as Array<Record<string, unknown>>)[0]!;
    expect(outputMessage).not.toHaveProperty("root_id");
    expect(outputMessage).not.toHaveProperty("parent_id");
    expect(outputMention).not.toHaveProperty("name");
  });

  it("rejects sparse mentions even when inherited values mask the hole", () => {
    const input = validEvent();
    const sparseMentions = new Array<unknown>(1);
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(prototype, "0", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 2) delete prototype["0"];
        return { key: "@_user_1", id: { open_id: "ou-bot" } };
      },
    });
    Object.setPrototypeOf(sparseMentions, prototype);
    (input.message as Record<string, unknown>).mentions = sparseMentions;

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

  it("applies the raw input bound in UTF-8 bytes", () => {
    const input = validEvent();
    input.metadata = "界".repeat(90_000);
    expect((input.metadata as string).length).toBeLessThan(256 * 1024);
    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new RangeError("feishu_long_connection_event_too_large"),
    );
  });

  it("accepts multibyte content when its UTF-8 representation remains in bounds", () => {
    const input = validEvent();
    (input.message as Record<string, unknown>).content = "界".repeat(80_000);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThan(256 * 1024);
    expect(() => reconstructFeishuMessageEvent(input)).not.toThrow();
  });

  it("rejects output that crosses the byte bound only after reconstruction", () => {
    const input = validEvent();
    delete (input.message as Record<string, unknown>).mentions;
    (input.message as Record<string, unknown>).content = "";
    const emptyInputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    (input.message as Record<string, unknown>).content = "x".repeat(
      256 * 1024 - emptyInputBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(256 * 1024);

    expect(() => reconstructFeishuMessageEvent(input)).toThrow(
      new RangeError("feishu_long_connection_event_too_large"),
    );
  });
});
