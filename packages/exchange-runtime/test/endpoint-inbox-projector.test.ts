import { describe, expect, it } from "vitest";

import { MemoryEndpointInboxStore } from "@work-fabric/adapter-endpoint-memory";
import type { EventRecord } from "@work-fabric/exchange-spi";

import { EndpointInboxProjector } from "../src/index.js";

function event(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    event_id: "event_01",
    event_type: "workfabric.handoff.offered.v1",
    schema_version: "1.0",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    request_message_id: "message_01",
    idempotency_key: "key_01",
    thread_id: "thread_01",
    handoff_id: "handoff_01",
    actor_id: "actor_sender",
    endpoint_id: "endpoint_sender",
    visibility: "participants",
    visible_actor_ids: ["actor_agent"],
    visible_endpoint_ids: ["endpoint_agent"],
    occurred_at: "2026-07-15T00:00:00Z",
    domain_data: { private_context: "must-not-be-projected" },
    protocol_data: {
      resource_version: 1,
      change: {
        change_type: "created",
        from_state: null,
        to_state: "offered",
        changed_fields: ["lifecycle_state"],
        details: {},
      },
      receipt: null,
    },
    partition_id: "handoff:handoff_01",
    partition_position: 1,
    stream_id: "handoff_01",
    stream_version: 1,
    commit_id: "commit_01",
    commit_ordinal: 0,
    ...overrides,
  };
}

const query = {
  tenant_id: "tenant_01",
  actor_id: "actor_agent",
  endpoint_id: "endpoint_agent",
  limit: 10,
};

describe("EndpointInboxProjector", () => {
  it("projects only routing facts for every visible audience", async () => {
    const store = new MemoryEndpointInboxStore();
    const projector = new EndpointInboxProjector(store);

    await projector.apply(event());

    await expect(store.listPartitions(query)).resolves.toEqual({
      items: [{
        partition_id: "handoff:handoff_01",
        latest_position: 1,
        active_handoff_count: 1,
      }],
    });
    await expect(store.listPartitions({
      ...query,
      actor_id: "actor_other",
      endpoint_id: "endpoint_other",
    })).resolves.toEqual({ items: [] });
  });

  it("ignores non-Handoff events", async () => {
    const store = new MemoryEndpointInboxStore();
    const projector = new EndpointInboxProjector(store);

    await projector.apply(event({ event_type: "workfabric.system.health.v1" }));

    await expect(store.listPartitions(query)).resolves.toEqual({ items: [] });
  });

  it("deactivates terminal Handoffs", async () => {
    const store = new MemoryEndpointInboxStore();
    const projector = new EndpointInboxProjector(store);
    await projector.apply(event());

    await projector.apply(event({
      event_id: "event_02",
      event_type: "workfabric.handoff.closed.v1",
      stream_version: 2,
      partition_position: 2,
      protocol_data: {
        resource_version: 2,
        change: {
          change_type: "closed",
          from_state: "verified",
          to_state: "closed",
          changed_fields: ["lifecycle_state"],
          details: {},
        },
        receipt: null,
      },
    }));

    await expect(store.listPartitions(query)).resolves.toEqual({ items: [] });
  });

  it("rebuilds one Tenant deterministically from committed records", async () => {
    const store = new MemoryEndpointInboxStore();
    const projector = new EndpointInboxProjector(store);
    await projector.apply(event({
      tenant_id: "tenant_other",
      handoff_id: "handoff_other",
      stream_id: "handoff_other",
      partition_id: "handoff:handoff_other",
    }));

    await projector.rebuild("tenant_01", [event()]);

    await expect(store.listPartitions(query)).resolves.toMatchObject({
      items: [{ partition_id: "handoff:handoff_01" }],
    });
    await expect(store.listPartitions({
      tenant_id: "tenant_other",
      actor_id: "actor_agent",
      endpoint_id: "endpoint_agent",
      limit: 10,
    })).resolves.toMatchObject({
      items: [{ partition_id: "handoff:handoff_other" }],
    });
  });
});
