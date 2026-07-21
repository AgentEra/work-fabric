import { describe, expect, it, vi } from "vitest";
import type { ConnectorIngressClaim } from "@work-fabric/connector-spi";
import type { FeishuParticipantResolution, FeishuParticipantResolver } from "@work-fabric/connector-feishu";
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

function policy(resolution: FeishuParticipantResolution = {
  kind: "resolved",
  identity: { actor_id: "actor-human", actor_type: "agent", endpoint_id: "endpoint-human" },
}) {
  const participantResolver: FeishuParticipantResolver = {
    async resolve() { return resolution; },
  };
  return new FeishuIntakeMessagePolicy({
    bot_open_id: "ou-bot-1",
    participant_resolver: participantResolver,
    target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
    clock: { now: () => "2026-07-17T00:00:05.000Z" },
    accept_within_seconds: 86_400,
    result_due_within_seconds: 604_800,
    max_intent_length: 4_000,
  });
}

describe("FeishuIntakeMessagePolicy", () => {
  it("binds participant admission to the exact command idempotency key", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      identity: { actor_id: "actor-human", actor_type: "human" as const, endpoint_id: "endpoint-human" },
    }));
    const mapped = await new FeishuIntakeMessagePolicy({
      bot_open_id: "ou-bot-1",
      participant_resolver: { resolve },
      target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
      clock: { now: () => "2026-07-17T00:00:05.000Z" },
      accept_within_seconds: 86_400,
      result_due_within_seconds: 604_800,
      max_intent_length: 4_000,
    }).mapMessage(claim());
    if (mapped.kind !== "command") throw new Error("expected command");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: mapped.command.idempotency_key,
    }));
  });

  it("maps one explicit bot mention to one deterministic public Handoff Offer", async () => {
    const result = await policy().mapMessage(claim());
    expect(result).toMatchObject({
      kind: "command",
      command: {
        operation: "handoff.offer",
        identity: { actor_id: "actor-human", actor_type: "agent", endpoint_id: "endpoint-human" },
        input: {
          work_reference: { uri: "feishu://tenant-key-1/message/om-1" },
          target: { actor_id: "actor-agent" },
          intent: [{ kind: "text", media_type: "text/plain", text: "create a requirement" }],
          verifier: { actor_id: "actor-human", actor_type: "agent" },
        },
      },
    });
    expect(result.kind === "command" && result.command.idempotency_key).toMatch(/^feishu:[A-Za-z0-9_-]+$/);
  });

  it("preserves a protocol-valid system Actor for a human external participant", async () => {
    await expect(policy({
      kind: "resolved",
      identity: { actor_id: "system-actor", actor_type: "system", endpoint_id: "system-endpoint" },
    }).mapMessage(claim())).resolves.toMatchObject({
      kind: "command",
      command: {
        identity: { actor_id: "system-actor", actor_type: "system", endpoint_id: "system-endpoint" },
        input: { verifier: { actor_id: "system-actor", actor_type: "system" } },
      },
    });
  });

  it("places a representation grant only in command authentication", async () => {
    const result = await policy({
      kind: "resolved",
      identity: { actor_id: "actor-stable", actor_type: "human", endpoint_id: "endpoint-stable" },
      representation_grant: "secret-representation-grant",
    }).mapMessage(claim());
    expect(result).toMatchObject({
      kind: "command",
      command: {
        identity: { actor_id: "actor-stable", actor_type: "human", endpoint_id: "endpoint-stable" },
        authentication: { kind: "bearer", credential: "secret-representation-grant" },
      },
    });
    expect(JSON.stringify(result.kind === "command" ? {
      identity: result.command.identity,
      input: result.command.input,
    } : result)).not.toContain("secret-representation-grant");
  });

  it.each([
    ["no mention", { mentions: [] }, "bot_not_mentioned"],
    ["different bot", { mentions: [{ key: "@_user_1", open_id: "ou-other" }] }, "bot_not_mentioned"],
    ["unsupported type", { message_type: "image" }, "unsupported_message_type"],
  ])("keeps %s inert", async (_name, overrides, reason) => {
    await expect(policy().mapMessage(claim(overrides))).resolves.toEqual({ kind: "ignored", reason_code: reason });
  });

  it("maps participant denial to permanent rejection using only a stable reason", async () => {
    await expect(policy({ kind: "denied", reason_code: "explicit_deny" }).mapMessage(claim())).resolves.toEqual({
      kind: "rejected", reason_code: "explicit_deny", retryable: false,
    });
  });

  it("maps evidence outage to retryable rejection using only a stable reason", async () => {
    await expect(policy({ kind: "temporarily_unavailable", reason_code: "evidence_unavailable" }).mapMessage(claim())).resolves.toEqual({
      kind: "rejected", reason_code: "evidence_unavailable", retryable: true,
    });
  });

  it("rejects hostile participant results without invoking accessors or reflecting secrets", async () => {
    const secret = "grant-must-not-become-a-reason";
    const kindGetter = vi.fn(() => "denied");
    const accessor: Record<string, unknown> = { reason_code: secret };
    Object.defineProperty(accessor, "kind", { enumerable: true, get: kindGetter });
    const inherited = Object.create({ kind: "denied", reason_code: secret }) as FeishuParticipantResolution;
    const extra = { kind: "denied", reason_code: "explicit_deny", grant: secret } as unknown as FeishuParticipantResolution;
    const wrongActorType = {
      kind: "resolved",
      identity: { actor_id: "actor", actor_type: "robot", endpoint_id: "endpoint" },
      representation_grant: secret,
    } as unknown as FeishuParticipantResolution;
    const undefinedGrant = {
      kind: "resolved",
      identity: { actor_id: "actor", actor_type: "human", endpoint_id: "endpoint" },
      representation_grant: undefined,
    } as unknown as FeishuParticipantResolution;
    const descriptorFailure = new Proxy({ kind: "denied", reason_code: "explicit_deny" }, {
      getOwnPropertyDescriptor() { throw new Error(secret); },
    }) as FeishuParticipantResolution;

    for (const result of [accessor as FeishuParticipantResolution, inherited, extra, wrongActorType, undefinedGrant, descriptorFailure]) {
      const mapped = await policy(result).mapMessage(claim());
      expect(mapped).toEqual({ kind: "rejected", reason_code: "participant_resolution_unavailable", retryable: true });
      expect(JSON.stringify(mapped)).not.toContain(secret);
    }
    expect(kindGetter).not.toHaveBeenCalled();
  });

  it("rejects malformed text content and an empty mention-only intent", async () => {
    await expect(policy().mapMessage(claim({ content: "not-json" }))).resolves.toEqual({ kind: "rejected", reason_code: "invalid_message_content", retryable: false });
    await expect(policy().mapMessage(claim({ content: '{"text":"@_user_1"}' }))).resolves.toEqual({ kind: "ignored", reason_code: "empty_intent" });
  });
});
