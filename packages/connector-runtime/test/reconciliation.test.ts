import { describe, expect, it } from "vitest";

import {
  ConnectorReconciliationService,
  type ConnectorDiscrepancy,
} from "../src/index.js";

describe("ConnectorReconciliationService", () => {
  it("does nothing when external observation matches the expected fact", async () => {
    const discrepancies: ConnectorDiscrepancy[] = [];
    const service = new ConnectorReconciliationService({
      expected_state: {
        async getExpectedState() {
          return { resource_id: "handoff-1", state: "accepted", version: 4 };
        },
      },
      discrepancies: {
        async put(discrepancy) { discrepancies.push(discrepancy); },
      },
    });
    await expect(service.reconcile({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_object_id: "om-1",
      observed_state: "accepted",
      observed_at: "2026-07-16T00:00:00Z",
      metadata: {},
    })).resolves.toEqual({ kind: "matched" });
    expect(discrepancies).toEqual([]);
  });

  it("records a deterministic discrepancy without mutating either side", async () => {
    const discrepancies: ConnectorDiscrepancy[] = [];
    const expected = { resource_id: "handoff-1", state: "accepted", version: 4 };
    const service = new ConnectorReconciliationService({
      expected_state: { async getExpectedState() { return expected; } },
      discrepancies: {
        async put(discrepancy) { discrepancies.push(structuredClone(discrepancy)); },
      },
    });
    const input = {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_object_id: "om-1",
      observed_state: "declined",
      observed_at: "2026-07-16T00:00:00Z",
      metadata: { source: "delivery_receipt" },
    } as const;
    const first = await service.reconcile(input);
    const replay = await service.reconcile(structuredClone(input));
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      kind: "discrepancy",
      discrepancy: {
        expected_state: "accepted",
        observed_state: "declined",
        expected_version: 4,
      },
    });
    expect(discrepancies[0]?.discrepancy_id).toBe(
      discrepancies[1]?.discrepancy_id,
    );
    expect(expected).toEqual({
      resource_id: "handoff-1",
      state: "accepted",
      version: 4,
    });
    expect(input.observed_state).toBe("declined");
  });

  it("rejects credential-shaped or oversized observation metadata", async () => {
    const service = new ConnectorReconciliationService({
      expected_state: { async getExpectedState() { return null; } },
      discrepancies: { async put() { throw new Error("must not write"); } },
      metadata_limits: { max_payload_bytes: 64, max_json_depth: 3 },
    });
    await expect(service.reconcile({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_object_id: "om-1",
      observed_state: "delivered",
      observed_at: "2026-07-16T00:00:00Z",
      metadata: { access_token: "must-not-enter-observations" },
    })).rejects.toThrow(/credential-shaped/i);
    await expect(service.reconcile({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_object_id: "om-1",
      observed_state: "delivered",
      observed_at: "2026-07-16T00:00:00Z",
      metadata: { detail: "x".repeat(128) },
    })).rejects.toThrow(/byte limit/i);
  });
});
