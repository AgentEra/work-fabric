import assert from "node:assert/strict";

import {
  ENDPOINT_INBOX_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type EndpointInboxRoutingFact,
  type EndpointInboxStore,
} from "@work-fabric/exchange-spi";

export type EndpointInboxStoreFactory = () => EndpointInboxStore;

function fact(overrides: Partial<EndpointInboxRoutingFact> = {}): EndpointInboxRoutingFact {
  return {
    tenant_id: "tenant_profile_01",
    partition_id: "handoff:h_profile_01",
    handoff_id: "h_profile_01",
    resource_version: 1,
    lifecycle_state: "offered",
    last_event_id: "event_profile_01",
    observed_position: 1,
    visible_actor_ids: ["actor_profile_01"],
    visible_endpoint_ids: ["endpoint_profile_01"],
    active: true,
    ...overrides,
  };
}

async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(message);
}

export async function verifyEndpointInboxProfile(
  factory: EndpointInboxStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "exchange.endpoint-inbox.v1");
  assertCapabilities(store.manifest, ENDPOINT_INBOX_REQUIRED_CAPABILITIES);
  const original = fact();
  await store.upsertRoutingFact(original);
  await store.upsertRoutingFact(structuredClone(original));
  (original.visible_actor_ids as string[])[0] = "mutated";

  const query = {
    tenant_id: "tenant_profile_01",
    actor_id: "actor_profile_01",
    endpoint_id: "endpoint_profile_01",
    limit: 10,
  };
  assert.deepEqual(await store.listPartitions(query), {
    items: [{ partition_id: "handoff:h_profile_01", latest_position: 1, active_handoff_count: 1 }],
  });
  assert.deepEqual(await store.listPartitions({ ...query, tenant_id: "tenant_other" }), { items: [] });

  await store.upsertRoutingFact(fact({
    handoff_id: "h_profile_02",
    partition_id: "handoff:h_profile_02",
    last_event_id: "event_profile_02",
    observed_position: 2,
  }));
  const firstPage = await store.listPartitions({ ...query, limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.next_cursor !== undefined);
  const secondPage = await store.listPartitions({
    ...query,
    cursor: firstPage.next_cursor,
    limit: 1,
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(
    firstPage.items[0]?.partition_id,
    secondPage.items[0]?.partition_id,
  );

  await store.upsertRoutingFact(fact({
    handoff_id: "h_profile_02",
    partition_id: "handoff:h_profile_02",
    resource_version: 2,
    lifecycle_state: "completed",
    last_event_id: "event_profile_03",
    observed_position: 3,
    active: false,
  }));

  await rejects(
    store.upsertRoutingFact(fact({ resource_version: 0, observed_position: 0 })),
    "projection regression must reject",
  );

  await store.upsertRoutingFact(fact({ resource_version: 2, lifecycle_state: "completed", last_event_id: "event_profile_04", observed_position: 4, active: false }));
  assert.deepEqual(await store.listPartitions(query), { items: [] });

  await store.upsertRoutingFact(fact({ tenant_id: "tenant_other", handoff_id: "h_other", partition_id: "handoff:h_other" }));
  await store.upsertRoutingFact(fact({ handoff_id: "h_partition", partition_id: "handoff:partition", last_event_id: "event_partition" }));
  await store.clearPartitionProjection("tenant_profile_01", "handoff:partition");
  assert.equal((await store.listPartitions(query)).items.some((item) => item.partition_id === "handoff:partition"), false);
  await store.clearTenantProjection("tenant_profile_01");
  assert.deepEqual(await store.listPartitions(query), { items: [] });
  assert.equal((await store.listPartitions({ ...query, tenant_id: "tenant_other" })).items.length, 1);
}
