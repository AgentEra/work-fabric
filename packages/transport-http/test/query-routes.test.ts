import { beforeAll, describe, expect, it } from "vitest";
import { LocalAuthorityPolicy, LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import { loadWfppSchemaValidator, type WfppSchemaValidator } from "@work-fabric/protocol-runtime";
import type { ExchangeQueryService } from "../src/index.js";
import { BearerAuthenticationEvidenceMapper, createHttpService, normalizeHttpServiceConfig } from "../src/index.js";

const principal = {
  principal_id: "principal_01", tenant_id: "tenant_01",
  actor_claims: [{ actor_id: "actor_01", actor_type: "agent" as const, endpoint_ids: ["endpoint_01"] }], attributes: {},
};
const model = {
  tenant_id: "tenant_01", partition_id: "partition_01", handoff_id: "handoff_01",
  stream_version: 2, state: { lifecycle_state: "offered", target_binding: { target: { actor_id: "actor_01" } } }, latest_status: null,
};
const runtimeSubscription = {
  subscription_id: "subscription_01", tenant_id: "tenant_01",
  owner: { actor_id: "actor_01", actor_type: "agent" as const }, endpoint_id: "endpoint_01",
  filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
  destination: { destination_id: "destination_01", binding: "in-process", configuration: {} },
  delivery_mode: "cursor_pull" as const, state: "active" as const, max_attempts: 3,
  created_at: "2026-07-15T00:00:00Z", updated_at: "2026-07-15T00:00:00Z",
};
const subscription = {
  subscription_id: "subscription_01",
  owner: { actor_id: "actor_01", actor_type: "agent" as const },
  endpoint_id: "endpoint_01",
  filter: runtimeSubscription.filter,
  delivery: { mode: "cursor_pull" as const },
  state: "active" as const,
  cursor: null,
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
};
let schemas: WfppSchemaValidator;
beforeAll(async () => { schemas = await loadWfppSchemaValidator("protocol/schemas/v1"); });

function fixture() {
  const query: ExchangeQueryService = {
    async getHandoff() { return structuredClone(model); },
    async readHandoffEvents() { return [{ specversion: "1.0", id: "event_01", source: "urn:test", type: "workfabric.handoff.target_resolved.v1", subject: "handoff_01", time: "2026-07-15T00:00:00Z", datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant_01", wfexchange: "exchange_01", wfthread: "thread_01", wfhandoff: "handoff_01", wfactor: "actor_01", wfendpoint: "endpoint_01", wfsequence: 2, wfvisibility: "participants", data: { resource_version: 2 } }]; },
    async listPartitionHandoffs() { return [model]; }, async readPartitionEvents() { return []; },
    async getSubscription() { return structuredClone(runtimeSubscription); }, async listSubscriptions() { return []; },
    async listProjectionFailures() { return []; }, async listDeliveryAttempts() { return []; }, async getDeliveryPosition() { return 0; },
  };
  const actions = ["workfabric.query.handoff.read.v1", "workfabric.subscription.read.v1", "workfabric.subscription.manage.v1"];
  const authority = new LocalAuthorityPolicy(actions.map((action) => ({
    tenant_id: "tenant_01", principal_id: "principal_01", actor_id: "actor_01", actor_type: "agent" as const,
    endpoint_id: "endpoint_01", action, resource_id: action.includes("handoff") ? "handoff_01" : "subscription_01",
  })));
  const subscriptions = new MemorySubscriptionStore();
  const service = createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(), query,
    identity: new LocalIdentityProvider([{ authentication_evidence: { bearer_token: "known" }, principal }]),
    authority, subscriptions, schemas,
  }, normalizeHttpServiceConfig({ max_page_limit: 10, default_page_limit: 2 }));
  return { service, subscriptions };
}

const headers = { authorization: "Bearer known", "x-wf-actor-id": "actor_01", "x-wf-endpoint-id": "endpoint_01" };

describe("participant query routes", () => {
  it("returns an authorized Handoff and safe Events", async () => {
    const { service } = fixture();
    const handoff = await service.dispatch({ method: "GET", url: "/v1/handoffs/handoff_01", headers });
    const events = await service.dispatch({ method: "GET", url: "/v1/handoffs/handoff_01/events?from_version=1&limit=2", headers });
    expect(handoff.status_code).toBe(200);
    expect(handoff.json()).toEqual(model);
    expect(events.status_code).toBe(200);
    expect(JSON.stringify(events.json())).not.toMatch(/domain_data|commit_id|partition_position/);
    await service.close();
  });

  it("requires authentication and representation headers", async () => {
    const { service } = fixture();
    const response = await service.dispatch({ method: "GET", url: "/v1/handoffs/handoff_01", headers: { authorization: "Bearer known" } });
    expect(response.status_code).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    await service.close();
  });

  it("gets and stores an authorized canonical Subscription", async () => {
    const { service, subscriptions } = fixture();
    const get = await service.dispatch({ method: "GET", url: "/v1/subscriptions/subscription_01", headers });
    const put = await service.dispatch({ method: "PUT", url: "/v1/subscriptions/subscription_01", headers: { ...headers, "content-type": "application/json" }, payload: subscription });
    expect(get.status_code).toBe(200);
    expect(get.json()).toEqual(subscription);
    expect(put.status_code).toBe(200);
    await expect(subscriptions.getSubscription("subscription_01")).resolves.toMatchObject({
      ...runtimeSubscription,
      destination: { binding: "in-process" },
    });
    await service.close();
  });
});
