import { createHash } from "node:crypto";

export type CitizenJsonPrimitive = string | number | boolean | null;
export type CitizenJsonValue =
  | CitizenJsonPrimitive
  | readonly CitizenJsonValue[]
  | CitizenJsonObject;
export interface CitizenJsonObject {
  readonly [key: string]: CitizenJsonValue;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DEPTH = 16;
const MAX_BYTES = 256 * 1024;

function invalid(message: string): never {
  throw new TypeError(message);
}

function copyValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): CitizenJsonValue {
  if (depth > MAX_DEPTH) invalid(`${path} exceeds maximum JSON depth`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") invalid(`${path} is not JSON-safe`);
  if (ancestors.has(value)) invalid(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          invalid(`${path} contains an accessor`);
        }
      }
      return value.map((item, index) =>
        copyValue(item, `${path}[${index}]`, depth + 1, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${path} has a non-plain prototype`);
    }
    const result: Record<string, CitizenJsonValue> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (FORBIDDEN_KEYS.has(key)) invalid(`${path} contains forbidden key ${key}`);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        invalid(`${path} contains an accessor`);
      }
      if (!descriptor.enumerable) continue;
      result[key] = copyValue(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function deepFreezeCitizenJson<T extends CitizenJsonValue>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreezeCitizenJson(child as CitizenJsonValue);
    }
    Object.freeze(value);
  }
  return value;
}

export function cloneCitizenJson(
  value: unknown,
  path = "value",
): CitizenJsonValue {
  const result = copyValue(value, path, 0, new Set());
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) {
    invalid(`${path} exceeds maximum JSON bytes`);
  }
  return deepFreezeCitizenJson(result);
}

function canonical(value: CitizenJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const objectValue = value as CitizenJsonObject;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(objectValue[key]!)}`)
    .join(",")}}`;
}

export function canonicalCitizenDigest(
  value: unknown,
): `sha256:${string}` {
  const safe = cloneCitizenJson(value);
  return `sha256:${createHash("sha256").update(canonical(safe), "utf8").digest("hex")}`;
}
