import type { RuntimeDriverResult, RuntimeJsonObject, RuntimeJsonValue, RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";

export const AGENTLY_WORKER_PROTOCOL = "workfabric.agent-runtime/1" as const;
export const MAX_JSON_DEPTH = 32;

export interface AgentlyWorkerRequestV1 {
  readonly protocol: typeof AGENTLY_WORKER_PROTOCOL;
  readonly command_id: string;
  readonly task: RuntimeTaskPackage;
  readonly provider: { readonly type: "OpenAICompatible"; readonly base_url: string; readonly model: string };
}

export type AgentlyWorkerRecordV1 =
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "progress"; readonly command_id: string; readonly sequence: number; readonly progress: number | null; readonly message: string; readonly observed_at: string }
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "completed"; readonly command_id: string; readonly result: RuntimeDriverResult }
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "failed"; readonly command_id: string; readonly code: string; readonly message: string; readonly retryable: boolean };

function exactObject(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${path} must be an object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)) || fields.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${path} fields are invalid`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${path}.${key} must be data`);
    output[key] = descriptor.value;
  }
  return output;
}

function string(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) throw new TypeError(`${path} is invalid`);
  return value;
}

function command(value: unknown, expected: string): void {
  if (value !== expected) throw new TypeError("worker command_id does not match request");
}

function json(value: unknown, depth = 0): RuntimeJsonValue {
  if (depth > MAX_JSON_DEPTH) throw new RangeError("worker JSON exceeds maximum depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("worker JSON number is invalid"); return value; }
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("worker JSON must contain plain values");
  const result: Record<string, RuntimeJsonValue> = Object.create(null) as Record<string, RuntimeJsonValue>;
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 256) throw new RangeError("worker JSON key is too large");
    result[key] = json(child, depth + 1);
  }
  return result;
}

function result(value: unknown): RuntimeDriverResult {
  const parsed = exactObject(value, ["summary", "artifacts", "evidence", "extensions"], "worker result");
  if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.artifacts) || !Array.isArray(parsed.evidence)) throw new TypeError("worker result collections are invalid");
  const extensions = json(parsed.extensions);
  if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) throw new TypeError("worker result extensions are invalid");
  return { summary: parsed.summary.map((item) => json(item) as RuntimeJsonObject), artifacts: parsed.artifacts.map((item) => json(item) as RuntimeJsonObject), evidence: parsed.evidence.map((item) => json(item) as RuntimeJsonObject), extensions: extensions as RuntimeJsonObject };
}

export function parseAgentlyWorkerRecord(value: unknown, expectedCommandId: string): AgentlyWorkerRecordV1 {
  json(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("worker record must be an object");
  const discriminator = value as Record<string, unknown>;
  if (discriminator.type === "progress") {
    const header = exactObject(value, ["protocol", "type", "command_id", "sequence", "progress", "message", "observed_at"], "worker progress record");
    if (header.protocol !== AGENTLY_WORKER_PROTOCOL) throw new TypeError("worker protocol is unsupported");
    command(header.command_id, expectedCommandId);
    if (!Number.isSafeInteger(header.sequence) || (header.sequence as number) < 1) throw new TypeError("worker progress sequence is invalid");
    if (header.progress !== null && (typeof header.progress !== "number" || !Number.isFinite(header.progress) || header.progress < 0 || header.progress > 1)) throw new TypeError("worker progress value is invalid");
    return { protocol: AGENTLY_WORKER_PROTOCOL, type: "progress", command_id: expectedCommandId, sequence: header.sequence as number, progress: header.progress as number | null, message: string(header.message, "worker progress message", 8_192), observed_at: string(header.observed_at, "worker progress timestamp", 128) };
  }
  if (discriminator.type === "completed") {
    const parsed = exactObject(discriminator, ["protocol", "type", "command_id", "result"], "worker completed record");
    if (parsed.protocol !== AGENTLY_WORKER_PROTOCOL) throw new TypeError("worker protocol is unsupported");
    command(parsed.command_id, expectedCommandId);
    return { protocol: AGENTLY_WORKER_PROTOCOL, type: "completed", command_id: expectedCommandId, result: result(parsed.result) };
  }
  if (discriminator.type === "failed") {
    const parsed = exactObject(discriminator, ["protocol", "type", "command_id", "code", "message", "retryable"], "worker failed record");
    if (parsed.protocol !== AGENTLY_WORKER_PROTOCOL) throw new TypeError("worker protocol is unsupported");
    command(parsed.command_id, expectedCommandId);
    if (typeof parsed.retryable !== "boolean") throw new TypeError("worker retryable is invalid");
    return { protocol: AGENTLY_WORKER_PROTOCOL, type: "failed", command_id: expectedCommandId, code: string(parsed.code, "worker failure code", 128), message: string(parsed.message, "worker failure message", 8_192), retryable: parsed.retryable };
  }
  throw new TypeError("worker record type is unsupported");
}
