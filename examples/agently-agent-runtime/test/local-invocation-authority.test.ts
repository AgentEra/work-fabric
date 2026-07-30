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

function capabilityInput(
  capabilityId: string,
  requestInput: Record<string, unknown>,
): NormalizedInvocationAuthorityRequest {
  const candidate = {
    citizen_id: capabilityId.startsWith("feishu.calendar.")
      ? "citizen-feishu-calendar"
      : "citizen-feishu-message",
    endpoint_id: "endpoint-feishu-actions",
    capability_id: capabilityId,
    capability_version: "1.0.0",
    contract_digest: digest,
  };
  return input({
    request: {
      ...input().request,
      capability_id: capabilityId,
      input: requestInput,
    },
    candidate,
    contract: {
      candidate,
      confirmation: "none",
      risk: "low",
      operation_kind: "query",
    },
  });
}

function membersResult(): HandoffReadModel {
  return {
    tenant_id: "tenant-local",
    partition_id: "handoff:handoff-members-result-1",
    handoff_id: "handoff-members-result-1",
    stream_version: 4,
    state: {
      lifecycle_state: "result_returned",
      package: {
        work_reference: {
          uri: "urn:work-fabric:capability-invocation:handoff-original:members-1",
          extensions: {
            "workfabric.dev/original_handoff_id": "handoff-original",
            "workfabric.dev/invocation_id": "members-1",
          },
        },
        target: {
          capability_requirement: {
            capability_id: "feishu.conversation.members.list",
          },
        },
      },
      result: {
        summary: [{
          kind: "data",
          schema_ref: "urn:work-fabric:schema:capability-result:1",
          data: {
            outcome: "succeeded",
            data: {
              members: [
                { resource_uri: "feishu://user/open-id/ou_1" },
                { resource_uri: "feishu://user/open-id/ou_2" },
              ],
              has_more: false,
              provenance: {
                provider_family: "feishu",
                source: "im.chat.members",
                source_reference: "feishu://chat/oc-chat-1",
              },
            },
            artifacts: [],
          },
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
    latest_status: null,
  } as HandoffReadModel;
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

  it("derives the current chat for member lookup only from the trusted source", async () => {
    const read = snapshot({
      package: {
        ...(snapshot().state.package as Record<string, unknown>),
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["conversation_members:read"],
          resource_refs: ["feishu://tenant-key-1/message/om-trigger"],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: true,
        },
      },
    });
    const result = await authority(read).authority.authorize(
      capabilityInput("feishu.conversation.members.list", {
        conversation: { kind: "current_conversation" },
        page_size: 100,
      }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      scopes: ["capability:invoke", "conversation_members:read"],
      extensions: {
        "workfabric.dev/capability_authority": {
          delegation_scopes: ["conversation_members:read"],
          allowed_target_refs: ["feishu://chat/oc-chat-1"],
        },
      },
    });
  });

  it("carries member user refs only through a verified Capability Result chain", async () => {
    const original = snapshot({
      package: {
        ...(snapshot().state.package as Record<string, unknown>),
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["calendar_freebusy:read"],
          resource_refs: ["feishu://tenant-key-1/message/om-trigger"],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: true,
        },
      },
    });
    const getHandoff = vi.fn(async (handoffId: string) =>
      handoffId === "handoff-original" ? original : membersResult()
    );
    const policy = new LocalInvocationAuthorityProvider({
      tenant_id: "tenant-local",
      agent_actor_id: "actor-intake-agent",
      queries: { getHandoff },
      allowed_namespaces: ["feishu."],
      now: () => "2026-07-27T10:00:00.000Z",
    });
    const result = await policy.authorize(
      capabilityInput("feishu.calendar.freebusy.query", {
        start_at: "2026-07-28T09:00:00+08:00",
        end_at: "2026-07-28T18:00:00+08:00",
        participants: [
          "feishu://user/open-id/ou_1",
          "feishu://user/open-id/ou_2",
        ],
        include_external_calendars: true,
        busy_only: true,
        authority_evidence: {
          capability_result_handoff_ids: ["handoff-members-result-1"],
        },
      }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      scopes: ["capability:invoke", "calendar_freebusy:read"],
      extensions: {
        "workfabric.dev/capability_authority": {
          delegation_scopes: ["calendar_freebusy:read"],
          allowed_target_refs: [
            "feishu://user/open-id/ou_1",
            "feishu://user/open-id/ou_2",
          ],
        },
      },
    });

    const tampered = membersResult();
    (tampered.state.package as Record<string, unknown>).work_reference = {
      uri: "urn:work-fabric:capability-invocation:handoff-other:members-1",
      extensions: {
        "workfabric.dev/original_handoff_id": "handoff-other",
      },
    };
    const deniedQueries = vi.fn(async (handoffId: string) =>
      handoffId === "handoff-original" ? original : tampered
    );
    await expect(new LocalInvocationAuthorityProvider({
      tenant_id: "tenant-local",
      agent_actor_id: "actor-intake-agent",
      queries: { getHandoff: deniedQueries },
      allowed_namespaces: ["feishu."],
      now: () => "2026-07-27T10:00:00.000Z",
    }).authorize(
      capabilityInput("feishu.calendar.freebusy.query", {
        start_at: "2026-07-28T09:00:00+08:00",
        end_at: "2026-07-28T18:00:00+08:00",
        participants: ["feishu://user/open-id/ou_1"],
        include_external_calendars: true,
        busy_only: true,
        authority_evidence: {
          capability_result_handoff_ids: ["handoff-members-result-1"],
        },
      }),
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);
  });

  it("authorizes Calendar creation only from the original Human's later confirmation and verified members", async () => {
    const confirmation = snapshot({
      package: {
        ...(snapshot().state.package as Record<string, unknown>),
        work_reference: {
          uri: "feishu://tenant-key-1/message/om-confirmation",
          extensions: {
            "workfabric.dev/provider_family": "feishu",
            "workfabric.dev/resource_kind": "conversation_message",
            "workfabric.dev/external_tenant_id": "tenant-key-1",
            "workfabric.dev/conversation_id": "oc-chat-1",
            "workfabric.dev/message_id": "om-confirmation",
            "workfabric.dev/sender_resource_uri":
              "feishu://user/open-id/ou_1",
          },
        },
        authority_scope: {
          delegation_id: "delegation-human-agent",
          scopes: ["calendar_event:write"],
          resource_refs: [
            "feishu://tenant-key-1/message/om-confirmation",
          ],
          expires_at: "2026-07-27T12:00:00.000Z",
          may_redelegate: true,
        },
      },
    });
    const sessionOrigin = snapshot({
      package: {
        ...(snapshot().state.package as Record<string, unknown>),
        work_reference: {
          uri: "feishu://tenant-key-1/message/om-origin",
          extensions: {
            "workfabric.dev/provider_family": "feishu",
            "workfabric.dev/resource_kind": "conversation_message",
            "workfabric.dev/external_tenant_id": "tenant-key-1",
            "workfabric.dev/conversation_id": "oc-chat-1",
            "workfabric.dev/message_id": "om-origin",
            "workfabric.dev/sender_resource_uri":
              "feishu://user/open-id/ou_1",
          },
        },
      },
    });
    const getHandoff = vi.fn(async (handoffId: string) => {
      if (handoffId === "handoff-original") return confirmation;
      if (handoffId === "handoff-session-origin") {
        return {
          ...sessionOrigin,
          handoff_id: handoffId,
          partition_id: `handoff:${handoffId}`,
        };
      }
      const members = membersResult();
      return {
        ...members,
        state: {
          ...members.state,
          package: {
            ...(members.state.package as Record<string, unknown>),
            work_reference: {
              uri:
                "urn:work-fabric:capability-invocation:" +
                "handoff-session-origin:members-1",
              extensions: {
                "workfabric.dev/original_handoff_id":
                  "handoff-session-origin",
                "workfabric.dev/invocation_id": "members-1",
              },
            },
          },
        },
      } as HandoffReadModel;
    });
    const policy = new LocalInvocationAuthorityProvider({
      tenant_id: "tenant-local",
      agent_actor_id: "actor-intake-agent",
      queries: { getHandoff },
      allowed_namespaces: ["feishu."],
      now: () => "2026-07-27T10:00:00.000Z",
    });
    const request = capabilityInput("feishu.calendar.event.create", {
      calendar: { kind: "default_calendar" },
      title: "项目评审",
      start_at: "2026-07-28T09:00:00+08:00",
      end_at: "2026-07-28T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [
        "feishu://user/open-id/ou_1",
        "feishu://user/open-id/ou_2",
      ],
      authority_evidence: {
        session_origin_handoff_id: "handoff-session-origin",
        confirmation_handoff_id: "handoff-original",
        proposal_digest: `sha256:${"b".repeat(64)}`,
        capability_result_handoff_ids: ["handoff-members-result-1"],
      },
    });
    await expect(policy.authorize(
      request,
      new AbortController().signal,
    )).resolves.toMatchObject({
      extensions: {
        "workfabric.dev/capability_authority": {
          allowed_target_refs: [
            "feishu://user/open-id/ou_1",
            "feishu://user/open-id/ou_2",
          ],
          confirmation_proof_refs: [
            "handoff-session-origin",
            "handoff-original",
            "handoff-members-result-1",
            `urn:work-fabric:scheduling-proposal:sha256:${"b".repeat(64)}`,
          ],
        },
      },
    });
    await expect(policy.authorize(
      {
        ...request,
        request: {
          ...request.request,
          input: {
            ...request.request.input,
            attendees: ["feishu://user/open-id/ou_model_invented"],
          },
        },
      },
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);

    await expect(policy.authorize(
      {
        ...request,
        request: {
          ...request.request,
          input: {
            ...request.request.input,
            authority_evidence: {
              ...(request.request.input.authority_evidence as object),
              confirmation_handoff_id: "handoff-other",
            },
          },
        },
      },
      new AbortController().signal,
    )).rejects.toThrow(/authority denied/i);
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
