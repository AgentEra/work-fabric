import { describe, expect, it } from "vitest";
import { LocalAuthorityPolicy, LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { ExchangeQueryService } from "../src/index.js";
import { BearerAuthenticationEvidenceMapper, createHttpService, normalizeHttpServiceConfig } from "../src/index.js";

const principal = { principal_id: "admin", tenant_id: "tenant_01", actor_claims: [{ actor_id: "actor_admin", actor_type: "human" as const, endpoint_ids: ["endpoint_admin"] }], attributes: {} };
const headers = { authorization: "Bearer admin", "x-wf-actor-id": "actor_admin", "x-wf-endpoint-id": "endpoint_admin" };

function fixture(tenantId = "tenant_01") {
  const tenantPrincipal = { ...principal, tenant_id: tenantId };
  const observed: number[] = [];
  const query: ExchangeQueryService = {
    async getHandoff() { return null; }, async readHandoffEvents() { return []; },
    async listPartitionHandoffs(_tenant, _partition, limit) { observed.push(limit); return []; },
    async readPartitionEvents() { return []; }, async getSubscription() { return null; }, async listSubscriptions() { return [{ subscription_id: "subscription_01" } as never]; },
    async listProjectionFailures() { return [{ event_id: "event_failed" } as never]; }, async listDeliveryAttempts() { return [{ event_id: "event_01", attempt: 1 } as never]; }, async getDeliveryPosition() { return 7; },
  };
  const rules = [
    ["workfabric.operations.partition.read.v1", "partition_01"],
    ["workfabric.operations.subscription.list.v1", tenantId],
    ["workfabric.operations.projection-failure.list.v1", "partition_01"],
    ["workfabric.operations.delivery.read.v1", "subscription_01"],
  ] as const;
  const authority = new LocalAuthorityPolicy(rules.map(([action, resource_id]) => ({ tenant_id: tenantId, principal_id: "admin", actor_id: "actor_admin", actor_type: "human" as const, endpoint_id: "endpoint_admin", action, resource_id })));
  return { observed, service: createHttpService({ application: { async handle() { throw new Error("not used"); } }, authenticator: new BearerAuthenticationEvidenceMapper(), query, identity: new LocalIdentityProvider([{ authentication_evidence: { bearer_token: "admin" }, principal: tenantPrincipal }]), authority, subscriptions: new MemorySubscriptionStore() }, normalizeHttpServiceConfig({ default_page_limit: 2, max_page_limit: 5 })) };
}

describe("admin query routes", () => {
  it("uses the configured default limit", async () => {
    const { service, observed } = fixture();
    const response = await service.dispatch({ method: "GET", url: "/v1/partitions/partition_01/handoffs", headers });
    expect(response.status_code).toBe(200);
    expect(observed).toEqual([2]);
    await service.close();
  });

  it("rejects limits above the maximum before querying", async () => {
    const { service, observed } = fixture();
    const response = await service.dispatch({ method: "GET", url: "/v1/partitions/partition_01/handoffs?limit=6", headers });
    expect(response.status_code).toBe(400);
    expect(observed).toEqual([]);
    await service.close();
  });

  it("exposes bounded operational state through protected routes", async () => {
    const { service } = fixture();
    const responses = await Promise.all([
      "/v1/admin/subscriptions",
      "/v1/admin/projection-failures?projector_id=projector_01&partition_id=partition_01",
      "/v1/admin/delivery-attempts?subscription_id=subscription_01&event_id=event_01",
      "/v1/admin/delivery-position?subscription_id=subscription_01&partition_id=partition_01",
    ].map((url) => service.dispatch({ method: "GET", url, headers })));
    expect(responses.map(({ status_code }) => status_code)).toEqual([200, 200, 200, 200]);
    expect(responses[3]?.json()).toEqual({ position: 7 });
    await service.close();
  });

  it("scopes the subscription list action to the authenticated tenant", async () => {
    const { service } = fixture("tenant_02");
    const response = await service.dispatch({ method: "GET", url: "/v1/admin/subscriptions", headers });
    expect(response.status_code).toBe(200);
    await service.close();
  });
});
