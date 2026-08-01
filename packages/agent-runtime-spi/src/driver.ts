import type { AgentRoleProfile } from "./role.js";
import type { RuntimeJsonObject } from "./json.js";

export interface RuntimeTaskPackage {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly stream_version: number;
  readonly role: AgentRoleProfile;
  readonly capability_id: string | null;
  readonly source_reference: RuntimeJsonObject;
  readonly initiator: RuntimeJsonObject;
  readonly agent_private_context: RuntimeJsonObject | null;
  readonly intent: readonly RuntimeJsonObject[];
  readonly context_reference: RuntimeJsonObject | null;
  readonly resolved_context: RuntimeJsonObject | null;
  readonly authority_scope: RuntimeJsonObject;
  readonly acceptance_criteria: readonly RuntimeJsonObject[];
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
  readonly workspace_path: string;
}

export interface RuntimeProgress {
  readonly sequence: number;
  readonly progress: number | null;
  readonly message: string;
  readonly observed_at: string;
}

export interface RuntimeDriverResult {
  readonly summary: readonly RuntimeJsonObject[];
  readonly artifacts: readonly RuntimeJsonObject[];
  readonly evidence: readonly RuntimeJsonObject[];
  readonly extensions: RuntimeJsonObject;
}

export interface AgentRuntimeDriverManifest {
  readonly driver_type: string;
  readonly protocol_version: "1";
  readonly capability_ids: readonly string[];
}

export interface AgentRuntimeDriver {
  readonly manifest: Readonly<AgentRuntimeDriverManifest>;
  execute(
    task: RuntimeTaskPackage,
    progress: (update: RuntimeProgress) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDriverResult>;
}

export interface AgentRuntimeDriverFactory<Config = unknown> {
  readonly type: string;
  validate(value: unknown, path: string): Config;
  create(config: Config): Promise<AgentRuntimeDriver>;
}

const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError(`${label} contains unsupported or missing fields`);
  }
}

function normalizedId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 128) {
    throw new TypeError(`${field} must be a trimmed identifier no longer than 128 characters`);
  }
  return value;
}

function capabilityIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("capability_ids must be a non-empty array");
  }
  const ids = value.map((item) => normalizedId(item, "capability_id"));
  if (ids.some((id) => !CAPABILITY_ID.test(id))) {
    throw new TypeError("capability_ids must use dotted lowercase identifiers");
  }
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("capability_ids contains duplicate values");
  }
  return ids;
}

export function validateDriverManifest(value: unknown): Readonly<AgentRuntimeDriverManifest> {
  const manifest = requireObject(value, "Driver manifest");
  requireExactKeys(manifest, ["driver_type", "protocol_version", "capability_ids"], "Driver manifest");
  if (manifest.protocol_version !== "1") {
    throw new TypeError("protocol_version must be 1");
  }
  return deepFreeze({
    driver_type: normalizedId(manifest.driver_type, "driver_type"),
    protocol_version: "1",
    capability_ids: capabilityIds(manifest.capability_ids),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
