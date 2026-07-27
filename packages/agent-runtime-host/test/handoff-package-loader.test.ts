import { describe, expect, it, vi } from "vitest";
import type { HandoffReadModel, ProtocolEvent } from "@work-fabric/sdk-typescript";

import { HandoffPackageLoader } from "../src/index.js";

const role = { role_id: "daily-assistant", version: 1, display_name: "Daily Assistant", description: "Shared", capability_ids: ["information.synthesis"] } as const;
const snapshot: HandoffReadModel = {
  tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 2,
  state: {
    handoff_id: "handoff-1", thread_id: "thread-1", resource_version: 2, lifecycle_state: "offered",
    initiator: { actor_id: "human-1", actor_type: "human" }, recipient: null,
    verifier: { actor_id: "human-1", actor_type: "human" }, current_responsible_actor: null,
    target_binding: null, active_claim: null, claim_fencing_token: 0,
    package: {
      work_reference: { uri: "work://1" }, target: { actor_id: "actor-1" }, intent: [{ type: "text", text: "Summarize" }], context: { context_id: "context-1", version: 1, digest: "sha256:abc" },
      authority_scope: { delegation_id: "delegation-1", scopes: ["handoff.read"], resource_refs: ["handoff-1"], expires_at: "2026-07-27T00:00:00.000Z", may_redelegate: false },
      acceptance_criteria: [], verifier: { actor_id: "human-1", actor_type: "human" }, priority: "normal", accept_by: "2026-07-27T00:00:00.000Z", result_due_at: "2026-07-28T00:00:00.000Z",
    }, result: null, parent_handoff_id: null, child_handoff_id: null, created_at: "2026-07-26T00:00:00.000Z", updated_at: "2026-07-26T00:00:00.000Z",
  }, latest_status: null,
};
const snapshotPackage = snapshot.state as unknown as {
  readonly package: { readonly intent: readonly unknown[]; readonly acceptance_criteria: readonly unknown[] };
};

function event(sequence: number): ProtocolEvent {
  return { specversion: "1.0", id: `event-${sequence}`, source: "urn:test", type: "workfabric.handoff.offered.v1", subject: "handoff-1", time: "2026-07-26T00:00:00.000Z", datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant-1", wfexchange: "exchange-1", wfthread: "thread-1", wfhandoff: "handoff-1", wfactor: "actor-1", wfendpoint: "endpoint-1", wfsequence: sequence, wfvisibility: "participants", data: { arbitrary: "provenance only" } };
}

describe("HandoffPackageLoader", () => {
  it("loads execution input from getHandoff state and uses events only for provenance", async () => {
    const client = { getHandoff: vi.fn(async () => structuredClone(snapshot)), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    const loaded = await new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1");
    expect(loaded.task.intent).toEqual(snapshotPackage.package.intent);
    expect(loaded.task.acceptance_criteria).toEqual(snapshotPackage.package.acceptance_criteria);
    expect(loaded.task.stream_version).toBe(snapshot.stream_version);
    expect(client.listHandoffEvents).toHaveBeenCalledWith("handoff-1", expect.objectContaining({ fromVersion: 1, limit: 100 }));
  });

  it("accepts the protocol assignment mode in a resolved Capability requirement", async () => {
    const resolved = structuredClone(snapshot) as unknown as {
      state: {
        package: { target: { capability_requirement: Record<string, unknown> } };
        target_binding: unknown;
      };
    };
    resolved.state.package.target = {
      capability_requirement: {
        capability_id: "information.synthesis",
        assignment_mode: "external_resolution",
      },
    };
    resolved.state.target_binding = {
      target: { endpoint_id: "endpoint-1" },
      resolved_by: { actor_id: "resolver-1", actor_type: "system" },
      resolver_endpoint_id: "endpoint-resolver",
      delegation_id: null,
      resolved_at: "2026-07-26T00:00:00.000Z",
      evidence: [],
    };
    const client = {
      getHandoff: vi.fn(async () => resolved as unknown as HandoffReadModel),
      listHandoffEvents: vi.fn(async () => [event(1), event(2)]),
    };

    await expect(
      new HandoffPackageLoader(
        client,
        "tenant-1",
        role,
        () => "2026-07-26T12:00:00.000Z",
      ).load("handoff-1", "/workspace/t1/h1"),
    ).resolves.toMatchObject({
      task: { capability_id: "information.synthesis" },
    });
  });

  it("rejects gapped or unbounded provenance streams", async () => {
    const client = { getHandoff: vi.fn(async () => structuredClone(snapshot)), listHandoffEvents: vi.fn(async () => [event(1), event(3)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).rejects.toThrow("event_sequence");
  });

  it("keeps an authorized absent Context as metadata without materializing it", async () => {
    const withoutContext = structuredClone(snapshot) as unknown as { state: { package: { context: null } } };
    withoutContext.state.package.context = null;
    const client = { getHandoff: vi.fn(async () => withoutContext as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).resolves.toMatchObject({ task: { context_reference: null } });
  });

  it("accepts a public Context reference whose digest is unavailable", async () => {
    const unavailableDigest = structuredClone(snapshot) as unknown as { state: { package: { context: { digest: null } } } };
    unavailableDigest.state.package.context.digest = null;
    const client = { getHandoff: vi.fn(async () => unavailableDigest as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).resolves.toMatchObject({ task: { context_reference: { digest: null } } });
  });

  it("rejects non-JSON values and returns detached frozen public values", async () => {
    const unsafe = structuredClone(snapshot) as unknown as { state: { package: { intent: unknown[] } } };
    unsafe.state.package.intent = [new Date()];
    const unsafeClient = { getHandoff: vi.fn(async () => unsafe as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(unsafeClient, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).rejects.toThrow("invalid_snapshot");

    const source = structuredClone(snapshot);
    const client = { getHandoff: vi.fn(async () => source), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    const loaded = await new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1");
    (source.state as { package: { intent: [{ text: string }] } }).package.intent[0].text = "mutated";
    expect(loaded.task.intent[0]).toMatchObject({ text: "Summarize" });
    expect(Object.isFrozen(loaded.snapshot)).toBe(true);
    expect(Object.isFrozen(loaded.events)).toBe(true);
    expect(Object.isFrozen(loaded.task)).toBe(true);
  });

  it("rejects invalid calendar timestamps before producing a task", async () => {
    const invalidCalendar = structuredClone(snapshot) as unknown as { state: { package: { accept_by: string } } };
    invalidCalendar.state.package.accept_by = "2026-02-30T00:00:00Z";
    const client = { getHandoff: vi.fn(async () => invalidCalendar as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-01-01T00:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).rejects.toThrow("expired_timestamp");
  });

  it("preserves nanosecond deadline ordering beyond Date millisecond precision", async () => {
    const nanos = structuredClone(snapshot) as unknown as { state: { package: { authority_scope: { expires_at: string }; accept_by: string; result_due_at: string } } };
    nanos.state.package.authority_scope.expires_at = "2026-07-26T12:00:00.000000003Z";
    nanos.state.package.accept_by = "2026-07-26T12:00:00.000000002Z";
    nanos.state.package.result_due_at = "2026-07-26T12:00:00.000000004Z";
    const client = { getHandoff: vi.fn(async () => nanos as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000000001Z").load("handoff-1", "/workspace/t1/h1")).resolves.toMatchObject({ task: { accept_by: "2026-07-26T12:00:00.000000002Z" } });
  });

  it("keeps accepting deadlines for an already accepted execution snapshot while enforcing its execution deadlines", async () => {
    const accepted = structuredClone(snapshot) as unknown as {
      state: { lifecycle_state: string; package: { accept_by: string; result_due_at: string; authority_scope: { expires_at: string } } };
    };
    accepted.state.lifecycle_state = "accepted";
    accepted.state.package.accept_by = "2026-07-26T11:59:59.000Z";
    accepted.state.package.result_due_at = "2026-07-26T13:00:00.000Z";
    accepted.state.package.authority_scope.expires_at = "2026-07-26T13:00:00.000Z";
    const client = { getHandoff: vi.fn(async () => accepted as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };

    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1", { mode: "accepted" })).resolves.toMatchObject({ task: { accept_by: "2026-07-26T11:59:59Z" } });
  });

  it("still rejects an expired accepting deadline while the execution snapshot remains offered", async () => {
    const expiredOffer = structuredClone(snapshot) as unknown as { state: { package: { accept_by: string } } };
    expiredOffer.state.package.accept_by = "2026-07-26T11:59:59.000Z";
    const client = { getHandoff: vi.fn(async () => expiredOffer as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };

    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).rejects.toThrow("expired_timestamp");
  });

  it("rejects accessor-backed arrays without invoking their getters", async () => {
    let reads = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get() { reads += 1; return { type: "text", text: "unsafe" }; } });
    const unsafe = structuredClone(snapshot) as unknown as { state: { package: { intent: unknown[] } } };
    unsafe.state.package.intent = accessorArray;
    const client = { getHandoff: vi.fn(async () => unsafe as unknown as HandoffReadModel), listHandoffEvents: vi.fn(async () => [event(1), event(2)]) };
    await expect(new HandoffPackageLoader(client, "tenant-1", role, () => "2026-07-26T12:00:00.000Z").load("handoff-1", "/workspace/t1/h1")).rejects.toThrow("invalid_snapshot");
    expect(reads).toBe(0);
  });
});
