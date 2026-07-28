import { describe, expect, it, vi } from "vitest";

import {
  FeishuCapabilityExecutorPortAdapter,
  feishuCapabilityDeclarations,
} from "../src/index.js";

describe("FeishuCapabilityExecutorPortAdapter", () => {
  it("maps the generic Citizen execution context into the closed Feishu executor boundary", async () => {
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      data: { message_id: "message-1" },
      artifacts: [],
    }));
    const adapter = new FeishuCapabilityExecutorPortAdapter({ execute });
    const signal = new AbortController().signal;

    const result = await adapter.execute({
      invocation_id: "invocation-1",
      capability_id: "feishu.message.send",
      capability_version: "1.0.0",
      contract_digest: `sha256:${"a".repeat(64)}`,
      input: {
        target: { kind: "current_conversation" },
        content: { media_type: "text/plain", text: "通知" },
      },
    }, {
      tenant_id: "tenant-a",
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      fencing_token: 4,
      authority_evidence: {
        original_handoff_id: "handoff-original",
        represented_actor_id: "human-1",
        delegation_id: "delegation-child-1",
        parent_delegation_id: "delegation-human-agent",
        delegation_scopes: ["message:send"],
        delegation_expires_at: "2026-07-27T11:00:00.000Z",
        allowed_target_refs: ["feishu://chat/chat-1"],
        confirmation_proof_refs: [],
      },
      signal,
    });

    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(execute).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      original_handoff_id: "handoff-original",
      represented_actor_id: "human-1",
      delegation_id: "delegation-child-1",
      delegation_scopes: ["message:send"],
      delegation_expires_at: "2026-07-27T11:00:00.000Z",
      invocation_id: "invocation-1",
      idempotency_key: "feishu-actions:invocation-1",
      capability_id: "feishu.message.send",
      input: expect.objectContaining({ target: { kind: "current_conversation" } }),
      authority: {
        allowed_target_refs: ["feishu://chat/chat-1"],
        confirmation_proof_refs: [],
      },
      signal,
    });
    expect(JSON.stringify(execute.mock.calls)).not.toContain("credential");
  });

  it("rejects malformed authority evidence before provider execution", async () => {
    const execute = vi.fn();
    const adapter = new FeishuCapabilityExecutorPortAdapter({ execute });

    await expect(adapter.execute({
      invocation_id: "invocation-1",
      capability_id: "feishu.message.send",
      capability_version: "1.0.0",
      contract_digest: `sha256:${"a".repeat(64)}`,
      input: {},
    }, {
      tenant_id: "tenant-a",
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      fencing_token: 1,
      authority_evidence: {},
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      outcome: "rejected",
      code: "authority_denied",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(adapter.describeCapabilities()).toEqual(feishuCapabilityDeclarations());
  });
});
