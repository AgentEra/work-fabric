import type {
  JsonObject,
  JsonValue,
  ProtocolEvent,
  SubscriptionFilter,
} from "@work-fabric/exchange-spi";

function includes(values: readonly string[], candidate: unknown): boolean {
  return values.length === 0 ||
    (typeof candidate === "string" && values.includes(candidate));
}

function object(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function routingDetails(event: ProtocolEvent): JsonObject | null {
  const change = object(event.data.change);
  return change === null ? null : object(change.details);
}

function stringArray(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

export function matchesSubscription(
  filter: SubscriptionFilter,
  event: ProtocolEvent,
): boolean {
  if (!includes(filter.event_types, event.type)) return false;
  if (!includes(filter.actor_ids, event.wfactor)) return false;
  if (!includes(filter.endpoint_ids, event.wfendpoint)) return false;
  if (!includes(filter.thread_ids, event.wfthread)) return false;
  if (!includes(filter.handoff_ids, event.wfhandoff)) return false;

  const change = object(event.data.change);
  const details = routingDetails(event);
  const workReference = details?.work_reference_uri;
  if (!includes(filter.work_reference_uris, workReference)) return false;

  if (filter.capability_ids.length > 0) {
    const capabilities = stringArray(details?.capability_ids);
    if (
      capabilities === null ||
      !filter.capability_ids.some((capability) => capabilities.includes(capability))
    ) {
      return false;
    }
  }

  if (!includes(filter.lifecycle_states, change?.to_state)) return false;
  return true;
}
