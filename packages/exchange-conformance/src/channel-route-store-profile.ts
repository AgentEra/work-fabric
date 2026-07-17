import assert from "node:assert/strict";

import type { ChannelRoute, ChannelRouteStore } from "@work-fabric/channel-spi";

export type ChannelRouteStoreFactory = () => ChannelRouteStore | Promise<ChannelRouteStore>;

function route(overrides: Partial<ChannelRoute> = {}): ChannelRoute {
  return {
    tenant_id: "tenant_profile", plugin_instance_id: "channel_profile",
    handoff_id: "handoff_01", external_conversation_id: "conversation_01",
    external_message_id: "message_01", version: 1,
    created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  try { await operation; } catch { return; }
  assert.fail(message);
}

export async function verifyChannelRouteStoreProfile(factory: ChannelRouteStoreFactory): Promise<void> {
  const store = await factory();
  const original = route();
  await store.put({ route: original, expected_version: 0 });
  (original as { external_message_id: string }).external_message_id = "mutated";
  assert.equal((await store.get({
    tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", handoff_id: "handoff_01",
  }))?.external_message_id, "message_01");

  await store.put({ route: route(), expected_version: 0 });
  await rejects(store.put({ route: route({ external_conversation_id: "other" }), expected_version: 1 }), "route identity conflict must reject");
  await rejects(store.put({ route: route({ version: 2, external_message_id: "message_02", updated_at: "2026-07-17T00:00:01.000Z" }), expected_version: 0 }), "stale CAS must reject");
  await store.put({ route: route({ version: 2, external_message_id: "message_02", updated_at: "2026-07-17T00:00:01.000Z" }), expected_version: 1 });

  assert.equal(await store.get({ tenant_id: "other", plugin_instance_id: "channel_profile", handoff_id: "handoff_01" }), null);
  await store.put({ route: route({ handoff_id: "handoff_02", version: 1 }), expected_version: 0 });
  const page = await store.list({ tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", limit: 1 });
  assert.deepEqual(page.map((item) => item.handoff_id), ["handoff_01"]);
  const next = await store.list({ tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", after_handoff_id: "handoff_01", limit: 2 });
  assert.deepEqual(next.map((item) => item.handoff_id), ["handoff_02"]);
}
