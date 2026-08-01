import type { RuntimeDriverResult, RuntimeJsonObject, RuntimeJsonValue, RuntimeProgress } from "@work-fabric/agent-runtime-spi";
import { createHash } from "node:crypto";
import type { HandoffResultPayload, HandoffStatusPayload } from "@work-fabric/sdk-typescript";

import { invalid } from "./errors.js";
import { normalizeRfc3339 } from "./rfc3339.js";

const EXTENSION_KEY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z][a-z0-9_]*$/;
const SENSITIVE_KEY = /(?:access[_-]?token|refresh[_-]?token|password|passwd|credential|client[_-]?secret|private[_-]?key|api[_-]?key)/;

function identifier(value: string, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) invalid("invalid_identifier", path);
  return value;
}

function timestamp(value: string, path: string): string {
  return normalizeRfc3339(value, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid("invalid_result", path);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = [...required, ...optional];
  if (!required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))) invalid("invalid_result", path);
}

function safeJson(value: unknown, path: string): RuntimeJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid("invalid_result", path); return value; }
  if (Array.isArray(value)) return value.map((item, index) => safeJson(item, `${path}.${index}`));
  const item = record(value, path);
  const output: Record<string, RuntimeJsonValue> = {};
  for (const [key, child] of Object.entries(item)) {
    if (SENSITIVE_KEY.test(key)) invalid("invalid_result", path);
    output[key] = safeJson(child, `${path}.${key}`);
  }
  return output;
}

function extensions(value: unknown, path: string): RuntimeJsonObject {
  const item = record(value, path);
  if (Object.keys(item).length > 32) invalid("invalid_extensions", path);
  for (const [key, child] of Object.entries(item)) {
    if (!EXTENSION_KEY.test(key) || SENSITIVE_KEY.test(key)) invalid("invalid_extensions", path);
    safeJson(child, `${path}.${key}`);
  }
  return item as RuntimeJsonObject;
}

function absoluteUri(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid("invalid_result", path);
  try { new URL(value); } catch { invalid("invalid_result", path); }
  return value;
}

function resource(value: unknown, path: string): RuntimeJsonObject {
  const item = record(value, path); exact(item, ["uri", "extensions"], ["name", "media_type", "schema_ref", "version", "digest", "access_hint"], path);
  absoluteUri(item.uri, `${path}.uri`); extensions(item.extensions, `${path}.extensions`);
  if (item.name !== undefined && (typeof item.name !== "string" || item.name.length === 0 || item.name.length > 512)) invalid("invalid_result", `${path}.name`);
  if (item.media_type !== undefined && (typeof item.media_type !== "string" || item.media_type.length > 255 || !/^[^/\s]+\/[^/\s]+$/.test(item.media_type))) invalid("invalid_result", `${path}.media_type`);
  if (item.schema_ref !== undefined && item.schema_ref !== null) absoluteUri(item.schema_ref, `${path}.schema_ref`);
  if (item.version !== undefined && item.version !== null && (typeof item.version !== "string" || item.version.length === 0 || item.version.length > 128)) invalid("invalid_result", `${path}.version`);
  if (item.digest !== undefined && item.digest !== null) {
    const digest = record(item.digest, `${path}.digest`); exact(digest, ["algorithm", "value"], [], `${path}.digest`);
    if (!["sha-256", "sha-384", "sha-512"].includes(digest.algorithm as string) || typeof digest.value !== "string" || digest.value.length === 0) invalid("invalid_result", `${path}.digest`);
  }
  if (item.access_hint !== undefined && !["public", "delegated", "exchange_mediated", "binding_managed"].includes(item.access_hint as string)) invalid("invalid_result", `${path}.access_hint`);
  return item as RuntimeJsonObject;
}

function content(value: unknown, path: string): RuntimeJsonObject {
  const item = record(value, path);
  if (item.kind === "text") {
    exact(item, ["kind", "media_type", "text"], ["language", "extensions"], path);
    if (typeof item.media_type !== "string" || item.media_type.length > 255 || !/^text\/[^/\s]+$/.test(item.media_type) || typeof item.text !== "string" || (item.language !== undefined && (typeof item.language !== "string" || item.language.length === 0 || item.language.length > 35))) invalid("invalid_result", path);
  } else if (item.kind === "data") {
    exact(item, ["kind", "schema_ref", "data"], ["extensions"], path); absoluteUri(item.schema_ref, `${path}.schema_ref`); safeJson(item.data, `${path}.data`);
  } else if (item.kind === "resource") {
    exact(item, ["kind", "resource"], ["extensions"], path); resource(item.resource, `${path}.resource`);
  } else invalid("invalid_result", path);
  if (item.extensions !== undefined) extensions(item.extensions, `${path}.extensions`);
  return item as RuntimeJsonObject;
}

function unique(items: readonly RuntimeJsonObject[], path: string): readonly RuntimeJsonObject[] {
  if (new Set(items.map((item) => canonicalJson(item))).size !== items.length) invalid("invalid_result", path);
  return items;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}

function artifacts(value: readonly RuntimeJsonObject[]): readonly RuntimeJsonObject[] {
  if (!Array.isArray(value)) invalid("invalid_result", "artifacts");
  const output = value.map((value, index) => {
    const item = record(value, `artifacts.${index}`); exact(item, ["artifact_id", "artifact_type", "resource"], ["extensions"], `artifacts.${index}`);
    identifier(item.artifact_id as string, `artifacts.${index}.artifact_id`);
    if (typeof item.artifact_type !== "string" || !/^[a-z][a-z0-9_]*$/.test(item.artifact_type) || item.artifact_type.length > 128) invalid("invalid_result", `artifacts.${index}.artifact_type`);
    resource(item.resource, `artifacts.${index}.resource`); if (item.extensions !== undefined) extensions(item.extensions, `artifacts.${index}.extensions`);
    return item as RuntimeJsonObject;
  });
  return unique(output, "artifacts");
}

function evidence(value: readonly RuntimeJsonObject[]): readonly RuntimeJsonObject[] {
  if (!Array.isArray(value)) invalid("invalid_result", "evidence");
  const output = value.map((value, index) => {
    const item = record(value, `evidence.${index}`); exact(item, ["evidence_id", "evidence_type", "content"], ["extensions"], `evidence.${index}`);
    identifier(item.evidence_id as string, `evidence.${index}.evidence_id`);
    if (typeof item.evidence_type !== "string" || !/^[a-z][a-z0-9_]*$/.test(item.evidence_type) || item.evidence_type.length > 128) invalid("invalid_result", `evidence.${index}.evidence_type`);
    content(item.content, `evidence.${index}.content`); if (item.extensions !== undefined) extensions(item.extensions, `evidence.${index}.extensions`);
    return item as RuntimeJsonObject;
  });
  return unique(output, "evidence");
}

export function statusPayload(handoffId: string, update: RuntimeProgress): HandoffStatusPayload {
  identifier(handoffId, "handoff_id");
  if (!Number.isSafeInteger(update.sequence) || update.sequence < 1) invalid("invalid_progress", "sequence");
  if (update.progress !== null && (typeof update.progress !== "number" || !Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1)) invalid("invalid_progress", "progress");
  if (typeof update.message !== "string" || update.message.length === 0 || update.message.length > 4_096) invalid("invalid_progress", "message");
  const observedAt = timestamp(update.observed_at, "observed_at");
  const statusReportId = `status-${createHash("sha256").update(handoffId).digest("hex").slice(0, 48)}-${update.sequence}`;
  return { handoff_id: handoffId, status: { status_report_id: statusReportId, execution_status: "in_progress", ...(update.progress === null ? {} : { progress: update.progress }), message: [{ kind: "text", media_type: "text/plain", text: update.message }], observed_at: observedAt, blocked_on: [] } };
}

export function resultPayload(handoffId: string, result: RuntimeDriverResult): HandoffResultPayload {
  identifier(handoffId, "handoff_id");
  if (!Array.isArray(result.summary) || result.summary.length === 0) invalid("invalid_result", "summary");
  const summary = result.summary.map((value, index) => content(value, `summary.${index}`));
  return { handoff_id: handoffId, result: { summary, artifacts: artifacts(result.artifacts), evidence: evidence(result.evidence), extensions: extensions(result.extensions, "extensions") } };
}
