import type {
  CapabilityManifest,
  RuntimeSubscription,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";

import {
  assertOpaqueId,
  assertRuntimeSubscription,
  compareTimestamps,
  compareCodePoints,
  sameStructuredValue,
} from "./validation.js";

const manifest: CapabilityManifest = {
  profile: "exchange.subscription.v1",
  adapter: "memory",
  capabilities: {
    tenant_isolation: true,
    state_filtering: true,
    immutable_reads: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameIdentity(
  left: RuntimeSubscription,
  right: RuntimeSubscription,
): boolean {
  return (
    left.subscription_id === right.subscription_id &&
    left.tenant_id === right.tenant_id &&
    left.owner.actor_id === right.owner.actor_id &&
    left.owner.actor_type === right.owner.actor_type &&
    left.endpoint_id === right.endpoint_id &&
    compareTimestamps(left.created_at, right.created_at) === 0
  );
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly subscriptions = new Map<string, RuntimeSubscription>();

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async getSubscription(
    subscriptionId: string,
  ): Promise<RuntimeSubscription | null> {
    assertOpaqueId(subscriptionId, "subscription_id");
    const subscription = this.subscriptions.get(subscriptionId);
    return subscription === undefined ? null : clone(subscription);
  }

  async listActiveSubscriptions(
    tenantId: string,
  ): Promise<readonly RuntimeSubscription[]> {
    assertOpaqueId(tenantId, "tenant_id");
    return clone(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.tenant_id === tenantId &&
            subscription.state === "active",
        )
        .sort((left, right) =>
          compareCodePoints(left.subscription_id, right.subscription_id),
        ),
    );
  }

  async putSubscription(subscription: RuntimeSubscription): Promise<void> {
    const candidate = clone(subscription);
    assertRuntimeSubscription(candidate);
    const existing = this.subscriptions.get(candidate.subscription_id);
    if (existing === undefined) {
      this.subscriptions.set(candidate.subscription_id, candidate);
      return;
    }
    if (!sameIdentity(existing, candidate)) {
      throw new Error("Subscription identity is immutable");
    }
    if (sameStructuredValue(existing, candidate)) return;
    if (existing.state === "closed") {
      throw new Error("closed Subscription is terminal");
    }
    if (
      compareTimestamps(candidate.updated_at, existing.updated_at) <= 0
    ) {
      throw new Error("Subscription updated_at must increase");
    }
    this.subscriptions.set(candidate.subscription_id, candidate);
  }
}
