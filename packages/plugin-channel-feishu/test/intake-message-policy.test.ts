import { describe, expect, it } from "vitest";
import type { ConnectorIngressClaim } from "@work-fabric/connector-spi";
import { FeishuIdentityMapper } from "@work-fabric/connector-feishu";
import { FeishuIntakeMessagePolicy } from "../src/index.js";

function claim(overrides: Record<string, unknown> = {}): ConnectorIngressClaim {
  return {
    ingress_id: "ingress-1",
    envelope: {
      tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu",
      external_tenant_id: "tenant-key-1", external_event_id: "event-1",
      dedupe_key: "message:om-1", event_type: "im.message.receive_v1",
      partition_key: "chat:oc-1", occurred_at: "2026-07-17T00:00:00.000Z",
      received_at: "2026-07-17T00:00:01.000Z",
      payload: {
        message_id: "om-1", chat_id: "oc-1", chat_type: "group", message_type: "text",
        content: '{"text":"@_user_1 create a requirement"}', sender_open_id: "ou-human-1",
        sender_type: "user", mentions: [{ key: "@_user_1", open_id: "ou-bot-1" }],
        root_id: "om-root-1", parent_id: "om-parent-1", ...overrides,
      },
    },
    state: "processing", attempt: 1, available_at: "2026-07-17T00:00:01.000Z",
    accepted_at: "2026-07-17T00:00:01.000Z", updated_at: "2026-07-17T00:00:02.000Z",
    claim_owner: "worker-1", claim_token: "claim-1", fencing_token: 1,
    lease_expires_at: "2026-07-17T00:01:02.000Z",
  };
}

function policy(mapped = true) {
  return new FeishuIntakeMessagePolicy({
    bot_open_id: "ou-bot-1",
    identity_resolver: new FeishuIdentityMapper(async () => mapped
      ? { actor_id: "actor-human", endpoint_id: "endpoint-human" }
      : null),
    target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
    clock: { now: () => "2026-07-17T00:00:05.000Z" },
    accept_within_seconds: 86_400,
    result_due_within_seconds: 604_800,
    max_intent_length: 4_000,
  });
}

describe("FeishuIntakeMessagePolicy", () => {
  it("maps one explicit bot mention to one deterministic public Handoff Offer", async () => {
    const result = await policy().mapMessage(claim());
    expect(result).toMatchObject({
      kind: "command",
      command: {
        operation: "handoff.offer",
        identity: { actor_id: "actor-human", endpoint_id: "endpoint-human" },
        input: {
          work_reference: { uri: "feishu://tenant-key-1/message/om-1" },
          target: { actor_id: "actor-agent" },
          intent: [{ kind: "text", media_type: "text/plain", text: "create a requirement" }],
          verifier: { actor_id: "actor-human", actor_type: "human" },
        },
      },
    });
    expect(result.kind === "command" && result.command.idempotency_key).toMatch(/^feishu-intake:[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["no mention", { mentions: [] }, "bot_not_mentioned"],
    ["different bot", { mentions: [{ key: "@_user_1", open_id: "ou-other" }] }, "bot_not_mentioned"],
    ["unsupported type", { message_type: "image" }, "unsupported_message_type"],
  ])("keeps %s inert", async (_name, overrides, reason) => {
    await expect(policy().mapMessage(claim(overrides))).resolves.toEqual({ kind: "ignored", reason_code: reason });
  });

  it("rejects an unmapped sender without creating authority", async () => {
    await expect(policy(false).mapMessage(claim())).resolves.toEqual({
      kind: "rejected", reason_code: "identity_unmapped", retryable: false,
    });
  });

  it("rejects malformed text content and an empty mention-only intent", async () => {
    await expect(policy().mapMessage(claim({ content: "not-json" }))).resolves.toEqual({ kind: "rejected", reason_code: "invalid_message_content", retryable: false });
    await expect(policy().mapMessage(claim({ content: '{"text":"@_user_1"}' }))).resolves.toEqual({ kind: "ignored", reason_code: "empty_intent" });
  });
});
