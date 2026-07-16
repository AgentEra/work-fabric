import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyPersistenceProfile } from "@work-fabric/exchange-conformance";
import type { AtomicCommitRequest } from "@work-fabric/exchange-spi";
import {
  SqliteExchangePersistence,
  SqlitePartitionJournalPositionSource,
  SqliteSession,
  migrateSqlite,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function request(tenantId = "tenant-local"): AtomicCommitRequest {
  return {
    tenant_id: tenantId,
    partition_id: "partition-local",
    commit_id: "commit-local",
    idempotency_key: "key-local",
    payload_digest: "sha256:local",
    request_message_id: "message-local",
    outcome: {
      operation_status: "accepted",
      resource: { handoff_id: "handoff-local" },
      receipt: { receipt_id: "receipt-local" },
      error: null,
    },
    version_checks: [],
    appends: [{
      stream_id: "handoff-local",
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
        visibility: "participants",
        visible_actor_ids: ["actor-local"],
        visible_endpoint_ids: ["endpoint-local"],
        occurred_at: "2026-07-16T08:00:00.000Z",
        domain_data: { state: "offered" },
        protocol_data: { state: "offered" },
      }],
    }],
  };
}

function memoryStore(tenantId = "tenant_01") {
  const session = new SqliteSession({ location: ":memory:" });
  migrateSqlite(session);
  return new SqliteExchangePersistence(session, tenantId);
}

describe("SQLite Exchange persistence", () => {
  it("passes the technology-neutral persistence profile", async () => {
    await verifyPersistenceProfile(() => memoryStore());
  });

  it("enables foreign keys, busy timeout, and WAL for a local file", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-sqlite-"));
    temporaryDirectories.push(directory);
    const session = new SqliteSession({
      location: join(directory, "work-fabric.db"),
      busy_timeout_ms: 2_500,
    });
    migrateSqlite(session);
    expect(session.pragma("foreign_keys")).toBe(1);
    expect(session.pragma("busy_timeout")).toBe(2_500);
    expect(String(session.pragma("journal_mode")).toLowerCase()).toBe("wal");
    session.close();
  });

  it("reopens committed facts and isolates a trusted tenant session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-sqlite-"));
    temporaryDirectories.push(directory);
    const location = join(directory, "work-fabric.db");
    const firstSession = new SqliteSession({ location });
    migrateSqlite(firstSession);
    const first = new SqliteExchangePersistence(firstSession, "tenant-local");
    await expect(first.commitAtomically(request())).resolves.toMatchObject({
      kind: "committed",
    });
    firstSession.close();

    const secondSession = new SqliteSession({ location });
    migrateSqlite(secondSession);
    const reopened = new SqliteExchangePersistence(secondSession, "tenant-local");
    await expect(reopened.readStream("handoff-local")).resolves.toMatchObject([
      { event_id: "event-local", stream_version: 1, partition_position: 1 },
    ]);
    await expect(reopened.findCommand("tenant-local", "key-local"))
      .resolves.toMatchObject({ payload_digest: "sha256:local" });
    await expect(reopened.commitAtomically(request("tenant-other")))
      .rejects.toThrow(/tenant/i);
    secondSession.close();
  });

  it("reads partition high-water directly from the journal index", async () => {
    const session = new SqliteSession({ location: ":memory:" });
    migrateSqlite(session);
    const persistence = new SqliteExchangePersistence(session, "tenant-local");
    await persistence.commitAtomically(request());
    const positions = new SqlitePartitionJournalPositionSource(
      session,
      "tenant-local",
    );

    await expect(positions.load("tenant-local", "partition-local"))
      .resolves.toBe(1);
    await expect(positions.load("tenant-local", "partition-missing"))
      .resolves.toBeNull();
    await expect(positions.load("tenant-other", "partition-local"))
      .resolves.toBeNull();
    session.close();
  });

  it("bounds operational history reads with storage-side keysets", async () => {
    const session = new SqliteSession({ location: ":memory:" });
    migrateSqlite(session);
    const persistence = new SqliteExchangePersistence(session, "tenant-local");
    await persistence.commitAtomically(request());
    const event = (await persistence.readPartition("partition-local", 0, 1))[0]!;
    await persistence.putProjectionFailure({
      projector_id: "projector-local",
      partition_id: "partition-local",
      event_id: "event-a",
      position: 1,
      reason: "failed-a",
      recorded_at: "2026-07-16T08:00:01.000Z",
    });
    await persistence.putProjectionFailure({
      projector_id: "projector-local",
      partition_id: "partition-local",
      event_id: "event-b",
      position: 2,
      reason: "failed-b",
      recorded_at: "2026-07-16T08:00:02.000Z",
    });
    await persistence.recordDeliveryAttempt({
      subscription_id: "subscription-local",
      partition_id: "partition-local",
      event_id: event.event_id,
      attempt: 1,
      attempted_at: "2026-07-16T08:00:01.000Z",
      outcome: "accepted",
      detail: null,
      next_attempt_at: null,
    });
    await persistence.putDeadLetter({
      subscription_id: "subscription-local",
      event,
      attempts: 2,
      reason: "delivery failed",
      recorded_at: "2026-07-16T08:00:03.000Z",
    });

    await expect(persistence.scanProjectionFailures({
      tenant_id: "tenant-local",
      projector_id: "projector-local",
      partition_id: "partition-local",
      after: { position: 1, event_id: "event-a" },
      limit: 1,
    })).resolves.toMatchObject([{ event_id: "event-b" }]);
    await expect(persistence.scanDeliveryAttempts({
      tenant_id: "tenant-local",
      subscription_id: "subscription-local",
      event_id: event.event_id,
      after: null,
      limit: 1,
    })).resolves.toHaveLength(1);
    await expect(persistence.scanDeadLetters({
      tenant_id: "tenant-local",
      subscription_id: "subscription-local",
      after: null,
      limit: 1,
    })).resolves.toMatchObject([{ event: { event_id: event.event_id } }]);
    session.close();
  });

  it("rejects a changed migration checksum", () => {
    const session = new SqliteSession({ location: ":memory:" });
    migrateSqlite(session);
    expect(() => migrateSqlite(session, [{
      id: "001_exchange",
      sql: "SELECT 1;",
    }])).toThrow(/checksum/i);
    session.close();
  });
});
