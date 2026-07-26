import {
  handoffStateFromJson,
  type HandoffState,
} from "@work-fabric/exchange-core";
import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

const MAXIMUM_ID_LENGTH = 255;
const MODEL_FIELDS = new Set([
  "tenant_id",
  "partition_id",
  "handoff_id",
  "stream_version",
  "state",
  "latest_status",
]);

export interface ValidatedRuntimeHandoff {
  readonly state: HandoffState;
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): object | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAXIMUM_ID_LENGTH && value.trim() === value;
}

function jsonValue(value: unknown, ancestors: WeakSet<object> = new WeakSet()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    let keys: readonly PropertyKey[];
    try { keys = Reflect.ownKeys(value); } catch { ancestors.delete(value); return false; }
    const expected = new Set<string>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
      ancestors.delete(value);
      return false;
    }
    const valid = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor !== undefined && "value" in descriptor && jsonValue(descriptor.value, ancestors);
    }).every(Boolean);
    ancestors.delete(value);
    return valid;
  }
  const candidate = object(value);
  if (candidate === null || ancestors.has(candidate)) return false;
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(candidate) as object | null; } catch { return false; }
  if (prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(candidate);
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(candidate); } catch { ancestors.delete(candidate); return false; }
  const valid = keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor !== undefined && "value" in descriptor && jsonValue(descriptor.value, ancestors);
  });
  ancestors.delete(candidate);
  return valid;
}

function exactModel(value: unknown): object | null {
  const model = object(value);
  if (model === null) return null;
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(model) as object | null; } catch { return null; }
  if (prototype !== Object.prototype && prototype !== null) return null;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(model); } catch { return null; }
  if (keys.length !== MODEL_FIELDS.size || keys.some((key) => typeof key !== "string" || !MODEL_FIELDS.has(key))) return null;
  return model;
}

export function validateRuntimeHandoffReadModel(
  value: unknown,
  tenantId: string,
  handoffId: string,
): ValidatedRuntimeHandoff | null {
  try {
    const model = exactModel(value);
    if (model === null
      || ownData(model, "tenant_id") !== tenantId
      || ownData(model, "handoff_id") !== handoffId
      || !identifier(ownData(model, "partition_id"))
      || !Number.isSafeInteger(ownData(model, "stream_version"))
      || (ownData(model, "stream_version") as number) <= 0) return null;
    const state = ownData(model, "state");
    const latestStatus = ownData(model, "latest_status");
    if (object(state) === null || !jsonValue(state)
      || (latestStatus !== null && (object(latestStatus) === null || !jsonValue(latestStatus)))) return null;
    const normalized = handoffStateFromJson(state as JsonObject);
    if (normalized.handoff_id !== handoffId || normalized.resource_version !== ownData(model, "stream_version")) return null;
    return Object.freeze({ state: normalized });
  } catch {
    return null;
  }
}
