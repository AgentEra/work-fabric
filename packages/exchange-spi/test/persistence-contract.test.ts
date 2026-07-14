import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_REQUIRED_CAPABILITIES,
  type EventRecord,
} from "../src/index.js";

describe("persistence contract", () => {
  it("requires the exact persistence capability profile", () => {
    expect(PERSISTENCE_REQUIRED_CAPABILITIES).toEqual([
      "expected_stream_version",
      "ordered_streams",
      "atomic_multi_stream_append",
      "transactional_idempotency",
      "partitioned_journal",
      "immutable_events",
    ]);
  });

  it("distinguishes stream order from partition order", () => {
    const record: EventRecord = {
      event_id: "event_01",
      event_type: "workfabric.handoff.offered.v1",
      schema_version: "1.0",
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      partition_id: "partition_01",
      partition_position: 7,
      stream_id: "handoff_01",
      stream_version: 2,
      commit_id: "commit_01",
      commit_ordinal: 0,
      request_message_id: "message_01",
      idempotency_key: "offer-01",
      thread_id: "thread_01",
      handoff_id: "handoff_01",
      actor_id: "actor_01",
      endpoint_id: "endpoint_01",
      visibility: "participants",
      visible_actor_ids: ["actor_01", "verifier_01"],
      visible_endpoint_ids: ["endpoint_01"],
      occurred_at: "2026-07-14T00:00:00Z",
      domain_data: { handoff_id: "handoff_01", lifecycle_state: "offered" },
      protocol_data: {
        resource_version: 2,
        change: {
          change_type: "created",
          from_state: null,
          to_state: "offered",
        },
        receipt: null,
      },
    };

    expect(record.stream_version).toBe(2);
    expect(record.partition_position).toBe(7);
  });
});
