import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type { RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";
import { afterEach, describe, expect, it } from "vitest";

import {
  SchedulingSessionRepository,
  schedulingCorrelation,
} from "../src/scheduling-session.js";

const stores: MemoryAgentRuntimeStateStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function task(input: {
  readonly handoff_id?: string;
  readonly actor_id?: string;
  readonly sender?: string;
  readonly text?: string;
  readonly thread_id?: string;
} = {}): RuntimeTaskPackage {
  return {
    tenant_id: "tenant-1",
    handoff_id: input.handoff_id ?? "handoff-origin",
    thread_id: "thread-fabric-1",
    stream_version: 1,
    role: {
      role_id: "daily-assistant",
      version: 1,
      display_name: "日常助理",
      description: "团队共享日常助理",
      capability_ids: ["collaboration.request.intake"],
    },
    capability_id: "collaboration.request.intake",
    source_reference: {
      uri: `feishu://tenant-1/message/${input.handoff_id ?? "message-origin"}`,
      extensions: {
        "workfabric.dev/provider_family": "feishu",
        "workfabric.dev/resource_kind": "conversation_message",
        "workfabric.dev/conversation_resource_uri": "feishu://chat/oc-team",
        "workfabric.dev/sender_resource_uri":
          input.sender ?? "feishu://user/open-id/ou-initiator",
        "workfabric.dev/root_id": "om-root-1",
        ...(input.thread_id === undefined
          ? {}
          : { "workfabric.dev/thread_id": input.thread_id }),
      },
    },
    initiator: {
      actor_id: input.actor_id ?? "actor-initiator",
      actor_type: "human",
    },
    agent_private_context: null,
    intent: [{
      kind: "text",
      media_type: "text/plain",
      text: input.text ?? "安排 EDA 方案评审",
    }],
    context_reference: null,
    resolved_context: null,
    authority_scope: {},
    acceptance_criteria: [],
    priority: "normal",
    accept_by: "2026-07-30T01:30:00.000Z",
    result_due_at: "2026-07-30T02:00:00.000Z",
    workspace_path: "/tmp/work-fabric/handoff-origin",
  };
}

const proposal = {
  version: 1,
  title: "EDA 方案评审",
  participant_resource_uris: [
    "feishu://user/open-id/ou-initiator",
    "feishu://user/open-id/ou-reviewer",
  ],
  start_at: "2026-07-31T06:00:00.000Z",
  end_at: "2026-07-31T07:00:00.000Z",
  timezone: "Asia/Shanghai",
  summary_markdown: "请确认 EDA 方案评审排期。",
};

describe("SchedulingSessionRepository", () => {
  it("accepts protocol-safe null-prototype JSON objects from the Handoff loader", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store);
    const sourceTask = task();
    const source = Object.assign(
      Object.create(null) as Record<string, unknown>,
      sourceTask.source_reference,
    );
    source.extensions = Object.assign(
      Object.create(null) as Record<string, unknown>,
      sourceTask.source_reference.extensions,
    );

    await expect(repository.context({
      ...sourceTask,
      source_reference: source as RuntimeTaskPackage["source_reference"],
    })).resolves.toMatchObject({
      namespace: "daily-assistant.scheduling/v1",
      active_session: null,
    });
  });

  it("correlates a non-threaded group session by conversation and creates a versioned proposal", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const sourceTask = task();

    expect(schedulingCorrelation(sourceTask)).toEqual({
      key: "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
      conversation_resource_uri: "feishu://chat/oc-team",
      sender_resource_uri: "feishu://user/open-id/ou-initiator",
    });
    const saved = await repository.apply(sourceTask, {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });

    expect(saved).toMatchObject({
      version: 1,
      phase: "awaiting_confirmation",
      origin_handoff_id: "handoff-origin",
      origin_initiator_actor_id: "actor-initiator",
      origin_sender_resource_uri: "feishu://user/open-id/ou-initiator",
      correlation_key:
        "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
      proposal: {
        version: 1,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect((await repository.context(sourceTask)).active_session).toEqual(saved);
  });

  it("preserves multiline Markdown in a proposal summary", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store);

    const saved = await repository.apply(task(), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal: {
        ...proposal,
        summary_markdown:
          "## 日程提案\n\n- 时间：14:00–14:30\n- 请确认",
      },
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });

    expect(saved.proposal?.summary_markdown).toContain("\n\n- 时间");
  });

  it("increments proposal version and invalidates the previous confirmation", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const sourceTask = task();
    const first = await repository.apply(sourceTask, {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });
    const revised = await repository.apply(task({
      handoff_id: "handoff-revision",
      text: "改成 90 分钟",
    }), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: first.version,
      phase: "awaiting_confirmation",
      proposal: {
        ...proposal,
        version: 2,
        end_at: "2026-07-31T07:30:00.000Z",
      },
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: [
        "handoff-members-result-1",
        "handoff-freebusy-result-1",
      ],
    });

    expect(revised.proposal?.version).toBe(2);
    expect(revised.proposal?.digest).not.toBe(first.proposal?.digest);
    expect(revised.confirmed_proposal_digest).toBeNull();
    expect(revised.capability_result_handoff_ids).toEqual([
      "handoff-members-result-1",
      "handoff-freebusy-result-1",
    ]);
  });

  it("allows only the original Human to complete the current proposal", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const sourceTask = task();
    const proposed = await repository.apply(sourceTask, {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });
    const confirmedDigest = proposed.proposal?.digest;
    if (confirmedDigest === undefined) throw new Error("missing proposal");

    await expect(repository.apply(task({
      handoff_id: "handoff-other-confirmation",
      actor_id: "actor-other",
      sender: "feishu://user/open-id/ou-other",
      text: "可以",
    }), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: proposed.version,
      phase: "completed",
      proposal: null,
      confirmed_proposal_digest: confirmedDigest,
      confirmation_handoff_id: "handoff-other-confirmation",
      calendar_result_uri: "feishu://calendar/team/event/event-1",
      capability_result_handoff_ids: ["handoff-members-result-1"],
    })).rejects.toThrow(/original initiator/i);

    const completed = await repository.apply(task({
      handoff_id: "handoff-confirmation",
      text: "可以，就这么安排",
    }), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: proposed.version,
      phase: "completed",
      proposal: null,
      confirmed_proposal_digest: confirmedDigest,
      confirmation_handoff_id: "handoff-confirmation",
      calendar_result_uri: "feishu://calendar/team/event/event-1",
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });
    expect(completed).toMatchObject({
      phase: "completed",
      confirmed_proposal_digest: confirmedDigest,
      confirmation_handoff_id: "handoff-confirmation",
      calendar_result_uri: "feishu://calendar/team/event/event-1",
    });
  });

  it("allows only the original Human to cancel an uncreated proposal and makes the session inactive", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const proposed = await repository.apply(task(), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });
    const cancellation = {
      namespace: "daily-assistant.scheduling/v1" as const,
      expected_version: proposed.version,
      phase: "cancelled" as const,
      proposal: null,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: [],
    };

    await expect(repository.apply(task({
      handoff_id: "handoff-other-cancellation",
      actor_id: "actor-other",
      sender: "feishu://user/open-id/ou-other",
      text: "这个日程取消吧",
    }), cancellation)).rejects.toThrow(/original initiator/i);

    const cancelled = await repository.apply(task({
      handoff_id: "handoff-cancellation",
      text: "这个日程取消吧",
    }), cancellation);
    expect(cancelled).toMatchObject({
      version: 2,
      phase: "cancelled",
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: [],
    });
    await expect(repository.context(task({
      handoff_id: "handoff-next",
      text: "我未来三天还有其他日程吗",
    }))).resolves.toMatchObject({
      state_version: 2,
      active_session: null,
    });
  });

  it("rejects cancellation after side-effect execution has started", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store);

    await expect(repository.apply(task(), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "cancelled",
      proposal: null,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: [],
    })).rejects.toThrow(/active proposal/i);
  });

  it("starts a fresh conversation session after a terminal one", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const sourceTask = task();
    const proposed = await repository.apply(sourceTask, {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });
    await repository.apply(task({
      handoff_id: "handoff-confirmation",
    }), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: proposed.version,
      phase: "completed",
      proposal: null,
      confirmed_proposal_digest: proposed.proposal!.digest,
      confirmation_handoff_id: "handoff-confirmation",
      calendar_result_uri: "feishu://calendar/cal/events/event-1",
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });

    const nextTask = task({
      handoff_id: "handoff-next-origin",
      actor_id: "actor-next",
      sender: "feishu://user/open-id/ou-next",
      thread_id: "om-new-thread",
    });
    await expect(repository.context(nextTask)).resolves.toMatchObject({
      state_version: 2,
      active_session: null,
      original_initiator: {
        actor_id: "actor-next",
        sender_resource_uri: "feishu://user/open-id/ou-next",
      },
    });
    const next = await repository.apply(nextTask, {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 2,
      phase: "awaiting_confirmation",
      proposal: { ...proposal, version: 1 },
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-next-members"],
    });
    expect(next).toMatchObject({
      version: 3,
      origin_handoff_id: "handoff-next-origin",
      origin_initiator_actor_id: "actor-next",
      origin_sender_resource_uri: "feishu://user/open-id/ou-next",
      proposal: { version: 1 },
    });
  });

  it("does not let another group member replace the active proposal", async () => {
    const store = new MemoryAgentRuntimeStateStore();
    stores.push(store);
    const repository = new SchedulingSessionRepository(store);
    const proposed = await repository.apply(task(), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "awaiting_confirmation",
      proposal,
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    });

    await expect(repository.apply(task({
      handoff_id: "handoff-other-revision",
      actor_id: "actor-other",
      sender: "feishu://user/open-id/ou-other",
    }), {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: proposed.version,
      phase: "awaiting_confirmation",
      proposal: { ...proposal, version: 2 },
      confirmed_proposal_digest: null,
      confirmation_handoff_id: null,
      calendar_result_uri: null,
      capability_result_handoff_ids: ["handoff-members-result-1"],
    })).rejects.toThrow(/original initiator/i);
  });
});
