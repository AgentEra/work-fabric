import { describe, expect, it } from "vitest";

import { MemoryAuditStore } from "@work-fabric/adapter-operations-memory";
import type { AuditRecord, AuditStore } from "@work-fabric/operations-spi";

import { OperationAuditRecorder } from "../src/index.js";

const base = {
  tenant_id: "tenant-1",
  request_id: "request-1",
  trace_id: "0123456789abcdef0123456789abcdef",
  principal_id: "principal-1",
  represented_actor: { actor_id: "actor-1", actor_type: "agent" as const },
  represented_endpoint_id: "endpoint-1",
  delegation_id: null,
  operation: "workfabric.query.timeline.list.v1",
  resource_kind: "partition",
  resource_id: "partition-1",
  authorization_decision: "allowed" as const,
  outcome: "succeeded" as const,
  reason_code: null,
  service_category: "http" as const,
};

describe("OperationAuditRecorder", () => {
  it("builds deterministic bounded records and makes retries idempotent", async () => {
    const store = new MemoryAuditStore({ cursor_secret: "audit-test-secret" });
    const recorder = new OperationAuditRecorder(store, {
      now: () => "2026-07-16T04:00:00.000Z",
    });

    await expect(recorder.record(base)).resolves.toBe(true);
    await expect(recorder.record(structuredClone(base))).resolves.toBe(true);

    const records = await store.list({ tenant_id: "tenant-1", limit: 10 });
    expect(records.items).toHaveLength(1);
    expect(records.items[0]).toMatchObject({
      audit_id: expect.stringMatching(/^audit_[A-Za-z0-9_-]+$/),
      occurred_at: "2026-07-16T04:00:00.000Z",
      operation: base.operation,
      resource_id: "partition-1",
    });
    expect(JSON.stringify(records.items[0])).not.toMatch(
      /bearer\s|password|secret-value/i,
    );
    expect(recorder.status()).toEqual({
      healthy: true,
      failed_writes: 0,
      last_failure_at: null,
    });
  });

  it("contains store failures and exposes degraded health without exception detail", async () => {
    const failed: AuditStore = {
      manifest: new MemoryAuditStore().manifest,
      async append(_record: AuditRecord) { throw new Error("Bearer secret-value"); },
      async list() { return { items: [], next_cursor: null }; },
      async pruneBefore() { return 0; },
    };
    const recorder = new OperationAuditRecorder(failed, {
      now: () => "2026-07-16T04:00:00.000Z",
    });

    await expect(recorder.record(base)).resolves.toBe(false);
    expect(recorder.status()).toEqual({
      healthy: false,
      failed_writes: 1,
      last_failure_at: "2026-07-16T04:00:00.000Z",
    });
    expect(JSON.stringify(recorder.status())).not.toContain("secret-value");
  });

  it("stages trusted authorization facts and completes from a bounded HTTP result", async () => {
    const store = new MemoryAuditStore();
    const recorder = new OperationAuditRecorder(store, {
      now: () => "2026-07-16T04:00:00.000Z",
    });
    recorder.stageHttp("request-2", {
      tenant_id: "tenant-1",
      trace_id: null,
      principal_id: "principal-1",
      represented_actor: null,
      represented_endpoint_id: null,
      delegation_id: null,
      operation: "workfabric.query.timeline.list.v1",
      resource_kind: "partition",
      resource_id: "partition-2",
      authorization_decision: "denied",
    });

    await expect(recorder.completeHttp("request-2", 403)).resolves.toBe(true);
    await expect(recorder.completeHttp("request-2", 403)).resolves.toBe(false);
    const record = (await store.list({ tenant_id: "tenant-1", limit: 10 })).items[0];
    expect(record).toMatchObject({
      authorization_decision: "denied",
      outcome: "failed",
      reason_code: "http_403",
    });
  });
});
