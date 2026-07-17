import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@work-fabric/exchange-spi";

import { normalizeFeishuEvent } from "../src/index.js";

const messageFixture = JSON.parse(readFileSync(
  new URL("./fixtures/message-event.json", import.meta.url),
  "utf8",
)) as JsonObject;

describe("Feishu ingress normalizer", () => {
  it("uses message_id for received-message deduplication", () => {
    const withMentions = structuredClone(messageFixture);
    const message = ((withMentions.event as JsonObject).message as unknown as Record<string, unknown>);
    message.root_id = "om-root-1";
    message.parent_id = "om-parent-1";
    message.mentions = [{ key: "@_user_1", id: { open_id: "ou-bot-1" }, name: "Work Fabric" }];
    const result = normalizeFeishuEvent(withMentions, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      expected_external_tenant_id: "tenant-key-1",
      received_at: "2026-07-15T00:00:01Z",
    });
    expect(result).toMatchObject({
      dedupe_key: "message:om-message-1",
      event_type: "im.message.receive_v1",
      external_event_id: "event-message-1",
      partition_key: "chat:oc-chat-1",
      payload: {
        message_id: "om-message-1",
        sender_open_id: "ou-human-1",
        root_id: "om-root-1",
        parent_id: "om-parent-1",
        mentions: [{ key: "@_user_1", open_id: "ou-bot-1" }],
      },
    });
    expect(result.payload).not.toHaveProperty("token");
    expect(result.payload).not.toHaveProperty("tenant_key");
  });

  it("normalizes generated card actions using an opaque action reference", () => {
    const result = normalizeFeishuEvent({
      schema: "2.0",
      header: {
        event_id: "event-card-1",
        event_type: "card.action.trigger",
        create_time: "1784073600000",
        tenant_key: "tenant-key-1",
      },
      event: {
        operator: { operator_id: { open_id: "ou-human-1" } },
        action: { value: { action_ref: "action-reference-1" }, tag: "button" },
        context: { open_message_id: "om-card-1" },
      },
    }, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      expected_external_tenant_id: "tenant-key-1",
      received_at: "2026-07-15T00:00:01Z",
    });
    expect(result).toMatchObject({
      partition_key: "message:om-card-1",
      payload: {
        operator_open_id: "ou-human-1",
        action_ref: "action-reference-1",
      },
    });
    expect(result.dedupe_key).toMatch(/^card:event-card-1:[a-f0-9]{64}$/);
  });

  it("bounds card-action deduplication keys independently of opaque reference length", () => {
    const actionReference = `wfaf1.${"a".repeat(1_000)}`;
    const result = normalizeFeishuEvent({
      schema: "2.0",
      header: {
        event_id: "event-card-long-reference",
        event_type: "card.action.trigger",
        create_time: "1784073600000",
        tenant_key: "tenant-key-1",
      },
      event: {
        operator: { operator_id: { open_id: "ou-human-1" } },
        action: { value: { action_ref: actionReference }, tag: "button" },
        context: { open_message_id: "om-card-1" },
      },
    }, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      expected_external_tenant_id: "tenant-key-1",
      received_at: "2026-07-15T00:00:01Z",
    });
    expect(result.dedupe_key.length).toBeLessThanOrEqual(255);
    expect(result.payload.action_ref).toBe(actionReference);
  });

  it("rejects tenant mismatch and unsupported event types", () => {
    expect(() => normalizeFeishuEvent(messageFixture, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      expected_external_tenant_id: "another-tenant",
      received_at: "2026-07-15T00:00:01Z",
    })).toThrow(/tenant/i);
    expect(() => normalizeFeishuEvent({
      schema: "2.0",
      header: {
        event_id: "event-unknown",
        event_type: "unknown.event",
        tenant_key: "tenant-key-1",
      },
      event: {},
    }, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      expected_external_tenant_id: "tenant-key-1",
      received_at: "2026-07-15T00:00:01Z",
    })).toThrow(/unsupported/i);
  });
});
