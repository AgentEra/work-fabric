import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricClient,
  WorkFabricTransportError,
} from "../src/index.js";

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: typeof globalThis.fetch) {
  return new WorkFabricClient({
    baseUrl: "https://fabric.example.test/api",
    tenantId: "tenant-1",
    exchangeId: "exchange-1",
    representation: { actorId: "actor-1", endpointId: "endpoint-1" },
    authentication: new BearerTokenProvider("token"),
    fetch,
    queryRetry: { maxRetries: 0 },
  });
}

describe("OperationsClient visibility", () => {
  it("maps every operational visibility resource through the shared transport", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/operations/cluster")) return response({
        state: "running", ready_items: 3, in_flight_turns: 2,
        completed_turns: 9, lease_losses: 1, dropped_wakeups: 4,
        observed_at: "2026-07-16T08:00:00.000Z",
      });
      if (url.includes("/projections/")) return response({
        tenant_id: "tenant-1", projector_id: "projector / 1", partition_id: "partition / 1",
        checkpoint_position: 4, journal_position: 5, lag: 1, state: "lagging",
      });
      if (url.includes("/deliveries/")) return response({
        tenant_id: "tenant-1", subscription_id: "subscription / 1",
        partition_id: "partition / 1", position: 3, active_delivery: null,
      });
      if (url.includes("/ingress/ingress")) return response({
        tenant_id: "tenant-1", connector_id: "connector / 1", ingress_id: "ingress / 1",
        source_system: "feishu", external_event_id: "event-1", event_type: "updated",
        state: "pending", attempt: 0, available_at: "2026-07-16T00:00:00.000Z",
        accepted_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
        completed_at: null, last_error_code: null, last_requeued_at: null,
      });
      if (url.includes("/discrepancies/discrepancy")) return response({
        discrepancy_id: "discrepancy / 1", tenant_id: "tenant-1",
        connector_id: "connector / 1", external_object_id: "external-1",
        resource_id: null, expected_state: null, expected_version: null,
        observed_state: "declined", observed_at: "2026-07-16T00:00:00.000Z",
        status: "open", version: 1, acknowledged_at: null, acknowledged_by: null,
      });
      if (url.includes("/audit")) return response({ items: [{
        tenant_id: "tenant-1", audit_id: "audit-1", occurred_at: "2026-07-16T00:00:00.000Z",
        request_id: "request-1", trace_id: null, principal_id: "principal-1",
        represented_actor: null, represented_endpoint_id: null, delegation_id: null,
        operation: "workfabric.operations.audit.read.v1", resource_kind: "tenant",
        resource_id: "tenant-1", authorization_decision: "allowed", outcome: "succeeded",
        reason_code: null, service_category: "http",
      }], next_cursor: null });
      return response({ items: [], next_cursor: null });
    }) as unknown as typeof globalThis.fetch;
    const operations = client(fetch).operations;

    await operations.getProjectionStatus({ projectorId: "projector / 1", partitionId: "partition / 1" });
    await operations.listProjectionFailurePage({ projectorId: "projector / 1", partitionId: "partition / 1", limit: 10 });
    await operations.getDeliveryState({ subscriptionId: "subscription / 1", partitionId: "partition / 1" });
    await operations.listDeliveryAttemptPage({ subscriptionId: "subscription / 1", eventId: "event / 1", limit: 5 });
    await operations.listDeadLetters({ subscriptionId: "subscription / 1", limit: 5 });
    await operations.listConnectorIngress({ connectorId: "connector / 1", states: ["retry_wait"], limit: 5 });
    await operations.getConnectorIngress({ connectorId: "connector / 1", ingressId: "ingress / 1" });
    await operations.listDiscrepancies({ connectorId: "connector / 1", statuses: ["open"], limit: 5 });
    await operations.getDiscrepancy({ connectorId: "connector / 1", discrepancyId: "discrepancy / 1" });
    await operations.listAudit({ outcome: "succeeded", limit: 5 });
    await expect(operations.getClusterSnapshot()).resolves.toMatchObject({
      state: "running",
      ready_items: 3,
    });

    expect(urls).toEqual([
      "https://fabric.example.test/api/v1/operations/projections/projector%20%2F%201/partitions/partition%20%2F%201",
      "https://fabric.example.test/api/v1/operations/projection-failures?projector_id=projector+%2F+1&partition_id=partition+%2F+1&limit=10",
      "https://fabric.example.test/api/v1/operations/deliveries/subscription%20%2F%201/partitions/partition%20%2F%201",
      "https://fabric.example.test/api/v1/operations/delivery-attempts?subscription_id=subscription+%2F+1&event_id=event+%2F+1&limit=5",
      "https://fabric.example.test/api/v1/operations/dead-letters?subscription_id=subscription+%2F+1&limit=5",
      "https://fabric.example.test/api/v1/operations/connectors/connector%20%2F%201/ingress?state=retry_wait&limit=5",
      "https://fabric.example.test/api/v1/operations/connectors/connector%20%2F%201/ingress/ingress%20%2F%201",
      "https://fabric.example.test/api/v1/operations/discrepancies?connector_id=connector+%2F+1&status=open&limit=5",
      "https://fabric.example.test/api/v1/operations/discrepancies/discrepancy%20%2F%201?connector_id=connector+%2F+1",
      "https://fabric.example.test/api/v1/operations/audit?outcome=succeeded&limit=5",
      "https://fabric.example.test/api/v1/operations/cluster",
    ]);
  });

  it("rejects credential-bearing or malformed operational responses", async () => {
    const fetch = vi.fn(async () => response({
      items: [{
        tenant_id: "tenant-1", connector_id: "connector-1", ingress_id: "ingress-1",
        source_system: "feishu", external_event_id: "event-1", event_type: "updated",
        state: "pending", attempt: 0, available_at: "2026-07-16T00:00:00.000Z",
        accepted_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
        completed_at: null, last_error_code: null, last_requeued_at: null,
        access_token: "must-not-cross-sdk",
      }],
      next_cursor: null,
    })) as unknown as typeof globalThis.fetch;
    const operations = client(fetch).operations;
    await expect(operations.listConnectorIngress({ connectorId: "connector-1" }))
      .rejects.toMatchObject({
        name: WorkFabricTransportError.name,
        code: "invalid_response",
      });
  });

  it("submits explicit recovery intent without retrying or adding execution behavior", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const record = {
      tenant_id: "tenant-1", recovery_id: "recovery-1", idempotency_key: "key-1",
      requested_by: "principal-1", requested_at: "2026-07-16T06:00:00.000Z",
      target: { kind: "projection_rebuild", projector_id: "projector-1", partition_id: "partition-1" },
      expected_version: 4, reason: "operator_requested", state: "pending",
      version: 1, attempt: 0, outcome_code: null, completed_at: null,
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input), method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return response(String(input).endsWith("/recoveries")
        ? { kind: "accepted", recovery: record }
        : record);
    }) as unknown as typeof globalThis.fetch;
    const operations = client(fetch).operations;
    await operations.requestRecovery({
      idempotencyKey: "key-1",
      target: { kind: "projection_rebuild", projector_id: "projector-1", partition_id: "partition-1" },
      expectedVersion: 4,
      reason: "operator_requested",
    });
    await operations.getRecovery("recovery-1");
    expect(requests).toEqual([
      {
        url: "https://fabric.example.test/api/v1/operations/recoveries",
        method: "POST",
        body: {
          idempotency_key: "key-1",
          target: { kind: "projection_rebuild", projector_id: "projector-1", partition_id: "partition-1" },
          expected_version: 4,
          reason: "operator_requested",
        },
      },
      {
        url: "https://fabric.example.test/api/v1/operations/recoveries/recovery-1",
        method: "GET",
        body: null,
      },
    ]);
  });
});
