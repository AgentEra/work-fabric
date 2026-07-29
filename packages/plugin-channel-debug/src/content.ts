import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

import type { DebugHttpLimits } from "./config.js";

export type DebugContentPart =
  | {
      readonly kind: "text";
      readonly media_type: string;
      readonly text: string;
      readonly language?: string;
      readonly extensions?: JsonObject;
    }
  | {
      readonly kind: "data";
      readonly schema_ref: string;
      readonly data: JsonValue;
      readonly extensions?: JsonObject;
    }
  | {
      readonly kind: "resource";
      readonly resource: {
        readonly uri: string;
        readonly name?: string;
        readonly media_type?: string;
        readonly schema_ref?: string | null;
        readonly version?: string | null;
        readonly digest?: {
          readonly algorithm: string;
          readonly value: string;
        } | null;
        readonly access_hint?: "public" | "delegated" | "exchange_mediated" | "binding_managed";
        readonly extensions: JsonObject;
      };
      readonly extensions?: JsonObject;
    };

export interface DebugMessage {
  readonly idempotency_key: string;
  readonly participant_ref: string;
  readonly content: readonly DebugContentPart[];
}

function strictObject(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  const source = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(source, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${field} has invalid keys`);
  }
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${field}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function bounded(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function absoluteUri(value: unknown, field: string): string {
  const uri = bounded(value, field, 4096);
  try {
    const parsed = new URL(uri);
    if (parsed.protocol.length <= 1) throw new TypeError();
  } catch {
    throw new TypeError(`${field} must be an absolute URI`);
  }
  return uri;
}

function jsonValue(
  value: unknown,
  field: string,
  maximumDepth: number,
  depth = 0,
  ancestors = new Set<object>(),
): JsonValue {
  if (depth > maximumDepth) {
    throw new RangeError(`${field} exceeds max_json_depth`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must be JSON`);
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(`${field} must be JSON`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 10_000) throw new RangeError(`${field} is too large`);
      return value.map((item, index) =>
        jsonValue(item, `${field}[${index}]`, maximumDepth, depth + 1, ancestors));
    }
    const record = strictObject(
      value,
      field,
      [],
      Object.keys(value as Record<string, unknown>),
    );
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${field} must be JSON`);
      }
      output[key] = jsonValue(
        record[key],
        `${field}.${key}`,
        maximumDepth,
        depth + 1,
        ancestors,
      );
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function extensions(
  value: unknown,
  field: string,
  maximumDepth: number,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  const parsed = jsonValue(value, field, maximumDepth);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${field} must be an object`);
  }
  return parsed as JsonObject;
}

function normalizeResource(
  value: unknown,
  field: string,
  maximumDepth: number,
): Extract<DebugContentPart, { readonly kind: "resource" }>["resource"] {
  const resource = strictObject(
    value,
    field,
    ["uri", "extensions"],
    [
      "name",
      "media_type",
      "schema_ref",
      "version",
      "digest",
      "access_hint",
    ],
  );
  const accessHints = [
    "public",
    "delegated",
    "exchange_mediated",
    "binding_managed",
  ] as const;
  if (
    resource.access_hint !== undefined
    && !accessHints.includes(resource.access_hint as typeof accessHints[number])
  ) {
    throw new TypeError(`${field}.access_hint is invalid`);
  }
  if (
    resource.media_type !== undefined
    && (
      typeof resource.media_type !== "string"
      || !/^[^/\s]+\/[^/\s]+$/u.test(resource.media_type)
      || resource.media_type.length > 255
    )
  ) {
    throw new TypeError(`${field}.media_type is invalid`);
  }
  let digest: { readonly algorithm: string; readonly value: string } | null | undefined;
  if (resource.digest === null) digest = null;
  else if (resource.digest !== undefined) {
    const parsed = strictObject(
      resource.digest,
      `${field}.digest`,
      ["algorithm", "value"],
    );
    digest = {
      algorithm: bounded(parsed.algorithm, `${field}.digest.algorithm`, 32),
      value: bounded(parsed.value, `${field}.digest.value`, 512),
    };
  }
  return {
    uri: absoluteUri(resource.uri, `${field}.uri`),
    ...(resource.name === undefined
      ? {}
      : { name: bounded(resource.name, `${field}.name`, 512) }),
    ...(resource.media_type === undefined
      ? {}
      : { media_type: resource.media_type as string }),
    ...(resource.schema_ref === undefined
      ? {}
      : {
          schema_ref: resource.schema_ref === null
            ? null
            : absoluteUri(resource.schema_ref, `${field}.schema_ref`),
        }),
    ...(resource.version === undefined
      ? {}
      : {
          version: resource.version === null
            ? null
            : bounded(resource.version, `${field}.version`, 128),
        }),
    ...(digest === undefined ? {} : { digest }),
    ...(resource.access_hint === undefined
      ? {}
      : {
          access_hint: resource.access_hint as typeof accessHints[number],
        }),
    extensions: extensions(
      resource.extensions,
      `${field}.extensions`,
      maximumDepth,
    )!,
  };
}

export function normalizeDebugMessage(
  value: unknown,
  limits: DebugHttpLimits,
): DebugMessage {
  const message = strictObject(
    value,
    "message",
    ["idempotency_key", "participant_ref", "content"],
  );
  if (
    !Array.isArray(message.content)
    || message.content.length === 0
    || message.content.length > limits.max_content_parts
  ) {
    throw new RangeError("content exceeds max_content_parts");
  }
  let textBytes = 0;
  const content = message.content.map((candidate, index): DebugContentPart => {
    const part = strictObject(
      candidate,
      `content[${index}]`,
      ["kind"],
      [
        "media_type",
        "text",
        "language",
        "schema_ref",
        "data",
        "resource",
        "extensions",
      ],
    );
    if (part.kind === "text") {
      const exact = strictObject(
        candidate,
        `content[${index}]`,
        ["kind", "media_type", "text"],
        ["language", "extensions"],
      );
      if (
        typeof exact.media_type !== "string"
        || !/^text\/[^/\s]+$/u.test(exact.media_type)
        || exact.media_type.length > 255
      ) {
        throw new TypeError(`content[${index}].media_type is invalid`);
      }
      if (typeof exact.text !== "string") {
        throw new TypeError(`content[${index}].text is invalid`);
      }
      textBytes += Buffer.byteLength(exact.text, "utf8");
      const partExtensions = extensions(
        exact.extensions,
        `content[${index}].extensions`,
        limits.max_json_depth,
      );
      return {
        kind: "text",
        media_type: exact.media_type,
        text: exact.text,
        ...(exact.language === undefined
          ? {}
          : { language: bounded(exact.language, `content[${index}].language`, 35) }),
        ...(partExtensions === undefined ? {} : { extensions: partExtensions }),
      };
    }
    if (part.kind === "data") {
      const exact = strictObject(
        candidate,
        `content[${index}]`,
        ["kind", "schema_ref", "data"],
        ["extensions"],
      );
      const partExtensions = extensions(
        exact.extensions,
        `content[${index}].extensions`,
        limits.max_json_depth,
      );
      return {
        kind: "data",
        schema_ref: absoluteUri(
          exact.schema_ref,
          `content[${index}].schema_ref`,
        ),
        data: jsonValue(
          exact.data,
          `content[${index}].data`,
          limits.max_json_depth,
        ),
        ...(partExtensions === undefined ? {} : { extensions: partExtensions }),
      };
    }
    if (part.kind === "resource") {
      const exact = strictObject(
        candidate,
        `content[${index}]`,
        ["kind", "resource"],
        ["extensions"],
      );
      const partExtensions = extensions(
        exact.extensions,
        `content[${index}].extensions`,
        limits.max_json_depth,
      );
      return {
        kind: "resource",
        resource: normalizeResource(
          exact.resource,
          `content[${index}].resource`,
          limits.max_json_depth,
        ),
        ...(partExtensions === undefined ? {} : { extensions: partExtensions }),
      };
    }
    throw new TypeError(`content[${index}].kind is invalid`);
  });
  if (textBytes > limits.max_text_bytes) {
    throw new RangeError("content exceeds max_text_bytes");
  }
  return {
    idempotency_key: bounded(
      message.idempotency_key,
      "idempotency_key",
      256,
    ),
    participant_ref: bounded(
      message.participant_ref,
      "participant_ref",
      128,
    ),
    content,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function debugMessageDigest(message: DebugMessage): string {
  return createHash("sha256")
    .update(canonicalJson(message as unknown as JsonValue), "utf8")
    .digest("hex");
}
