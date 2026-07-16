import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyPersistenceProfile } from "@work-fabric/exchange-conformance";
import type { AtomicCommitRequest } from "@work-fabric/exchange-spi";
import {
  SqliteExchangePersistence,
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
