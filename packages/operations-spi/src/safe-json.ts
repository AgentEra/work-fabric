import type { JsonValue } from "@work-fabric/exchange-spi";

export interface SafeOperationsJsonLimits {
  readonly max_bytes: number;
  readonly max_depth: number;
}

export const DEFAULT_SAFE_OPERATIONS_JSON_LIMITS: SafeOperationsJsonLimits = {
  max_bytes: 16 * 1024,
  max_depth: 12,
};

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function credentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-.]/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.includes("credential") ||
    normalized.includes("client_secret")
  );
}

export function assertSafeOperationsJson(
  input: JsonValue,
  label: string,
  limits: SafeOperationsJsonLimits = DEFAULT_SAFE_OPERATIONS_JSON_LIMITS,
): void {
  positive(limits.max_bytes, "max_bytes");
  positive(limits.max_depth, "max_depth");
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new TypeError(`${label} is not serializable JSON`);
  }
  if (new TextEncoder().encode(serialized).byteLength > limits.max_bytes) {
    throw new TypeError(`${label} exceeds byte limit`);
  }

  const visit = (value: JsonValue, depth: number): void => {
    if (depth > limits.max_depth) throw new TypeError(`${label} exceeds depth limit`);
    if (value === null || typeof value !== "object") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`${label} contains a non-finite number`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (credentialKey(key)) {
        throw new TypeError(`${label} contains an unsafe credential field`);
      }
      visit(item, depth + 1);
    }
  };
  visit(input, 0);
}
