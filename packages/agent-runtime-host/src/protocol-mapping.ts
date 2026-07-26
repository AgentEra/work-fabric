import type { RuntimeDriverResult, RuntimeJsonObject, RuntimeProgress } from "@work-fabric/agent-runtime-spi";
import type { HandoffResultPayload, HandoffStatusPayload } from "@work-fabric/sdk-typescript";

import { invalid } from "./errors.js";

function identifier(value: string, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) invalid("invalid_identifier", path);
  return value;
}

function timestamp(value: string, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid("invalid_timestamp", path);
  return value;
}

function objects(value: readonly RuntimeJsonObject[], path: string): readonly RuntimeJsonObject[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) invalid("invalid_json_objects", path);
  return value;
}

function extensions(value: RuntimeJsonObject): RuntimeJsonObject {
  const entries = Object.entries(value);
  if (entries.length > 32 || entries.some(([key, item]) => !/^runtime\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(key) || item === undefined)) invalid("invalid_extensions", "extensions");
  return value;
}

export function statusPayload(handoffId: string, update: RuntimeProgress): HandoffStatusPayload {
  identifier(handoffId, "handoff_id");
  if (!Number.isSafeInteger(update.sequence) || update.sequence < 1) invalid("invalid_progress", "sequence");
  if (update.progress !== null && (typeof update.progress !== "number" || !Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1)) invalid("invalid_progress", "progress");
  if (typeof update.message !== "string" || update.message.length === 0 || update.message.length > 4_096) invalid("invalid_progress", "message");
  timestamp(update.observed_at, "observed_at");
  return { handoff_id: handoffId, status: { phase: "in_progress", sequence: update.sequence, progress: update.progress, message: update.message, observed_at: update.observed_at } };
}

export function resultPayload(handoffId: string, result: RuntimeDriverResult): HandoffResultPayload {
  identifier(handoffId, "handoff_id");
  const summary = objects(result.summary, "summary");
  if (summary.length === 0) invalid("invalid_result", "summary");
  return { handoff_id: handoffId, result: { summary, artifacts: objects(result.artifacts, "artifacts"), evidence: objects(result.evidence, "evidence"), extensions: extensions(result.extensions) } };
}
