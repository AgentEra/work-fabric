import type {
  CapabilityManifest,
  EventRecord,
  RuntimeSubscription,
  SubscriptionDeliveryDecision,
  SubscriptionDeliveryPolicy,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.subscription_delivery.v1",
  adapter: "default",
  capabilities: {
    tenant_isolation: true,
    audience_enforcement: true,
    default_deny: true,
  },
};

export class DefaultSubscriptionDeliveryPolicy
  implements SubscriptionDeliveryPolicy
{
  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async authorizeDelivery(
    subscription: RuntimeSubscription,
    event: EventRecord,
  ): Promise<SubscriptionDeliveryDecision> {
    if (subscription.tenant_id !== event.tenant_id) {
      return { kind: "deny", reason: "tenant_mismatch" };
    }
    if (event.visibility === "public" || event.visibility === "tenant") {
      return { kind: "allow" };
    }
    if (
      event.visibility === "participants" ||
      event.visibility === "restricted"
    ) {
      if (
        event.visible_actor_ids.includes(subscription.owner.actor_id) ||
        event.visible_endpoint_ids.includes(subscription.endpoint_id)
      ) {
        return { kind: "allow" };
      }
      return { kind: "deny", reason: "not_in_audience" };
    }
    return { kind: "deny", reason: "unsupported_visibility" };
  }
}
