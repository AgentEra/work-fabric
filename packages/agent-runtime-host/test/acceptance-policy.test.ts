import { describe, expect, it } from "vitest";
import type { HandoffReadModel, ProtocolEvent } from "@work-fabric/sdk-typescript";

import { DeterministicAcceptancePolicy } from "../src/index.js";

const state = {
  lifecycle_state: "offered", recipient: null, current_responsible_actor: null,
  package: { target: { actor_id: "actor-1" }, authority_scope: { delegation_id: "d1", scopes: ["handoff.read"], resource_refs: ["handoff-1"], expires_at: "2026-07-27T00:00:00.000Z", may_redelegate: false }, accept_by: "2026-07-27T00:00:00.000Z" },
};
const snapshot = (overrides: Record<string, unknown> = {}): HandoffReadModel => ({ tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 1, state: { ...state, ...overrides }, latest_status: null } as unknown as HandoffReadModel);
const event = (type: string, actor = "other"): ProtocolEvent => ({ specversion: "1.0", id: "event-1", source: "urn:test", type, subject: "handoff-1", time: "2026-07-26T00:00:00.000Z", datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant-1", wfexchange: "exchange-1", wfthread: "thread-1", wfhandoff: "handoff-1", wfactor: actor, wfendpoint: "endpoint-1", wfsequence: 1, wfvisibility: "participants", data: {} });
const policy = new DeterministicAcceptancePolicy({ actor_id: "actor-1", endpoint_id: "endpoint-1", allowed_capability_ids: ["information.synthesis"] }, () => "2026-07-26T12:00:00.000Z");

describe("DeterministicAcceptancePolicy", () => {
  it("accepts direct Actor, Endpoint, and committed Capability targets", () => {
    expect(policy.decide(snapshot(), event("workfabric.handoff.offered.v1"), false)).toEqual({ kind: "accept" });
    expect(policy.decide(snapshot({ package: { ...state.package, target: { endpoint_id: "endpoint-1" } } }), event("workfabric.handoff.offered.v1"), false)).toEqual({ kind: "accept" });
    expect(policy.decide(snapshot({ package: { ...state.package, target: { capability_requirement: { capability_id: "information.synthesis" } }, }, target_binding: { target: { actor_id: "actor-1" } } }), event("workfabric.handoff.offered.v1"), false)).toEqual({ kind: "accept" });
  });

  it.each([
    ["unsupported capability", snapshot({ package: { ...state.package, target: { capability_requirement: { capability_id: "other.capability" } }, }, target_binding: { target: { actor_id: "actor-1" } } }), "unsupported_capability"],
    ["missing authority", snapshot({ package: { ...state.package, authority_scope: null } }), "authority_missing"],
    ["empty authority", snapshot({ package: { ...state.package, authority_scope: {} } }), "authority_missing"],
    ["expired", snapshot({ package: { ...state.package, accept_by: "2026-07-25T00:00:00.000Z" } }), "expired"],
    ["already running", snapshot(), "already_running"],
  ])("declines %s", (_name, handoff, code) => expect(policy.decide(handoff, event("workfabric.handoff.offered.v1"), code === "already_running")).toEqual({ kind: "decline", code }));

  it.each(["result_returned", "verified", "closed", "declined", "expired", "cancelled", "transferred", "target_unavailable"])("declines every terminal lifecycle", (lifecycle_state) => expect(policy.decide(snapshot({ lifecycle_state }), event("workfabric.handoff.offered.v1"), false)).toEqual({ kind: "decline", code: "terminal" }));
  it.each(["accepted", "rework_requested", "target_resolution_pending"])("ignores non-offered non-terminal lifecycle", (lifecycle_state) => expect(policy.decide(snapshot({ lifecycle_state }), event("workfabric.handoff.offered.v1"), false)).toEqual({ kind: "ignore", code: "not_offered" }));
  it("ignores own status or result redelivery", () => expect(policy.decide(snapshot(), event("workfabric.handoff.status_reported.v1", "actor-1"), false)).toEqual({ kind: "ignore", code: "own_update" }));
});
