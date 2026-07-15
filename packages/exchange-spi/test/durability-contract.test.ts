import { describe, expect, it } from "vitest";

import {
  DURABILITY_REQUIRED_CAPABILITIES,
  OUTBOX_REQUIRED_CAPABILITIES,
  WORKER_LEASE_REQUIRED_CAPABILITIES,
  type EventRecord,
  type OutboxClaim,
  type OutboxRecord,
  type OutboxStore,
  type WorkerLease,
  type WorkerLeaseStore,
} from "../src/index.js";

const event: EventRecord = {
  event_id: "event_01",
  event_type: "workfabric.test.v1",
  schema_version: "1.0",
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  partition_id: "partition_01",
  partition_position: 1,
  stream_id: "stream_01",
  stream_version: 1,
  commit_id: "commit_01",
  commit_ordinal: 0,
  request_message_id: "message_01",
  idempotency_key: "key_01",
  thread_id: "thread_01",
  handoff_id: "handoff_01",
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  visibility: "public",
  visible_actor_ids: [],
  visible_endpoint_ids: [],
  occurred_at: "2026-07-15T00:00:00Z",
  domain_data: { state: "offered" },
  protocol_data: { state: "offered" },
};

describe("durability SPI contract", () => {
  it("names the outbox and worker lease capability requirements", () => {
    expect(OUTBOX_REQUIRED_CAPABILITIES.length).toBeGreaterThan(0);
    expect(WORKER_LEASE_REQUIRED_CAPABILITIES.length).toBeGreaterThan(0);
    expect(DURABILITY_REQUIRED_CAPABILITIES).toEqual(
      expect.arrayContaining([
        ...OUTBOX_REQUIRED_CAPABILITIES,
        ...WORKER_LEASE_REQUIRED_CAPABILITIES,
      ]),
    );
  });

  it("keeps the technology-neutral records and ports assignable", async () => {
    const outbox: OutboxRecord = {
      outbox_id: "outbox_01",
      tenant_id: "tenant_01",
      partition_id: "partition_01",
      position: 1,
      event,
      attempt: 1,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
    };
    const claim: OutboxClaim = {
      owner: "worker_01",
      now: "2026-07-15T00:00:00Z",
      lease_seconds: 30,
      limit: 10,
      tenant_id: "tenant_01",
      partition_id: "partition_01",
    };
    const lease: WorkerLease = {
      lease_key: "worker:tenant_01:partition_01",
      owner: "worker_01",
      fencing_token: 1,
      expires_at: "2026-07-15T00:00:30Z",
    };

    const outboxStore: OutboxStore = {
      async claim() {
        return [outbox];
      },
      async markPublished() {
        return true;
      },
      async recordFailure() {
        return true;
      },
      async listPending() {
        return [outbox];
      },
    };
    const leaseStore: WorkerLeaseStore = {
      async acquire() {
        return lease;
      },
      async renew() {
        return true;
      },
      async release() {
        return true;
      },
    };

    expect(await outboxStore.claim(claim)).toEqual([outbox]);
    expect(await outboxStore.listPending(claim.tenant_id, claim.partition_id)).toEqual([
      outbox,
    ]);
    expect(
      await outboxStore.markPublished(outbox.outbox_id, claim.owner, 1),
    ).toBe(true);
    expect(
      await outboxStore.recordFailure(
        outbox.outbox_id,
        claim.owner,
        1,
        "2026-07-15T00:01:00Z",
      ),
    ).toBe(true);
    expect(await leaseStore.acquire(lease.lease_key, lease.owner, claim.now, 30)).toEqual(
      lease,
    );
    expect(await leaseStore.renew(lease.lease_key, lease.owner, 1, claim.now, 30)).toBe(
      true,
    );
    expect(await leaseStore.release(lease.lease_key, lease.owner, 1)).toBe(true);
  });
});
