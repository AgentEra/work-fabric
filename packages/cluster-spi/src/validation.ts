import type {
  ClusterHostLimits,
  PartitionWakeup,
  PartitionWorkItem,
  PartitionWorkKind,
} from "./contracts.js";
import { PARTITION_WORK_KINDS } from "./contracts.js";
import { parseUtcTimestamp } from "@work-fabric/exchange-spi";

export function clusterIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 128 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

export function clusterPositive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

export function clusterTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  parseUtcTimestamp(value, field);
  return value;
}

export function clusterWorkKind(value: unknown, field = "kind"): PartitionWorkKind {
  if (!PARTITION_WORK_KINDS.includes(value as PartitionWorkKind)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as PartitionWorkKind;
}

function bounded(
  value: unknown,
  field: keyof ClusterHostLimits,
  minimum: number,
  maximum: number,
): number {
  const parsed = clusterPositive(value, field);
  if (parsed < minimum || parsed > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function validateClusterLimits(input: ClusterHostLimits): ClusterHostLimits {
  const maxConcurrent = bounded(
    input.max_concurrent_turns,
    "max_concurrent_turns",
    1,
    1_024,
  );
  const maxReady = bounded(input.max_ready_items, "max_ready_items", 1, 100_000);
  if (maxReady < maxConcurrent) {
    throw new RangeError("max_ready_items must be at least max_concurrent_turns");
  }
  return {
    max_concurrent_turns: maxConcurrent,
    max_ready_items: maxReady,
    catalog_page_size: bounded(input.catalog_page_size, "catalog_page_size", 1, 1_000),
    turn_item_limit: bounded(input.turn_item_limit, "turn_item_limit", 1, 10_000),
    lease_seconds: bounded(input.lease_seconds, "lease_seconds", 10, 300),
    drain_timeout_seconds: bounded(
      input.drain_timeout_seconds,
      "drain_timeout_seconds",
      1,
      300,
    ),
    poll_interval_ms: bounded(input.poll_interval_ms, "poll_interval_ms", 100, 60_000),
    max_tenants_per_host: bounded(
      input.max_tenants_per_host,
      "max_tenants_per_host",
      1,
      10_000,
    ),
  };
}

export function validatePartitionWorkItem(item: PartitionWorkItem): PartitionWorkItem {
  return {
    tenant_id: clusterIdentifier(item.tenant_id, "tenant_id"),
    partition_id: clusterIdentifier(item.partition_id, "partition_id"),
    kind: clusterWorkKind(item.kind),
    observed_position: clusterPositive(item.observed_position, "observed_position"),
    available_at: clusterTimestamp(item.available_at, "available_at"),
  };
}

export function validatePartitionWakeup(wakeup: PartitionWakeup): PartitionWakeup {
  return {
    wakeup_id: clusterIdentifier(wakeup.wakeup_id, "wakeup_id"),
    exchange_id: clusterIdentifier(wakeup.exchange_id, "exchange_id"),
    tenant_id: clusterIdentifier(wakeup.tenant_id, "tenant_id"),
    partition_id: clusterIdentifier(wakeup.partition_id, "partition_id"),
    kind: clusterWorkKind(wakeup.kind),
    observed_position: clusterPositive(wakeup.observed_position, "observed_position"),
    occurred_at: clusterTimestamp(wakeup.occurred_at, "occurred_at"),
  };
}
