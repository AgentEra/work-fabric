import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";

import { CapabilityProviderDriver } from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function task(): RuntimeTaskPackage {
  return {
    tenant_id: "tenant-a",
    handoff_id: "handoff-aux",
    thread_id: "thread-1",
    stream_version: 3,
    role: {
      role_id: "feishu-provider",
      version: 1,
      display_name: "Feishu Provider",
      description: "typed provider",
      capability_ids: ["feishu.message.send"],
    },
    capability_id: "feishu.message.send",
    intent: [{
      kind: "data",
      schema_ref: "urn:work-fabric:schema:feishu:messageSendInput:1",
      data: {
        target: { kind: "current_conversation" },
        content: { media_type: "text/plain", text: "通知" },
      },
    }],
    context_reference: null,
    authority_scope: {
      delegation_id: "delegation-1",
      scopes: ["feishu.message.send"],
      resource_refs: ["feishu://chat/chat-1"],
      expires_at: "2026-07-27T11:00:00.000Z",
      may_redelegate: false,
      extensions: {
        "workfabric.dev/capability_authority": {
          original_handoff_id: "handoff-original",
          initiating_actor_id: "human-1",
          capability_version: "1.0.0",
          contract_digest: digest,
          allowed_target_refs: ["feishu://chat/chat-1"],
          allowed_document_tokens: [],
          confirmation_proof_refs: [],
        },
      },
    },
    acceptance_criteria: [],
    priority: "normal",
    accept_by: "2026-07-27T10:30:00.000Z",
    result_due_at: "2026-07-27T11:00:00.000Z",
    workspace_path: "/tmp/workspace",
  };
}

describe("CapabilityProviderDriver", () => {
  it("executes typed facts and returns a machine result without authoring user copy", async () => {
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      data: { message_id: "message-1", sent_at: "2026-07-27T10:01:00.000Z" },
      artifacts: [],
    }));
    const driver = new CapabilityProviderDriver({
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      capabilities: ["feishu.message.send"],
      executor: { describeCapabilities: () => [], execute },
    });

    const result = await driver.execute(
      task(),
      async () => undefined,
      new AbortController().signal,
    );

    expect(execute).toHaveBeenCalledWith({
      invocation_id: "handoff-aux",
      capability_id: "feishu.message.send",
      capability_version: "1.0.0",
      contract_digest: digest,
      input: expect.objectContaining({ target: { kind: "current_conversation" } }),
    }, expect.objectContaining({
      tenant_id: "tenant-a",
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      authority_evidence: expect.objectContaining({
        original_handoff_id: "handoff-original",
      }),
    }));
    expect(result.summary).toEqual([{
      kind: "data",
      schema_ref: "urn:work-fabric:schema:capability-result:1",
      data: {
        outcome: "succeeded",
        data: {
          message_id: "message-1",
          sent_at: "2026-07-27T10:01:00.000Z",
        },
        artifacts: [],
      },
    }]);
    expect(JSON.stringify(result)).not.toContain("已");
  });

  it("fails closed when the bound authority extension is missing", async () => {
    const execute = vi.fn();
    const driver = new CapabilityProviderDriver({
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      capabilities: ["feishu.message.send"],
      executor: { describeCapabilities: () => [], execute },
    });
    const valid = task();
    const invalid = {
      ...valid,
      authority_scope: {
        ...valid.authority_scope,
        extensions: {},
      },
    };

    await expect(driver.execute(
      invalid,
      async () => undefined,
      new AbortController().signal,
    )).rejects.toThrow(/authority/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
