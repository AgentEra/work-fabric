import { invalid } from "./errors.js";

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(?:access[_-]?token|refresh[_-]?token|password|passwd|credential|client[_-]?secret|private[_-]?key|api[_-]?key)/;

export function cloneFrozenJson<T>(value: T, path: string, options: { readonly reject_sensitive_keys?: boolean } = {}): T {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new WeakSet<object>();

  function visit(input: unknown, at: string, depth: number): unknown {
    if (depth > MAX_DEPTH) invalid("invalid_snapshot", at);
    nodes += 1;
    if (nodes > MAX_NODES) invalid("invalid_snapshot", at);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) invalid("invalid_snapshot", at);
      return input;
    }
    if (typeof input === "string") {
      const length = Buffer.byteLength(input, "utf8");
      if (length > MAX_STRING_BYTES || (bytes += length) > MAX_TOTAL_BYTES) invalid("invalid_snapshot", at);
      return input;
    }
    if (typeof input !== "object" || input === null) invalid("invalid_snapshot", at);
    if (ancestors.has(input)) invalid("invalid_snapshot", at);
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const keys = Reflect.ownKeys(input);
        if (keys.length !== input.length + 1) invalid("invalid_snapshot", at);
        const output: unknown[] = [];
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) invalid("invalid_snapshot", at);
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid("invalid_snapshot", `${at}.${key}`);
          output[Number(key)] = visit(descriptor.value, `${at}.${key}`, depth + 1);
        }
        return Object.freeze(output);
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalid("invalid_snapshot", at);
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string") invalid("invalid_snapshot", at);
        if (options.reject_sensitive_keys && SENSITIVE_KEY.test(key)) invalid("invalid_snapshot", `${at}.${key}`);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid("invalid_snapshot", `${at}.${key}`);
        output[key] = visit(descriptor.value, `${at}.${key}`, depth + 1);
      }
      return Object.freeze(output);
    } finally {
      ancestors.delete(input);
    }
  }

  return visit(value, path, 0) as T;
}
