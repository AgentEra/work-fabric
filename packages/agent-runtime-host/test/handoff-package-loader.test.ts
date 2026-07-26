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
    target_binding: null,
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
    expect(client.listHandoffEvents).toHaveBeenCalledWith("handoff-1", expect.objectContaining({ fromVersion: 1, limit: 256 }));
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
});
