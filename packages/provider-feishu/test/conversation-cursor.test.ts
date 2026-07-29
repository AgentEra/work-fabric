import { describe, expect, it } from "vitest";

import {
  HmacConversationCursorCodec,
  type FeishuConversationCursorPayload,
} from "../src/index.js";

const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const payload: FeishuConversationCursorPayload = {
  version: 1,
  tenant_id: "tenant-1",
  source_uri: "feishu://tenant-key-1/message/om-trigger",
  conversation_id: "oc-1",
  trigger_message_id: "om-trigger",
  trigger_time: "2026-07-29T10:00:00.000Z",
  native_page_token: "native-page-2",
  expires_at: "2026-07-29T10:10:00.000Z",
};

describe("HmacConversationCursorCodec", () => {
  it("round-trips one authority-bound opaque cursor", () => {
    const codec = new HmacConversationCursorCodec({
      key,
      now: () => "2026-07-29T10:00:00.000Z",
    });

    const cursor = codec.encode(payload);

    expect(cursor).toMatch(/^wfc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("native-page-2");
    expect(codec.decode(cursor, {
      tenant_id: payload.tenant_id,
      source_uri: payload.source_uri,
    })).toEqual(payload);
    expect(Object.isFrozen(codec.decode(cursor, {
      tenant_id: payload.tenant_id,
      source_uri: payload.source_uri,
    }))).toBe(true);
  });

  it("rejects tampering, source substitution, expiry and invalid key material", () => {
    const codec = new HmacConversationCursorCodec({
      key,
      now: () => "2026-07-29T10:00:00.000Z",
    });
    const cursor = codec.encode(payload);
    const [prefix, body, signature] = cursor.split(".");

    expect(() => codec.decode(
      `${prefix}.${body!.slice(0, -1)}A.${signature}`,
      { tenant_id: payload.tenant_id, source_uri: payload.source_uri },
    )).toThrow(/cursor/i);
    expect(() => codec.decode(
      `${prefix}.${body}.${signature!.slice(0, -1)}A`,
      { tenant_id: payload.tenant_id, source_uri: payload.source_uri },
    )).toThrow(/cursor/i);
    expect(() => codec.decode(cursor, {
      tenant_id: payload.tenant_id,
      source_uri: "feishu://tenant-key-1/message/other",
    })).toThrow(/cursor/i);
    expect(() => new HmacConversationCursorCodec({
      key,
      now: () => "2026-07-29T10:10:00.000Z",
    }).decode(cursor, {
      tenant_id: payload.tenant_id,
      source_uri: payload.source_uri,
    })).toThrow(/expired/i);
    expect(() => new HmacConversationCursorCodec({
      key: Buffer.from("too-short"),
    })).toThrow(/key/i);
    expect(() => codec.decode(
      `wfc1.${"a".repeat(4_097)}.signature`,
      { tenant_id: payload.tenant_id, source_uri: payload.source_uri },
    )).toThrow(/cursor/i);
  });
});
