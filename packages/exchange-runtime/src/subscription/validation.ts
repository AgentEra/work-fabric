import { isDeepStrictEqual } from "node:util";

import {
  addUtcTimestampSeconds,
  compareUtcTimestamps,
  parseUtcTimestamp,
  type RuntimeSubscription,
  type SubscriptionFilter,
} from "@work-fabric/exchange-spi";

const FILTER_KEYS = [
  "event_types",
  "actor_ids",
  "endpoint_ids",
  "thread_ids",
  "handoff_ids",
  "work_reference_uris",
  "capability_ids",
  "lifecycle_states",
] as const;

const LIFECYCLE_STATES = new Set([
  "offered",
  "accepted",
  "result_returned",
  "verified",
  "rework_requested",
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
]);
const ACTOR_TYPES = new Set(["human", "agent", "system"]);
const DELIVERY_MODES = new Set(["cursor_pull", "sse", "webhook"]);
const SUBSCRIPTION_STATES = new Set(["active", "suspended", "closed"]);

export function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be an opaque ID of 1 to 128 characters`);
  }
}

export function assertPositiveSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  parseUtcTimestamp(value, label);
}

export function compareTimestamps(
  left: string,
  right: string,
): -1 | 0 | 1 {
  return compareUtcTimestamps(left, right);
}

function assertStringArray(
  value: unknown,
  label: string,
  predicate: (item: string) => boolean,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  for (const item of value) {
    if (!predicate(item)) throw new TypeError(`${label} contains an invalid value`);
  }
}

export function assertSubscriptionFilter(
  value: unknown,
): asserts value is SubscriptionFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("filter must be an object");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== FILTER_KEYS.length ||
    FILTER_KEYS.some((key) => !Object.hasOwn(object, key))
  ) {
    throw new TypeError("filter contains unknown or missing fields");
  }
  const opaque = (item: string): boolean => item.length > 0 && item.length <= 128;
  assertStringArray(
    object.event_types,
    "filter.event_types",
    (item) => /^workfabric\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v1$/.test(item),
  );
  for (const key of [
    "actor_ids",
    "endpoint_ids",
    "thread_ids",
    "handoff_ids",
  ] as const) {
    assertStringArray(object[key], `filter.${key}`, opaque);
  }
  assertStringArray(object.work_reference_uris, "filter.work_reference_uris", (item) => {
    try {
      return new URL(item).protocol.length > 1;
    } catch {
      return false;
    }
  });
  assertStringArray(
    object.capability_ids,
    "filter.capability_ids",
    (item) =>
      item.length <= 128 &&
      /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(item),
  );
  assertStringArray(
    object.lifecycle_states,
    "filter.lifecycle_states",
    (item) => LIFECYCLE_STATES.has(item),
  );
}

export function assertRuntimeSubscription(
  value: RuntimeSubscription,
): void {
  const candidate = value as unknown as Record<string, unknown>;
  const requiredKeys = [
    "subscription_id",
    "tenant_id",
    "owner",
    "endpoint_id",
    "filter",
    "destination",
    "delivery_mode",
    "state",
    "max_attempts",
    "created_at",
    "updated_at",
  ];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Object.keys(candidate).length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.hasOwn(candidate, key))
  ) {
    throw new TypeError("Subscription contains unknown or missing fields");
  }
  assertOpaqueId(value.subscription_id, "subscription_id");
  assertOpaqueId(value.tenant_id, "tenant_id");
  assertOpaqueId(value.endpoint_id, "endpoint_id");
  if (
    typeof value.owner !== "object" ||
    value.owner === null ||
    Object.keys(value.owner).length !== 2
  ) {
    throw new TypeError("owner must contain only actor_id and actor_type");
  }
  assertOpaqueId(value.owner.actor_id, "owner.actor_id");
  if (!ACTOR_TYPES.has(value.owner.actor_type)) {
    throw new TypeError("owner.actor_type is invalid");
  }
  assertSubscriptionFilter(value.filter);
  if (
    typeof value.destination !== "object" ||
    value.destination === null ||
    Object.keys(value.destination).some(
      (key) => !["destination_id", "binding", "configuration"].includes(key),
    )
  ) {
    throw new TypeError("destination is invalid");
  }
  assertOpaqueId(value.destination.destination_id, "destination.destination_id");
  if (
    typeof value.destination.binding !== "string" ||
    value.destination.binding.length === 0 ||
    value.destination.binding.length > 128
  ) {
    throw new TypeError("destination.binding is invalid");
  }
  if (
    typeof value.destination.configuration !== "object" ||
    value.destination.configuration === null ||
    Array.isArray(value.destination.configuration)
  ) {
    throw new TypeError("destination.configuration must be an object");
  }
  if (!DELIVERY_MODES.has(value.delivery_mode)) {
    throw new TypeError("delivery_mode is invalid");
  }
  if (!SUBSCRIPTION_STATES.has(value.state)) {
    throw new TypeError("Subscription state is invalid");
  }
  assertPositiveSafeInteger(value.max_attempts, "max_attempts");
  assertTimestamp(value.created_at, "created_at");
  assertTimestamp(value.updated_at, "updated_at");
  if (compareTimestamps(value.updated_at, value.created_at) < 0) {
    throw new TypeError("updated_at must not precede created_at");
  }
}

export function addSeconds(timestamp: string, seconds: number): string {
  return addUtcTimestampSeconds(timestamp, seconds);
}

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameStructuredValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
