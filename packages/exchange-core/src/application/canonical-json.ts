import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

import type { CommandEnvelope } from "./protocol-types.js";

function invalidJson(path: string): never {
  throw new TypeError(`Value at ${path} is not a valid JSON value`);
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidJson(path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return invalidJson(path);
  if (ancestors.has(value)) {
    throw new TypeError(`Value at ${path} contains a cyclic reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key === "symbol" ||
            (key !== "length" &&
              (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)),
        )
      ) {
        return invalidJson(path);
      }

      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`Value at ${path} contains a sparse array`);
        }
        items.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidJson(path);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return invalidJson(path);

    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (Reflect.ownKeys(value).length !== keys.length) return invalidJson(path);

    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return invalidJson(`${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      )}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$", new WeakSet<object>());
}

export function idempotencyMaterial(envelope: CommandEnvelope): JsonObject {
  return {
    tenant_id: envelope.tenant_id,
    exchange_id: envelope.exchange_id,
    actor_id: envelope.actor_id,
    endpoint_id: envelope.endpoint_id,
    delegation_id: envelope.delegation_id ?? null,
    message_type: envelope.message_type,
    expected_version: envelope.expected_version ?? null,
    payload: envelope.payload,
  };
}

export function idempotencyDigest(envelope: CommandEnvelope): string {
  const material: JsonValue = idempotencyMaterial(envelope);
  const digest = createHash("sha256")
    .update(canonicalJson(material), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
