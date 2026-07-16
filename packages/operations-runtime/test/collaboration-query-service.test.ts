import { describe, expect, it } from "vitest";

import { MemoryOperationsFixture } from "@work-fabric/adapter-operations-memory";
import type {
  CollaborationViewStore,
  ProjectionFreshnessSource,
  ResponsibilityView,
} from "@work-fabric/operations-spi";

import { StoreBackedCollaborationQueryService } from "../src/index.js";

const view: ResponsibilityView = {
  tenant_id: "tenant-1",
  partition_id: "partition-1",
  thread_id: "thread-1",
  handoff_id: "handoff-1",
  stream_version: 2,
  lifecycle_state: "accepted",
  initiator: { actor_id: "human-1", actor_type: "human" },
  recipient: { actor_id: "agent-1", actor_type: "agent" },
  current_responsible_actor: { actor_id: "agent-1", actor_type: "agent" },
  verifier: { actor_id: "human-1", actor_type: "human" },
  target_binding: null,
  work_reference: { uri: "urn:work:1" },
  priority: "normal",
  accept_by: "2026-07-17T00:00:00.000Z",
  result_due_at: "2026-07-18T00:00:00.000Z",
  latest_status: null,
  parent_handoff_id: null,
  child_handoff_id: null,
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T01:00:00.000Z",
};

const freshness: ProjectionFreshnessSource = {
  async load(tenantId, partitionId) {
    expect(tenantId).toBe("tenant-1");
    return {
      projector_id: "workfabric.collaboration.visibility.v1",
      partition_id: partitionId,
      projected_position: 7,
      journal_position: 9,
      observed_at: "2026-07-16T02:00:00.000Z",
    };
  },
};

describe("StoreBackedCollaborationQueryService", () => {
  it("adds explicit projection freshness to tenant-scoped pages", async () => {
    const stores = new MemoryOperationsFixture();
    await stores.collaboration.putResponsibility(view);
    const service = new StoreBackedCollaborationQueryService(
      stores.collaboration,
      freshness,
    );

    await expect(
      service.listResponsibilities("tenant-1", {
        partition_id: "partition-1",
        responsible_actor_id: "agent-1",
        limit: 10,
      }),
    ).resolves.toEqual({
      items: [view],
      next_cursor: null,
      freshness: {
        projector_id: "workfabric.collaboration.visibility.v1",
        partition_id: "partition-1",
        projected_position: 7,
        journal_position: 9,
        observed_at: "2026-07-16T02:00:00.000Z",
      },
    });
  });

  it("fails closed when an adapter returns a fact outside tenant or partition", async () => {
    const stores = new MemoryOperationsFixture();
    const malicious: CollaborationViewStore = {
      ...stores.collaboration,
      manifest: stores.collaboration.manifest,
      putResponsibility: (input) => stores.collaboration.putResponsibility(input),
      putTimeline: (input) => stores.collaboration.putTimeline(input),
      replaceHandoffRelationships: (...input) =>
        stores.collaboration.replaceHandoffRelationships(...input),
      getResponsibility: (...input) => stores.collaboration.getResponsibility(...input),
      async listResponsibilities() {
        return { items: [{ ...view, tenant_id: "other-tenant" }], next_cursor: null };
      },
      listTimeline: (input) => stores.collaboration.listTimeline(input),
      listRelationships: (input) => stores.collaboration.listRelationships(input),
      clearPartition: (...input) => stores.collaboration.clearPartition(...input),
    };
    const service = new StoreBackedCollaborationQueryService(malicious, freshness);

    await expect(
      service.listResponsibilities("tenant-1", {
        partition_id: "partition-1",
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [], next_cursor: null });
  });
});
