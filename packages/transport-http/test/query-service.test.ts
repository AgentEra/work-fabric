import { describe, expect, it } from "vitest";

import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type {
  EventRecord,
  HandoffReadModel,
  HandoffReadModelStore,
  RuntimeSubscription,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";

import { StoreBackedExchangeQueryService } from "../src/index.js";

const event: EventRecord = {
  event_id: "event_01",
  event_type: "workfabric.handoff.offered.v1",
  schema_version: "1.0",
  exchange_id: "exchange_01",
  request_message_id: "message_01",
  idempotency_key: "key_01",
  thread_id: "thread_01",
  handoff_id: "handoff_01",
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  visibility: "participants",
  visible_actor_ids: ["actor_01"],
  visible_endpoint_ids: ["endpoint_01"],
  occurred_at: "2026-07-15T00:00:00Z",
  domain_data: { private_score: 0.99 },
  protocol_data: { resource_version: 1, change: { to_state: "offered" } },
  tenant_id: "tenant_01",
  partition_id: "partition_01",
  partition_position: 1,
  stream_id: "handoff_01",
  stream_version: 1,
  commit_id: "commit_01",
  commit_ordinal: 0,
};

const model: HandoffReadModel = {
  tenant_id: "tenant_01",
  partition_id: "partition_01",
  handoff_id: "handoff_01",
  stream_version: 1,
  state: { lifecycle_state: "offered" },
  latest_status: null,
};

const subscription: RuntimeSubscription = {
  subscription_id: "subscription_01",
  tenant_id: "tenant_01",
  owner: { actor_id: "actor_01", actor_type: "agent" },
  endpoint_id: "endpoint_01",
  filter: {
    event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
    handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [],
  },
  destination: { destination_id: "destination_01", binding: "in-process", configuration: {} },
  delivery_mode: "cursor_pull",
  state: "active",
  max_attempts: 3,
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
};

function fixture(overrides: { readonly event?: EventRecord; readonly model?: HandoffReadModel } = {}) {
  const selectedEvent = overrides.event ?? event;
  const selectedModel = overrides.model ?? model;
  const models: HandoffReadModelStore = {
    manifest: { profile: "exchange.projection.v1", adapter: "test", capabilities: {} },
    async getHandoff() { return structuredClone(selectedModel); },
    async listHandoffs() { return [structuredClone(selectedModel), { ...structuredClone(selectedModel), handoff_id: "handoff_02" }]; },
    async putHandoff() {},
    async clearPartition() {},
  };
  const subscriptions: SubscriptionStore = {
    manifest: { profile: "exchange.subscription.v1", adapter: "test", capabilities: {} },
    async getSubscription() { return structuredClone(subscription); },
    async listActiveSubscriptions() { return [structuredClone(subscription)]; },
    async putSubscription() {},
  };
  const persistence = new MemoryExchangePersistence();
  const journal = {
    async readStream() { return [structuredClone(selectedEvent)]; },
    async readPartition() { return [structuredClone(selectedEvent)]; },
  };
  return new StoreBackedExchangeQueryService(
    journal,
    models,
    subscriptions,
    persistence,
    persistence,
  );
}

describe("StoreBackedExchangeQueryService", () => {
  it("returns only same-tenant immutable Handoff views", async () => {
    const service = fixture();
    const loaded = await service.getHandoff("tenant_01", "handoff_01");
    expect(loaded).toEqual(model);
    (loaded?.state as { lifecycle_state: string }).lifecycle_state = "mutated";
    expect(await service.getHandoff("tenant_01", "handoff_01")).toEqual(model);
    await expect(service.getHandoff("tenant_other", "handoff_01")).resolves.toBeNull();
    await expect(service.listPartitionHandoffs("tenant_01", "partition_01", 1)).resolves.toHaveLength(1);
  });

  it("converts EventRecord to safe Protocol Events", async () => {
    const service = fixture();
    const events = await service.readHandoffEvents("tenant_01", "handoff_01", 1, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "event_01", type: event.event_type });
    expect(JSON.stringify(events)).not.toMatch(/private_score|partition_position|commit_id|domain_data/);
    await expect(service.readPartitionEvents("tenant_01", "partition_01", 0, 10)).resolves.toHaveLength(1);
  });

  it("fails closed on cross-tenant Event or Subscription records", async () => {
    const service = fixture({ event: { ...event, tenant_id: "tenant_other" } });
    await expect(service.readHandoffEvents("tenant_01", "handoff_01", 1, 10)).resolves.toEqual([]);
    await expect(service.getSubscription("tenant_other", "subscription_01")).resolves.toBeNull();
    await expect(service.listSubscriptions("tenant_01", 1)).resolves.toEqual([subscription]);
  });
});
