import type { JsonValue, ProtocolEvent } from "@work-fabric/exchange-spi";

import type {
  DebugCapture,
  DebugSubmission,
  ListDebugCaptures,
  PruneExpiredDebugRecords,
} from "./contracts.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${field} contains unknown or missing fields`);
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
}

function timestamp(value: unknown, field: string): asserts value is string {
  boundedString(value, field, 64);
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertJsonValue(
  value: unknown,
  field: string,
  seen = new Set<object>(),
  depth = 0,
): asserts value is JsonValue {
  if (depth > 64) throw new TypeError(`${field} must be bounded JSON`);
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must be JSON`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${field} must be JSON`);
  if (seen.has(value)) throw new TypeError(`${field} must be JSON`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, field, seen, depth + 1);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${field} must be JSON`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${field} must be JSON`);
      }
      assertJsonValue(item, field, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function assertProtocolEvent(value: unknown): asserts value is ProtocolEvent {
  const event = record(value, "event");
  const required = [
    "specversion",
    "id",
    "source",
    "type",
    "subject",
    "time",
    "datacontenttype",
    "dataschema",
    "wfsequence",
    "data",
  ];
  const optional = [
    "wftenant",
    "wfexchange",
    "wfthread",
    "wfhandoff",
    "wfactor",
    "wfendpoint",
    "wfcorrelation",
    "wfcausation",
    "wfvisibility",
  ];
  exactFields(event, required, optional, "event");
  if (event.specversion !== "1.0") throw new TypeError("event.specversion is invalid");
  if (event.datacontenttype !== "application/json") {
    throw new TypeError("event.datacontenttype is invalid");
  }
  for (const field of ["id", "source", "type", "subject", "dataschema"] as const) {
    boundedString(event[field], `event.${field}`, 2048);
  }
  timestamp(event.time, "event.time");
  if (!Number.isSafeInteger(event.wfsequence) || (event.wfsequence as number) < 0) {
    throw new TypeError("event.wfsequence is invalid");
  }
  for (const field of optional.filter((item) => item !== "wfvisibility")) {
    if (event[field] !== undefined) boundedString(event[field], `event.${field}`, 2048);
  }
  if (
    event.wfvisibility !== undefined
    && !["tenant", "participants", "restricted", "public"].includes(
      event.wfvisibility as string,
    )
  ) {
    throw new TypeError("event.wfvisibility is invalid");
  }
  assertJsonValue(event.data, "event.data");
}

export function assertDebugSubmission(
  value: unknown,
): asserts value is DebugSubmission {
  const submission = record(value, "Debug submission");
  exactFields(
    submission,
    [
      "tenant_id",
      "plugin_instance_id",
      "submission_id",
      "conversation_id",
      "idempotency_key",
      "request_digest",
      "created_at",
      "updated_at",
      "expires_at",
    ],
    ["ingress_id", "handoff_id"],
    "Debug submission",
  );
  boundedString(submission.tenant_id, "tenant_id", 128);
  boundedString(submission.plugin_instance_id, "plugin_instance_id", 128);
  boundedString(submission.submission_id, "submission_id", 128);
  boundedString(submission.conversation_id, "conversation_id", 512);
  boundedString(submission.idempotency_key, "idempotency_key", 256);
  if (
    typeof submission.request_digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(submission.request_digest)
  ) {
    throw new TypeError("request_digest is invalid");
  }
  if (submission.ingress_id !== undefined) {
    boundedString(submission.ingress_id, "ingress_id", 128);
  }
  if (submission.handoff_id !== undefined) {
    boundedString(submission.handoff_id, "handoff_id", 128);
  }
  timestamp(submission.created_at, "created_at");
  timestamp(submission.updated_at, "updated_at");
  timestamp(submission.expires_at, "expires_at");
  if (
    Date.parse(submission.updated_at) < Date.parse(submission.created_at)
    || Date.parse(submission.expires_at) < Date.parse(submission.updated_at)
  ) {
    throw new TypeError("Debug submission timestamp order is invalid");
  }
}

export function assertDebugCapture(
  value: unknown,
): asserts value is DebugCapture {
  const capture = record(value, "Debug capture");
  exactFields(
    capture,
    [
      "tenant_id",
      "plugin_instance_id",
      "capture_id",
      "conversation_id",
      "event_id",
      "destination_id",
      "event",
      "captured_at",
      "expires_at",
    ],
    [],
    "Debug capture",
  );
  boundedString(capture.tenant_id, "tenant_id", 128);
  boundedString(capture.plugin_instance_id, "plugin_instance_id", 128);
  boundedString(capture.capture_id, "capture_id", 128);
  boundedString(capture.conversation_id, "conversation_id", 512);
  boundedString(capture.event_id, "event_id", 2048);
  boundedString(capture.destination_id, "destination_id", 2048);
  assertProtocolEvent(capture.event);
  if (capture.event.id !== capture.event_id) {
    throw new TypeError("event_id does not match event.id");
  }
  timestamp(capture.captured_at, "captured_at");
  timestamp(capture.expires_at, "expires_at");
  if (Date.parse(capture.expires_at) < Date.parse(capture.captured_at)) {
    throw new TypeError("Debug capture timestamp order is invalid");
  }
}

export function assertListDebugCaptures(value: ListDebugCaptures): void {
  boundedString(value.tenant_id, "tenant_id", 128);
  boundedString(value.plugin_instance_id, "plugin_instance_id", 128);
  boundedString(value.conversation_id, "conversation_id", 512);
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100) {
    throw new RangeError("limit must be between 1 and 100");
  }
  if ((value.after_captured_at === undefined) !== (value.after_capture_id === undefined)) {
    throw new TypeError("capture cursor tuple must be complete");
  }
  if (value.after_captured_at !== undefined) {
    timestamp(value.after_captured_at, "after_captured_at");
    boundedString(value.after_capture_id, "after_capture_id", 128);
  }
}

export function assertPruneExpiredDebugRecords(
  value: PruneExpiredDebugRecords,
): void {
  boundedString(value.tenant_id, "tenant_id", 128);
  boundedString(value.plugin_instance_id, "plugin_instance_id", 128);
  timestamp(value.now, "now");
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 10_000) {
    throw new RangeError("limit must be between 1 and 10000");
  }
}
