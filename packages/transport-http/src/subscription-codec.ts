import type { JsonObject, RuntimeSubscription } from "@work-fabric/exchange-spi";

export function subscriptionDocument(value: RuntimeSubscription): JsonObject {
  return {
    subscription_id: value.subscription_id,
    owner: value.owner,
    endpoint_id: value.endpoint_id,
    filter: structuredClone(value.filter) as unknown as JsonObject,
    delivery: { mode: value.delivery_mode },
    state: value.state,
    cursor: null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

export function runtimeSubscriptionFromDocument(
  document: Record<string, unknown>,
  tenantId: string,
): RuntimeSubscription {
  const delivery = document.delivery as { readonly mode: RuntimeSubscription["delivery_mode"] };
  return {
    subscription_id: document.subscription_id as string,
    tenant_id: tenantId,
    owner: structuredClone(document.owner) as RuntimeSubscription["owner"],
    endpoint_id: document.endpoint_id as string,
    filter: structuredClone(document.filter) as RuntimeSubscription["filter"],
    destination: {
      destination_id: `http_${document.subscription_id as string}`,
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: delivery.mode,
    state: document.state as RuntimeSubscription["state"],
    max_attempts: 3,
    created_at: document.created_at as string,
    updated_at: document.updated_at as string,
  };
}
