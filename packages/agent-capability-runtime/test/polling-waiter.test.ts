import { describe, expect, it, vi } from "vitest";

import { PollingAuxiliaryHandoffWaiter } from "../src/index.js";

const bound = {
  tenant_id: "tenant-a",
  original_handoff_id: "handoff-original",
  auxiliary_handoff_id: "handoff-aux",
  invocation_id: "invocation-1",
  candidate: {
    citizen_id: "feishu-actions",
    endpoint_id: "endpoint-feishu-actions",
    capability_id: "feishu.message.send",
    capability_version: "1.0.0",
    contract_digest: `sha256:${"a".repeat(64)}` as const,
  },
  contract: {
    candidate: {
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      capability_id: "feishu.message.send",
      capability_version: "1.0.0",
      contract_digest: `sha256:${"a".repeat(64)}` as const,
    },
    confirmation: "none" as const,
    risk: "medium" as const,
    operation_kind: "command" as const,
  },
  deadline: "2026-07-27T10:01:00.000Z",
};

function snapshot(lifecycle: string, outcome?: unknown) {
  return {
    tenant_id: "tenant-a",
    handoff_id: "handoff-aux",
    stream_version: 4,
    state: {
      lifecycle_state: lifecycle,
      result: outcome === undefined ? null : {
        summary: [{
          kind: "data",
          schema_ref: "urn:work-fabric:schema:capability-result:1",
          data: outcome,
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
  } as never;
}

describe("PollingAuxiliaryHandoffWaiter", () => {
  it("polls the public query and returns typed Provider facts", async () => {
    const getHandoff = vi.fn()
      .mockResolvedValueOnce(snapshot("accepted"))
      .mockResolvedValueOnce(snapshot("result_returned", {
        outcome: "succeeded",
        data: { message_id: "message-1" },
        artifacts: [],
      }));
    let now = "2026-07-27T10:00:00.000Z";
    const waiter = new PollingAuxiliaryHandoffWaiter({
      queries: { getHandoff },
      poll_interval_ms: 1,
      now: () => now,
      delay: async () => {
        now = "2026-07-27T10:00:00.001Z";
      },
    });

    await expect(waiter.wait(
      bound,
      new AbortController().signal,
    )).resolves.toEqual({
      outcome: "succeeded",
      data: { message_id: "message-1" },
      artifacts: [],
    });
    expect(getHandoff).toHaveBeenCalledTimes(2);
  });

  it("maps terminal Provider rejection and deadline without leaking raw snapshots", async () => {
    const waiter = new PollingAuxiliaryHandoffWaiter({
      queries: {
        getHandoff: async () => snapshot("result_returned", {
          outcome: "rejected",
          code: "target_not_allowed",
          message: "Message target is not authorized",
          retryable: false,
        }),
      },
      poll_interval_ms: 1,
      now: () => "2026-07-27T10:00:00.000Z",
      delay: async () => undefined,
    });
    await expect(waiter.wait(
      bound,
      new AbortController().signal,
    )).resolves.toMatchObject({
      outcome: "rejected",
      code: "target_not_allowed",
      retryable: false,
    });
  });

  it("preserves a Provider failure retry_after timestamp", async () => {
    const waiter = new PollingAuxiliaryHandoffWaiter({
      queries: {
        getHandoff: async () => snapshot("result_returned", {
          outcome: "failed",
          code: "github_rate_limited",
          message: "github_rate_limited",
          retryable: true,
          retry_after: "2026-07-27T10:00:30.000Z",
        }),
      },
      poll_interval_ms: 1,
      now: () => "2026-07-27T10:00:00.000Z",
      delay: async () => undefined,
    });

    await expect(waiter.wait(
      bound,
      new AbortController().signal,
    )).resolves.toEqual({
      outcome: "failed",
      code: "github_rate_limited",
      message: "github_rate_limited",
      retryable: true,
      retry_after: "2026-07-27T10:00:30.000Z",
    });
  });

  it("rejects an invalid Provider failure retry_after timestamp", async () => {
    const waiter = new PollingAuxiliaryHandoffWaiter({
      queries: {
        getHandoff: async () => snapshot("result_returned", {
          outcome: "failed",
          code: "github_rate_limited",
          message: "github_rate_limited",
          retryable: true,
          retry_after: "in one minute",
        }),
      },
      poll_interval_ms: 1,
      now: () => "2026-07-27T10:00:00.000Z",
      delay: async () => undefined,
    });

    await expect(waiter.wait(
      bound,
      new AbortController().signal,
    )).rejects.toThrow(/retry_after/i);
  });

  it.each([
    [{
      outcome: "rejected",
      code: "target_not_allowed",
      message: "not allowed",
      retryable: false,
      retry_after: "2026-07-27T10:00:30.000Z",
    }, "rejected retry_after"],
    [{
      outcome: "failed",
      code: "permanent_failure",
      message: "permanent failure",
      retryable: false,
      retry_after: "2026-07-27T10:00:30.000Z",
    }, "non-retryable retry_after"],
    [{
      outcome: "failed",
      code: "github_rate_limited",
      message: "github_rate_limited",
      retryable: true,
      retry_after: "2026-02-30T10:00:30.000Z",
    }, "invalid calendar timestamp"],
    [{
      outcome: "failed",
      code: "github_rate_limited",
      message: "github_rate_limited",
      retryable: true,
      unexpected: true,
    }, "unknown failure field"],
    [{
      outcome: "succeeded",
      data: { message_id: "message-1" },
      artifacts: [],
      retry_after: "2026-07-27T10:00:30.000Z",
    }, "success retry_after"],
  ])("rejects Provider outcome with %s", async (outcome, _label) => {
    const waiter = new PollingAuxiliaryHandoffWaiter({
      queries: {
        getHandoff: async () => snapshot("result_returned", outcome),
      },
      poll_interval_ms: 1,
      now: () => "2026-07-27T10:00:00.000Z",
      delay: async () => undefined,
    });

    await expect(waiter.wait(
      bound,
      new AbortController().signal,
    )).rejects.toThrow(/invalid|fields|retry_after/i);
  });
});
