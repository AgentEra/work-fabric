import { describe, expect, it } from "vitest";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { ConnectorAcceptedReceipt } from "@work-fabric/connector-spi";
import type { RuntimeSubscription, SubscriptionStore } from "@work-fabric/exchange-spi";
import { FeishuIntakeReceiptHandler } from "../src/index.js";

function receipt(): ConnectorAcceptedReceipt {
  return {
    tenant_id: "tenant-1", connector_id: "feishu-primary", ingress_id: "ingress-1",
    claim: {
      ingress_id: "ingress-1",
      envelope: { tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1", external_event_id: "event-1", dedupe_key: "message:om-1", event_type: "im.message.receive_v1", occurred_at: "2026-07-17T00:00:00.000Z", received_at: "2026-07-17T00:00:01.000Z", payload: { chat_id: "oc-1", message_id: "om-1" } },
      state: "processing", attempt: 1, available_at: "2026-07-17T00:00:01.000Z", accepted_at: "2026-07-17T00:00:01.000Z", updated_at: "2026-07-17T00:00:02.000Z", claim_owner: "worker", claim_token: "claim", fencing_token: 1, lease_expires_at: "2026-07-17T00:01:02.000Z",
    },
    command: { operation: "handoff.offer", idempotency_key: "key", identity: { actor_id: "actor-human", endpoint_id: "endpoint-human" }, input: {} },
    accepted: { kind: "accepted", receipt_id: "receipt-1", event_ids: [], resource: { resource_type: "handoff", resource_id: "handoff-1", resource_version: 1 } },
  };
}

describe("FeishuIntakeReceiptHandler", () => {
  it("writes the route before activating one participant-owned Subscription", async () => {
    const routes = new MemoryChannelRouteStore();
    const subscriptions = new MemorySubscriptionStore();
    const ready: string[] = [];
    const handler = new FeishuIntakeReceiptHandler({
      plugin_instance_id: "feishu-primary", routes, subscriptions,
      actor_type_for: () => "human", max_delivery_attempts: 8,
      on_handoff_ready: (handoffId) => { ready.push(handoffId); },
    });
    await expect(handler.record(receipt())).resolves.toMatchObject({ kind: "accepted" });
    await expect(routes.get({ tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1" })).resolves.toMatchObject({ external_conversation_id: "oc-1" });
    const active = await subscriptions.listActiveSubscriptions("tenant-1");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      owner: { actor_id: "actor-human", actor_type: "human" }, endpoint_id: "endpoint-human",
      filter: { handoff_ids: ["handoff-1"] },
      destination: { binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "handoff" } },
    });
    expect(ready).toEqual(["handoff-1"]);
    await expect(handler.record(receipt())).resolves.toMatchObject({ kind: "accepted" });
    expect(await subscriptions.listActiveSubscriptions("tenant-1")).toHaveLength(1);
  });

  it("rejects accepted results without a Handoff resource", async () => {
    const value = receipt();
    const handler = new FeishuIntakeReceiptHandler({ plugin_instance_id: "feishu-primary", routes: new MemoryChannelRouteStore(), subscriptions: new MemorySubscriptionStore(), actor_type_for: () => "human", max_delivery_attempts: 8 });
    await expect(handler.record({ ...value, accepted: { kind: "accepted", receipt_id: "r", event_ids: [] } })).resolves.toMatchObject({ kind: "permanent_failure", error_code: "handoff_resource_missing" });
  });

  it("replays safely when a crash is observed after the Subscription write", async () => {
    const routes = new MemoryChannelRouteStore();
    const delegate = new MemorySubscriptionStore();
    let failAfterWrite = true;
    const subscriptions: SubscriptionStore = {
      manifest: delegate.manifest,
      getSubscription: (id) => delegate.getSubscription(id),
      listActiveSubscriptions: (tenantId) => delegate.listActiveSubscriptions(tenantId),
      async putSubscription(value: RuntimeSubscription) {
        await delegate.putSubscription(value);
        if (failAfterWrite) { failAfterWrite = false; throw new Error("simulated crash after commit"); }
      },
    };
    const handler = new FeishuIntakeReceiptHandler({ plugin_instance_id: "feishu-primary", routes, subscriptions, actor_type_for: () => "human", max_delivery_attempts: 8 });
    await expect(handler.record(receipt())).resolves.toMatchObject({ kind: "retryable_failure" });
    await expect(handler.record(receipt())).resolves.toMatchObject({ kind: "accepted" });
    expect(await delegate.listActiveSubscriptions("tenant-1")).toHaveLength(1);
    await expect(routes.get({ tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1" })).resolves.toMatchObject({ version: 1 });
  });
});
