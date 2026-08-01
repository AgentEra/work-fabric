import { createHash } from "node:crypto";

import type { JsonValue } from "@work-fabric/exchange-spi";

import { DiscoveryError } from "./errors.js";

const sensitiveKey = /(?:access[_-]?token|refresh[_-]?token|password|passwd|credential|client[_-]?secret|private[_-]?key|api[_-]?key)/i;

function invalid(): never {
  throw new DiscoveryError("discovery_record_invalid");
}

function wellFormed(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return invalid();
    }
  }
  return value;
}

function canonical(value: JsonValue, depth: number, budget: { value: number }): string {
  budget.value -= 1;
  if (budget.value < 0 || depth > 32) return invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? wellFormed(value) : value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1, budget)).join(",")}]`;
  }
  if (typeof value !== "object") return invalid();
  const source = value as Record<string, JsonValue | undefined>;
  const keys = Object.keys(source).sort();
  return `{${keys.map((key) => {
    wellFormed(key);
    if (sensitiveKey.test(key)) return invalid();
    const item = source[key];
    if (item === undefined) return invalid();
    return `${JSON.stringify(key)}:${canonical(item, depth + 1, budget)}`;
  }).join(",")}}`;
}

export function discoveryCanonicalJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonical(value, 0, { value: 10_000 }));
}

export function discoveryCanonicalSha256(value: JsonValue): string {
  return createHash("sha256").update(discoveryCanonicalJsonBytes(value)).digest("hex");
}
