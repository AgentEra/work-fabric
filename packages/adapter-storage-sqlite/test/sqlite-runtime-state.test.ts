import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AtomicCommitRequest, RuntimeSubscription } from "@work-fabric/exchange-spi";
import {
  SqliteExchangePersistence,
  SqliteRuntimeState,
  SqliteSession,
  migrateSqlite,
} from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function commitRequest(): AtomicCommitRequest {
  return {
    tenant_id: "tenant-local",
    partition_id: "partition-local",
    commit_id: "commit-local",
    idempotency_key: "key-local",
    payload_digest: "sha256:local",
    request_message_id: "message-local",
    outcome: { operation_status: "accepted", resource: null, receipt: null, error: null },
    version_checks: [],
    appends: [{
      stream_id: "stream-local",
      expected_version: 0,
      events: [{
        event_id: "event-local",
        event_type: "workfabric.handoff.offered.v1",
        schema_version: "1.0",
        exchange_id: "exchange-local",
        request_message_id: "message-local",
        idempotency_key: "key-local",
        thread_id: "thread-local",
        handoff_id: "handoff-local",
        actor_id: "actor-local",
        endpoint_id: "endpoint-local",
        visibility: "public",
        visible_actor_ids: [],
        visible_endpoint_ids: [],
        occurred_at: "2026-07-16T08:00:00.000000001Z",
        domain_data: {},
        protocol_data: {},
      }],
    }],
  };
}

function subscription(): RuntimeSubscription {
  return {
    subscription_id: "subscription-local",
    tenant_id: "tenant-local",
    owner: { actor_id: "actor-local", actor_type: "agent" },
    endpoint_id: "endpoint-local",
    filter: {
      event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
      handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [],
    },
    destination: {
      destination_id: "destination-local",
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z",
  };
}

describe("SQLite runtime state", () => {
  it("claims committed outbox facts and preserves fencing across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-runtime-"));
    directories.push(directory);
    const location = join(directory, "work-fabric.db");
    const firstSession = new SqliteSession({ location });
    migrateSqlite(firstSession);
    await new SqliteExchangePersistence(firstSession, "tenant-local")
      .commitAtomically(commitRequest());
    const first = new SqliteRuntimeState(firstSession, "tenant-local");
    const claimed = await first.claim({
      tenant_id: "tenant-local",
      partition_id: "partition-local",
      owner: "worker-a",
      now: "2026-07-16T08:00:01.000000001Z",
      lease_seconds: 30,
      limit: 10,
    });
    expect(claimed).toMatchObject([{
      outbox_id: "event-local",
      fencing_token: 1,
      lease_owner: "worker-a",
    }]);
    firstSession.close();

    const secondSession = new SqliteSession({ location });
    migrateSqlite(secondSession);
    const reopened = new SqliteRuntimeState(secondSession, "tenant-local");
    const reclaimed = await reopened.claim({
      tenant_id: "tenant-local",
      partition_id: "partition-local",
      owner: "worker-b",
      now: "2026-07-16T08:00:31.000000001Z",
      lease_seconds: 30,
      limit: 1,
    });
    expect(reclaimed[0]?.fencing_token).toBe(2);
    expect(await reopened.markPublished("event-local", "worker-a", 1)).toBe(false);
    expect(await reopened.markPublished("event-local", "worker-b", 2)).toBe(true);
    secondSession.close();
  });

  it("persists monotonic worker leases and immutable subscription identity", async () => {
    const session = new SqliteSession({ location: ":memory:" });
    migrateSqlite(session);
    const state = new SqliteRuntimeState(session, "tenant-local");
    const lease = await state.acquire(
      "projector:local",
      "worker-a",
      "2026-07-16T08:00:00.000Z",
      30,
    );
    expect(lease?.fencing_token).toBe(1);
    expect(await state.release("projector:local", "worker-a", 1)).toBe(true);
    expect((await state.acquire(
      "projector:local",
      "worker-b",
      "2026-07-16T08:00:01.000Z",
      30,
    ))?.fencing_token).toBe(2);

    const original = subscription();
    await state.putSubscription(original);
    await expect(state.getSubscription(original.subscription_id)).resolves.toEqual(original);
    await expect(state.putSubscription({
      ...original,
      tenant_id: "tenant-other",
      updated_at: "2026-07-16T08:00:01.000Z",
    })).rejects.toThrow(/tenant/i);
    await expect(state.putSubscription({
      ...original,
      owner: { actor_id: "stolen", actor_type: "agent" },
      updated_at: "2026-07-16T08:00:01.000Z",
    })).rejects.toThrow(/identity/i);
    session.close();
  });
});
