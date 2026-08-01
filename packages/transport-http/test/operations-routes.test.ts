import { describe, expect, it } from "vitest";

import { LocalAuthorityPolicy, LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import type { OperationsQueryService } from "@work-fabric/operations-runtime";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal-1", tenant_id: "tenant-1",
  actor_claims: [{ actor_id: "actor-1", actor_type: "agent" as const, endpoint_ids: ["endpoint-1"] }],
  attributes: {},
};
const headers = {
  authorization: "Bearer known",
  "x-wf-actor-id": "actor-1",
  "x-wf-endpoint-id": "endpoint-1",
};

function fixture() {
  const calls: Array<{ method: string; tenant: string; input: unknown }> = [];
  const page = { items: [], next_cursor: null };
  const operations: OperationsQueryService = {
    async getClusterSnapshot() {
      calls.push({ method: "cluster", tenant: "tenant-1", input: null });
      return {
        state: "running", ready_items: 3, in_flight_turns: 2,
        completed_turns: 9, lease_losses: 1, dropped_wakeups: 4,
        observed_at: "2026-07-16T08:00:00.000Z",
      };
    },
    async getProjectionStatus(tenant, projectorId, partitionId) {
      calls.push({ method: "projection", tenant, input: { projectorId, partitionId } });
      return { tenant_id: tenant, projector_id: projectorId, partition_id: partitionId, checkpoint_position: 4, journal_position: 5, lag: 1, state: "lagging" };
    },
    async listProjectionFailures(tenant, input) { calls.push({ method: "failures", tenant, input }); return page; },
    async getDeliveryState(tenant, subscriptionId, partitionId) { calls.push({ method: "delivery", tenant, input: { subscriptionId, partitionId } }); return null; },
    async listDeliveryAttempts(tenant, input) { calls.push({ method: "attempts", tenant, input }); return page; },
    async listDeadLetters(tenant, input) { calls.push({ method: "dead-letters", tenant, input }); return page; },
    async getConnectorIngress(tenant, connectorId, ingressId) { calls.push({ method: "ingress", tenant, input: { connectorId, ingressId } }); return null; },
    async listConnectorIngress(tenant, input) { calls.push({ method: "ingresses", tenant, input }); return page; },
    async getDiscrepancy(tenant, discrepancyId) { calls.push({ method: "discrepancy", tenant, input: { discrepancyId } }); return null; },
    async listDiscrepancies(tenant, input) { calls.push({ method: "discrepancies", tenant, input }); return page; },
    async listAudit(tenant, input) { calls.push({ method: "audit", tenant, input }); return page; },
  };
  const grants = [
    ["workfabric.operations.projection.read.v1", "partition-1"],
    ["workfabric.operations.projection-failure.list.v1", "partition-1"],
    ["workfabric.operations.delivery.read.v1", "subscription-1"],
    ["workfabric.operations.connector-ingress.read.v1", "connector-1"],
    ["workfabric.operations.discrepancy.read.v1", "connector-1"],
    ["workfabric.operations.audit.read.v1", "tenant-1"],
    ["workfabric.operations.cluster.read.v1", "tenant-1"],
    ["workfabric.operations.discovery.read.v1", "tenant-1"],
  ] as const;
  const authority = new LocalAuthorityPolicy(grants.map(([action, resource_id]) => ({
    tenant_id: "tenant-1", principal_id: "principal-1", actor_id: "actor-1",
    actor_type: "agent" as const, endpoint_id: "endpoint-1", action, resource_id,
  })));
  const service = createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity: new LocalIdentityProvider([{ authentication_evidence: { bearer_token: "known" }, principal }]),
    authority,
    operations,
    discovery_operations: {
      tenant_view_id: "view-1",
      service: {
        async snapshot(scope: unknown) {
          calls.push({ method: "discovery", tenant: "tenant-1", input: scope });
          return {
            observed_at: "2026-08-01T00:00:00.000Z", health: "healthy", dependency_failures: 0,
            records: { fresh: 1, expired: 0, withdrawn: 0, conflicts: 0, capacity: 10, utilization: 0.1 },
            peers: { total: 0, active: 0, disabled: 0, samples: [], samples_truncated: false },
            counters: { coalesced_updates: 0, prevented_forwards: 0, sync_failures: 0, query_rejections: 0 },
          };
        },
      } as never,
    },
  }, normalizeHttpServiceConfig({ default_page_limit: 2, max_page_limit: 10 }));
  return { service, calls };
}

describe("operational visibility routes", () => {
  it("uses the authenticated tenant and authorized resource for operational queries", async () => {
    const { service, calls } = fixture();
    const responses = await Promise.all([
      service.dispatch({ method: "GET", url: "/v1/operations/projections/projector-1/partitions/partition-1", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/projection-failures?projector_id=projector-1&partition_id=partition-1&limit=3", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/deliveries/subscription-1/partitions/partition-1", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/connectors/connector-1/ingress?state=retry_wait", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/discrepancies?connector_id=connector-1&status=open", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/audit?outcome=failed&limit=3", headers }),
      service.dispatch({ method: "GET", url: "/v1/operations/cluster", headers }),
    ]);
    expect(responses.map((response) => response.status_code)).toEqual([200, 200, 404, 200, 200, 200, 200]);
    expect(calls).toEqual(expect.arrayContaining([
      { method: "projection", tenant: "tenant-1", input: { projectorId: "projector-1", partitionId: "partition-1" } },
      { method: "failures", tenant: "tenant-1", input: { projector_id: "projector-1", partition_id: "partition-1", limit: 3 } },
      { method: "ingresses", tenant: "tenant-1", input: { connector_id: "connector-1", states: ["retry_wait"], limit: 2 } },
      { method: "discrepancies", tenant: "tenant-1", input: { connector_id: "connector-1", statuses: ["open"], limit: 2 } },
      { method: "audit", tenant: "tenant-1", input: { outcome: "failed", limit: 3 } },
      { method: "cluster", tenant: "tenant-1", input: null },
    ]));
    await service.close();
  });

  it("rejects malformed filters and denies resources before querying stores", async () => {
    const { service, calls } = fixture();
    const malformed = await service.dispatch({
      method: "GET", url: "/v1/operations/connectors/connector-1/ingress?state=made_up", headers,
    });
    const denied = await service.dispatch({
      method: "GET", url: "/v1/operations/projections/projector-1/partitions/partition-2", headers,
    });
    expect([malformed.status_code, denied.status_code]).toEqual([400, 403]);
    expect(calls).toHaveLength(0);
    await service.close();
  });

  it("keeps admin read aliases on the same operational query service", async () => {
    const { service, calls } = fixture();
    const failures = await service.dispatch({
      method: "GET",
      url: "/v1/admin/projection-failures?projector_id=projector-1&partition_id=partition-1&limit=4",
      headers,
    });
    expect(failures.status_code).toBe(200);
    expect(failures.json()).toEqual({ failures: [], next_cursor: null });
    expect(calls).toEqual([{
      method: "failures", tenant: "tenant-1",
      input: { projector_id: "projector-1", partition_id: "partition-1", limit: 4 },
    }]);
    await service.close();
  });

  it("exposes the bounded discovery aggregate under operations authority", async () => {
    const { service, calls } = fixture();
    const response = await service.dispatch({ method: "GET", url: "/v1/operations/discovery", headers });
    expect(response.status_code).toBe(200);
    expect(response.json()).toMatchObject({
      health: "healthy", records: { fresh: 1 }, peers: { samples: [] },
    });
    expect(calls).toEqual([{
      method: "discovery", tenant: "tenant-1",
      input: { tenant_id: "tenant-1", tenant_view_id: "view-1" },
    }]);
    await service.close();
  });
});
