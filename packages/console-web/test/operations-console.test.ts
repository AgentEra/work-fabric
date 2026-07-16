import { describe, expect, it } from "vitest";

import { renderOperations, type OperationsViewModel } from "../src/views/operations.js";

const model: OperationsViewModel = {
  projection: {
    tenant_id: "tenant-a", projector_id: "workfabric.collaboration.visibility.v1",
    partition_id: "north", checkpoint_position: 9, journal_position: 10,
    lag: 1, state: "lagging",
  },
  delivery: {
    tenant_id: "tenant-a", subscription_id: "sub-a", partition_id: "north",
    position: 8, active_delivery: null,
  },
  deliveryAttempts: [],
  deadLetters: [],
  connectorIngress: [{
    tenant_id: "tenant-a", connector_id: "feishu-a", ingress_id: "ingress-a",
    source_system: "feishu", external_event_id: "external-a", event_type: "message",
    state: "dead_letter", attempt: 3,
    available_at: "2026-07-16T00:00:00.000Z", accepted_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:01.000Z", completed_at: null,
    last_error_code: "mapping_invalid", last_requeued_at: null,
  }],
  discrepancies: [{
    discrepancy_id: "discrepancy-a", tenant_id: "tenant-a", connector_id: "feishu-a",
    external_object_id: "external-object-a", resource_id: "handoff-a",
    expected_state: "accepted", expected_version: 2, observed_state: "offered",
    observed_at: "2026-07-16T00:00:00.000Z", status: "open", version: 1,
    acknowledged_at: null, acknowledged_by: null,
  }],
  audit: [{
    tenant_id: "tenant-a", audit_id: "audit-a", occurred_at: "2026-07-16T00:00:00.000Z",
    request_id: "request-a", trace_id: null, principal_id: "operator-a",
    represented_actor: null, represented_endpoint_id: null, delegation_id: null,
    operation: "workfabric.operations.projection.read.v1", resource_kind: "partition",
    resource_id: "north", authorization_decision: "allowed", outcome: "succeeded",
    reason_code: null, service_category: "http",
  }],
};

describe("operations Console", () => {
  it("shows bounded operational facts and never renders connector payloads", () => {
    const html = renderOperations(model);
    expect(html).toContain("1 events awaiting visibility projection");
    expect(html).toContain("mapping_invalid");
    expect(html).toContain("discrepancy-a");
    expect(html).toContain("operator-a");
    expect(html).not.toContain("credential");
    expect(html).not.toContain("payload");
  });

  it("requires fenced, reasoned, explicitly confirmed recovery", () => {
    const html = renderOperations(model);
    expect(html).toContain('name="expectedVersion"');
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="confirmed"');
    expect(html.match(/required/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
