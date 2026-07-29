import { describe, expect, it, vi } from "vitest";

import type {
  NormalizedInvocationAuthorityRequest,
} from "@work-fabric/agent-capability-runtime";
import type { HandoffReadModel } from "@work-fabric/sdk-typescript";

import {
  LocalInvocationAuthorityProvider,
} from "../src/local-invocation-authority.js";

const digest =
  `sha256:${"a".repeat(64)}` as const;

function snapshot(overrides: Record<string, unknown> = {}): HandoffReadModel {
  return {
    tenant_id: "tenant-local",
    partition_id: "handoff:handoff-original",
    handoff_id: "handoff-original",
    stream_version: 3,
    state: {
      lifecycle_state: "accepted",
      initiator: { actor_id: "actor-human", actor_type: "human" },
      current_responsible_actor: {
        actor_id: "actor-intake-agent",
        actor_type: "agent",
      },
      package: {
        work_reference: {
          uri: "feishu://tenant-key-1/message/om-trigger",
          extensions: {
            "workfabric.dev/provider_family": "feishu",
            "workfabric.dev/resource_kind": "conversation_message",
            "workfabric.dev/external_tenant_id": "tenant-key-1",
            "workfabric.dev/conversation_id": "oc-chat-1",
            "workfabric.dev/message_id": "om-trigger",
          },
        },
        result_due_at: "2026-07-27T12:00:00.000Z",
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["document:write", "conversation:read"],
          resource_refs: ["feishu://tenant-key-1/message/om-trigger"],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: true,
        },
      },
      ...overrides,
    },
    latest_status: null,
  };
}

function input(
  overrides: Partial<NormalizedInvocationAuthorityRequest> = {},
): NormalizedInvocationAuthorityRequest {
  const candidate = {
    citizen_id: "feishu-actions",
    endpoint_id: "endpoint-feishu-actions",
    capability_id: "feishu.document.create",
    capability_version: "1.0.0",
    contract_digest: digest,
  };
  return {
    tenant_id: "tenant-local",
    request: {
      invocation_id: "invocation-1",
      original_handoff_id: "handoff-original",
      thread_id: "thread-1",
      capability_id: "feishu.document.create",
      version_constraint: "1.0.0",
      input: { title: "项目需求" },
      reason: "创建团队文档",
      deadline: "2026-07-27T11:00:00.000Z",
    },
    candidate,
    contract: {
      candidate,
      confirmation: "none",
      risk: "medium",
    },
    work_reference_uri:
      "urn:work-fabric:capability-invocation:handoff-original:invocation-1",
    ...overrides,
  };
}

function authority(read = snapshot()) {
  const getHandoff = vi.fn(async () => read);
  return {
    getHandoff,
    authority: new LocalInvocationAuthorityProvider({
      tenant_id: "tenant-local",
      agent_actor_id: "actor-intake-agent",
      queries: { getHandoff },
      allowed_namespaces: ["feishu."],
      now: () => "2026-07-27T10:00:00.000Z",
    }),
  };
}

describe("LocalInvocationAuthorityProvider", () => {
  it("derives bounded capability Authority from canonical original Handoff facts", async () => {
    const fixture = authority();

    const result = await fixture.authority.authorize(
      input(),
      new AbortController().signal,
    );

    expect(fixture.getHandoff).toHaveBeenCalledWith(
      "handoff-original",
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toMatchObject({
      delegation_id: expect.stringMatching(/^capability-delegation-[a-f0-9]{32}$/),
      scopes: ["capability:invoke", "document:write"],
      resource_refs: [
        "urn:work-fabric:capability-invocation:handoff-original:invocation-1",
        "feishu://tenant-key-1/message/om-trigger",
      ],
      expires_at: "2026-07-27T11:00:00.000Z",
      may_redelegate: false,
      extensions: {
        "workfabric.dev/capability_authority": {
          original_handoff_id: "handoff-original",
          invocation_id: "invocation-1",
          represented_actor_id: "actor-human",
          delegation_id: expect.stringMatching(
            /^capability-delegation-[a-f0-9]{32}$/,
          ),
          parent_delegation_id: "delegation-human-agent",
          delegation_scopes: ["document:write"],
          delegation_expires_at: "2026-07-27T11:00:00.000Z",
          capability_version: "1.0.0",
          contract_digest: digest,
          allowed_target_refs: [],
          confirmation_proof_refs: [],
          source_reference: {
            uri: "feishu://tenant-key-1/message/om-trigger",
            extensions: {
              "workfabric.dev/provider_family": "feishu",
              "workfabric.dev/resource_kind": "conversation_message",
              "workfabric.dev/external_tenant_id": "tenant-key-1",
              "workfabric.dev/conversation_id": "oc-chat-1",
              "workfabric.dev/message_id": "om-trigger",
            },
          },
        },
      },
    });
  });

  it("authorizes current-conversation reads only from the trusted Feishu source", async () => {
    const candidate = {
      citizen_id: "feishu-message-provider",
      endpoint_id: "endpoint-feishu-actions",
      capability_id: "feishu.conversation.history.read",
      capability_version: "1.0.0",
      contract_digest: digest,
    };
    const request = input({
      request: {
        ...input().request,
        capability_id: candidate.capability_id,
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 20,
        },
      },
      candidate,
      contract: {
        candidate,
        confirmation: "none",
        risk: "low",
        operation_kind: "query",
      },
    });

    await expect(authority().authority.authorize(
      request,
      new AbortController().signal,
    )).resolves.toMatchObject({
      scopes: ["capability:invoke", "conversation:read"],
      extensions: {
        "workfabric.dev/capability_authority": {
          represented_actor_id: "actor-human",
          delegation_scopes: ["conversation:read"],
          source_reference: {
            uri: "feishu://tenant-key-1/message/om-trigger",
            extensions: {
              "workfabric.dev/provider_family": "feishu",
              "workfabric.dev/conversation_id": "oc-chat-1",
              "workfabric.dev/message_id": "om-trigger",
            },
          },
        },
      },
    });

    for (const source of [
      {},
      {
        uri: "email://tenant/thread/thread-1",
        extensions: {
          "workfabric.dev/provider_family": "email",
          "workfabric.dev/resource_kind": "conversation_message",
          "workfabric.dev/external_tenant_id": "tenant-key-1",
          "workfabric.dev/conversation_id": "thread-1",
          "workfabric.dev/message_id": "mail-1",
        },
      },
    ]) {
      await expect(authority(snapshot({
        package: {
          ...(snapshot().state.package as Record<string, unknown>),
          work_reference: source,
        },
      })).authority.authorize(
        request,
        new AbortController().signal,
      )).rejects.toThrow(/authority denied/i);
    }
  });

  it.each([
    ["non-human initiator", snapshot({
      initiator: { actor_id: "actor-agent", actor_type: "agent" },
    }), input()],
    ["different responsible Agent", snapshot({
      current_responsible_actor: {
        actor_id: "other-agent",
        actor_type: "agent",
      },
    }), input()],
    ["wrong tenant", {
      ...snapshot(),
      tenant_id: "tenant-other",
    }, input()],
    ["wrong Handoff", {
      ...snapshot(),
      handoff_id: "handoff-other",
    }, input()],
  ])("denies %s canonical Handoff facts", async (_name, read, request) => {
    await expect(authority(read).authority.authorize(
      request,
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);
  });

  it("denies expired, unsupported and changed capability bindings", async () => {
    const fixture = authority();
    const expired = input({
      request: {
        ...input().request,
        deadline: "2026-07-27T09:00:00.000Z",
      },
    });
    await expect(fixture.authority.authorize(
      expired,
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);

    const unsupported = input();
    unsupported.candidate = {
      ...unsupported.candidate,
      capability_id: "mail.message.send",
    };
    await expect(fixture.authority.authorize(
      unsupported,
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);

    const changed = input({
      contract: {
        ...input().contract,
        candidate: {
          ...input().candidate,
          contract_digest:
            `sha256:${"b".repeat(64)}`,
        },
      },
    });
    await expect(fixture.authority.authorize(
      changed,
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);
  });

  it("denies missing operation scope and non-redelegable original authority", async () => {
    const missingScope = snapshot({
      package: {
        result_due_at: "2026-07-27T12:00:00.000Z",
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["document:read"],
          resource_refs: [],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: true,
        },
      },
    });
    await expect(authority(missingScope).authority.authorize(
      input(),
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);

    const nonRedelegable = snapshot({
      package: {
        result_due_at: "2026-07-27T12:00:00.000Z",
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["document:write"],
          resource_refs: [],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: false,
        },
      },
    });
    await expect(authority(nonRedelegable).authority.authorize(
      input(),
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);
  });
});
