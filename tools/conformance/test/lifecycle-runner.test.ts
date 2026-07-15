import { describe, expect, it } from "vitest";

import {
  applyTransition,
  findTransition,
  loadLifecycle,
  type HandoffState,
  type LifecycleModel,
} from "../src/lifecycle-runner.js";

const lifecyclePath = "protocol/spec/handoff-lifecycle.json";

async function model(): Promise<LifecycleModel> {
  return loadLifecycle(lifecyclePath);
}

function conditions(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

describe("Handoff lifecycle model", () => {
  it("declares the authoritative initial and terminal states", async () => {
    const lifecycle = await model();

    expect(
      (lifecycle as LifecycleModel & { initial_states?: readonly string[] })
        .initial_states,
    ).toEqual(["target_resolution_pending", "offered"]);
    expect(lifecycle.terminal_states).toEqual([
      "target_unavailable",
      "closed",
      "declined",
      "expired",
      "cancelled",
      "transferred",
    ]);
  });

  it("executes the normal offer-to-close path", async () => {
    const lifecycle = await model();
    const offered = applyTransition(
      lifecycle,
      null,
      "handoff.offer",
      conditions("explicit_target"),
    );
    const accepted = applyTransition(
      lifecycle,
      offered.next_state,
      "handoff.accept",
      conditions("recipient_authorized", "context_available"),
    );
    const returned = applyTransition(
      lifecycle,
      accepted.next_state,
      "handoff.return_result",
      conditions("result_schema_valid", "authority_valid"),
    );
    const verified = applyTransition(
      lifecycle,
      returned.next_state,
      "handoff.verify",
      conditions("verifier_authorized", "criteria_satisfied"),
    );
    const closed = applyTransition(
      lifecycle,
      verified.next_state,
      "handoff.close",
      conditions("verifier_authorized"),
    );

    expect(closed.next_state).toBe("closed");
    expect(closed.event_type).toBe("workfabric.handoff.closed.v1");
  });

  it("keeps a Capability Offer pending until an external target is resolved", async () => {
    const lifecycle = await model();
    const pending = applyTransition(
      lifecycle,
      null,
      "handoff.offer",
      conditions("capability_target"),
    );
    const offered = applyTransition(
      lifecycle,
      pending.next_state,
      "handoff.resolve_target",
      conditions("resolver_authorized", "target_eligible"),
    );

    expect(pending.next_state).toBe("target_resolution_pending");
    expect(pending.event_type).toBe(
      "workfabric.handoff.target_resolution_requested.v1",
    );
    expect(offered.next_state).toBe("offered");
    expect(offered.event_type).toBe("workfabric.handoff.target_resolved.v1");
  });

  it("records an unavailable target resolution as a transparent terminal state", async () => {
    const lifecycle = await model();

    const unavailable = applyTransition(
      lifecycle,
      "target_resolution_pending" as HandoffState,
      "handoff.report_target_unavailable",
      conditions("resolver_authorized"),
    );

    expect(unavailable.next_state).toBe("target_unavailable");
    expect(unavailable.event_type).toBe(
      "workfabric.handoff.target_unavailable.v1",
    );
  });

  it.each([
    ["handoff.decline", "declined", []],
    ["handoff.expire", "expired", ["accept_by_elapsed"]],
    ["handoff.cancel", "cancelled", ["policy_allows_cancel"]],
  ] as const)("moves offered through %s to %s", async (interaction, state, required) => {
    const lifecycle = await model();
    const outcome = applyTransition(
      lifecycle,
      "offered",
      interaction,
      conditions(...required),
    );

    expect(outcome.next_state).toBe(state);
  });

  it("supports a verifier-requested rework loop", async () => {
    const lifecycle = await model();
    const rework = applyTransition(
      lifecycle,
      "result_returned",
      "handoff.request_rework",
      conditions("verifier_authorized", "rework_reason_provided"),
    );
    const accepted = applyTransition(
      lifecycle,
      rework.next_state,
      "handoff.accept",
      conditions("recipient_authorized", "context_available"),
    );

    expect(rework.next_state).toBe("rework_requested");
    expect(accepted.next_state).toBe("accepted");
  });

  it("rejects close before verification", async () => {
    const lifecycle = await model();

    expect(() =>
      applyTransition(
        lifecycle,
        "result_returned",
        "handoff.close",
        conditions("verifier_authorized"),
      ),
    ).toThrow("is not allowed from result_returned");
  });

  it("rejects mutation after a terminal state", async () => {
    const lifecycle = await model();

    expect(() =>
      applyTransition(lifecycle, "closed", "handoff.accept", conditions()),
    ).toThrow("terminal state closed");
  });

  it("rejects transitions with missing required conditions", async () => {
    const lifecycle = await model();

    expect(() =>
      applyTransition(
        lifecycle,
        "offered",
        "handoff.accept",
        conditions("recipient_authorized"),
      ),
    ).toThrow("Missing required conditions: context_available");
  });

  it("keeps the parent accepted until the child handoff is accepted", async () => {
    const lifecycle = await model();
    const transfer = applyTransition(
      lifecycle,
      "accepted",
      "handoff.transfer",
      conditions(
        "recipient_authorized",
        "redelegation_allowed",
        "child_explicit_target",
      ),
    );

    expect(transfer.next_state).toBe("accepted");
    expect(transfer.effects).toContainEqual({
      type: "create_child_handoff",
      child_initial_state: "offered",
    });

    const transferred = applyTransition(
      lifecycle,
      transfer.next_state,
      "handoff.child_accepted",
      conditions("child_handoff_accepted"),
    );

    expect(transferred.next_state).toBe("transferred");
    expect(transferred.event_type).toBe(
      "workfabric.handoff.transferred.v1",
    );
  });

  it("keeps a Capability-targeted child pending during transfer", async () => {
    const lifecycle = await model();

    const transfer = applyTransition(
      lifecycle,
      "accepted",
      "handoff.transfer",
      conditions(
        "recipient_authorized",
        "redelegation_allowed",
        "child_capability_target",
      ),
    );

    expect(transfer.next_state).toBe("accepted");
    expect(transfer.event_type).toBe(
      "workfabric.handoff.target_resolution_requested.v1",
    );
    expect(transfer.effects).toContainEqual({
      type: "create_child_handoff",
      child_initial_state: "target_resolution_pending",
    });
  });

  it("returns undefined for an unknown state/interaction pair", async () => {
    const lifecycle = await model();

    expect(
      findTransition(
        lifecycle,
        "accepted" as HandoffState,
        "handoff.unknown",
      ),
    ).toBeUndefined();
  });
});
