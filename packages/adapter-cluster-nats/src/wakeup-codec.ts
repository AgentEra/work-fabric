import {
  validatePartitionWakeup,
  type PartitionWakeup,
} from "@work-fabric/cluster-spi";

import { NatsWakeupError } from "./errors.js";

export const NATS_WAKEUP_SCHEMA = "workfabric.partition-wakeup.v1";
export const NATS_WAKEUP_MAX_BYTES = 4_096;

const payloadKeys = [
  "exchange_id",
  "kind",
  "observed_position",
  "occurred_at",
  "partition_id",
  "schema",
  "tenant_id",
  "wakeup_id",
] as const;

function invalid(): never {
  throw new NatsWakeupError("invalid_wakeup_payload");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validated(value: unknown): PartitionWakeup {
  if (!isObject(value)) return invalid();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== payloadKeys.length ||
    keys.some((key, index) => key !== payloadKeys[index]) ||
    value.schema !== NATS_WAKEUP_SCHEMA
  ) return invalid();
  try {
    return validatePartitionWakeup({
      wakeup_id: value.wakeup_id as string,
      exchange_id: value.exchange_id as string,
      tenant_id: value.tenant_id as string,
      partition_id: value.partition_id as string,
      kind: value.kind as PartitionWakeup["kind"],
      observed_position: value.observed_position as number,
      occurred_at: value.occurred_at as string,
    });
  } catch {
    return invalid();
  }
}

export function encodeWakeup(candidate: PartitionWakeup): Uint8Array {
  let wakeup: PartitionWakeup;
  try {
    wakeup = validatePartitionWakeup(candidate);
  } catch {
    return invalid();
  }
  const encoded = new TextEncoder().encode(JSON.stringify({
    schema: NATS_WAKEUP_SCHEMA,
    ...wakeup,
  }));
  if (encoded.byteLength > NATS_WAKEUP_MAX_BYTES) return invalid();
  return encoded;
}

export function decodeWakeup(bytes: Uint8Array): PartitionWakeup {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > NATS_WAKEUP_MAX_BYTES) {
    return invalid();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return structuredClone(validated(JSON.parse(text)));
  } catch (error) {
    if (error instanceof NatsWakeupError) throw error;
    return invalid();
  }
}
