import {
  validateRuntimeCapabilityContinuation,
  validateRuntimeDriverTurn,
  type RuntimeCapabilityContinuation,
  type RuntimeDriverResult,
  type RuntimeDriverTurn,
  type RuntimeJsonObject,
  type RuntimeJsonValue,
  type RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

export const AGENTLY_WORKER_PROTOCOL = "workfabric.agent-runtime/1" as const;
export const AGENTLY_WORKER_TURN_PROTOCOL =
  "workfabric.agent-runtime/2" as const;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 10_000;
export const MAX_JSON_STRING_BYTES = 131_072;

export interface AgentlyWorkerRequestV1 {
  readonly protocol: typeof AGENTLY_WORKER_PROTOCOL;
  readonly command_id: string;
  readonly task: RuntimeTaskPackage;
  readonly provider: { readonly type: "OpenAICompatible"; readonly base_url: string; readonly model: string };
}

export interface AgentlyWorkerRequestV2 {
  readonly protocol: typeof AGENTLY_WORKER_TURN_PROTOCOL;
  readonly command_id: string;
  readonly task: RuntimeTaskPackage;
  readonly continuation: RuntimeCapabilityContinuation | null;
  readonly provider: {
    readonly type: "OpenAICompatible";
    readonly base_url: string;
    readonly model: string;
  };
}

export type AgentlyWorkerRecordV1 =
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "progress"; readonly command_id: string; readonly sequence: number; readonly progress: number | null; readonly message: string; readonly observed_at: string }
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "completed"; readonly command_id: string; readonly result: RuntimeDriverResult }
  | { readonly protocol: typeof AGENTLY_WORKER_PROTOCOL; readonly type: "failed"; readonly command_id: string; readonly code: string; readonly message: string; readonly retryable: boolean };

export type AgentlyWorkerTurnRecordV2 =
  | {
      readonly protocol: typeof AGENTLY_WORKER_TURN_PROTOCOL;
      readonly type: "progress";
      readonly command_id: string;
      readonly sequence: number;
      readonly progress: number | null;
      readonly message: string;
      readonly observed_at: string;
    }
  | {
      readonly protocol: typeof AGENTLY_WORKER_TURN_PROTOCOL;
      readonly type: "final" | "capability_request";
      readonly command_id: string;
      readonly turn: RuntimeDriverTurn;
    }
  | {
      readonly protocol: typeof AGENTLY_WORKER_TURN_PROTOCOL;
      readonly type: "failed";
      readonly command_id: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

interface JsonBudget { nodes: number; stringBytes: number; readonly seen: WeakSet<object>; }

function ownData(value: object, key: string | symbol, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${path} must be an own data property`);
  return descriptor.value;
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${path} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError(`${path} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${path}.${key} must be an enumerable data property`);
    output[key] = descriptor.value;
  }
  return output;
}

function exactObject(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  const object = plainObject(value, path);
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(object, key))) throw new TypeError(`${path} fields are invalid`);
  return object;
}

function countString(value: string, budget: JsonBudget): string {
  budget.stringBytes += Buffer.byteLength(value, "utf8");
  if (budget.stringBytes > MAX_JSON_STRING_BYTES) throw new RangeError("worker JSON strings exceed their bound");
  return value;
}

function json(value: unknown, budget: JsonBudget, depth = 0): RuntimeJsonValue {
  if (depth > MAX_JSON_DEPTH) throw new RangeError("worker JSON exceeds maximum depth");
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) throw new RangeError("worker JSON exceeds its node bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return countString(value, budget);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("worker JSON number is invalid"); return value; }
  if (typeof value !== "object" || value === null) throw new TypeError("worker JSON is invalid");
  if (budget.seen.has(value)) throw new TypeError("worker JSON must not contain references");
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const length = ownData(value, "length", "worker JSON array");
    if (!Number.isSafeInteger(length) || (length as number) < 0) throw new TypeError("worker JSON array length is invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== (length as number) + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (length as number)))) throw new TypeError("worker JSON array is invalid");
    const output: RuntimeJsonValue[] = [];
    for (let index = 0; index < (length as number); index += 1) output.push(json(ownData(value, String(index), `worker JSON array[${index}]`), budget, depth + 1));
    return output;
  }
  const object = plainObject(value, "worker JSON object");
  const output: Record<string, RuntimeJsonValue> = {};
  for (const [key, child] of Object.entries(object)) {
    if (key.length > 256) throw new RangeError("worker JSON key is too large");
    countString(key, budget);
    output[key] = json(child, budget, depth + 1);
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

function jsonObject(value: unknown, path: string): RuntimeJsonObject {
  const object = plainObject(value, path);
  return object as RuntimeJsonObject;
}

function result(value: unknown): RuntimeDriverResult {
  const parsed = exactObject(value, ["summary", "artifacts", "evidence", "extensions"], "worker result");
  if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.artifacts) || !Array.isArray(parsed.evidence)) throw new TypeError("worker result collections are invalid");
  return {
    summary: parsed.summary.map((item, index) => jsonObject(item, `worker result.summary[${index}]`)),
    artifacts: parsed.artifacts.map((item, index) => jsonObject(item, `worker result.artifacts[${index}]`)),
    evidence: parsed.evidence.map((item, index) => jsonObject(item, `worker result.evidence[${index}]`)),
    extensions: jsonObject(parsed.extensions, "worker result.extensions"),
  };
}

export function parseAgentlyWorkerRecord(value: unknown, expectedCommandId: string): AgentlyWorkerRecordV1 {
  const safe = json(value, { nodes: 0, stringBytes: 0, seen: new WeakSet<object>() });
  const discriminator = plainObject(safe, "worker record");
  if (discriminator.type === "progress") {
    const header = exactObject(discriminator, ["protocol", "type", "command_id", "sequence", "progress", "message", "observed_at"], "worker progress record");
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

export function parseAgentlyWorkerTurnRecord(
  value: unknown,
  expectedCommandId: string,
): AgentlyWorkerTurnRecordV2 {
  const safe = json(value, {
    nodes: 0,
    stringBytes: 0,
    seen: new WeakSet<object>(),
  });
  const discriminator = plainObject(safe, "worker turn record");
  if (discriminator.type === "progress") {
    const header = exactObject(
      discriminator,
      [
        "protocol",
        "type",
        "command_id",
        "sequence",
        "progress",
        "message",
        "observed_at",
      ],
      "worker turn progress record",
    );
    if (header.protocol !== AGENTLY_WORKER_TURN_PROTOCOL) {
      throw new TypeError("worker turn protocol is unsupported");
    }
    command(header.command_id, expectedCommandId);
    if (
      !Number.isSafeInteger(header.sequence) ||
      (header.sequence as number) < 1
    ) {
      throw new TypeError("worker progress sequence is invalid");
    }
    if (
      header.progress !== null &&
      (typeof header.progress !== "number" ||
        !Number.isFinite(header.progress) ||
        header.progress < 0 ||
        header.progress > 1)
    ) {
      throw new TypeError("worker progress value is invalid");
    }
    return {
      protocol: AGENTLY_WORKER_TURN_PROTOCOL,
      type: "progress",
      command_id: expectedCommandId,
      sequence: header.sequence as number,
      progress: header.progress as number | null,
      message: string(header.message, "worker progress message", 8_192),
      observed_at: string(
        header.observed_at,
        "worker progress timestamp",
        128,
      ),
    };
  }
  if (discriminator.type === "final") {
    const parsed = exactObject(
      discriminator,
      ["protocol", "type", "command_id", "response"],
      "worker final record",
    );
    if (parsed.protocol !== AGENTLY_WORKER_TURN_PROTOCOL) {
      throw new TypeError("worker turn protocol is unsupported");
    }
    command(parsed.command_id, expectedCommandId);
    return {
      protocol: AGENTLY_WORKER_TURN_PROTOCOL,
      type: "final",
      command_id: expectedCommandId,
      turn: validateRuntimeDriverTurn({
        kind: "final",
        response: parsed.response,
      }),
    };
  }
  if (discriminator.type === "capability_request") {
    const parsed = exactObject(
      discriminator,
      ["protocol", "type", "command_id", "request"],
      "worker capability request record",
    );
    if (parsed.protocol !== AGENTLY_WORKER_TURN_PROTOCOL) {
      throw new TypeError("worker turn protocol is unsupported");
    }
    command(parsed.command_id, expectedCommandId);
    return {
      protocol: AGENTLY_WORKER_TURN_PROTOCOL,
      type: "capability_request",
      command_id: expectedCommandId,
      turn: validateRuntimeDriverTurn({
        kind: "capability_request",
        request: parsed.request,
      }),
    };
  }
  if (discriminator.type === "failed") {
    const parsed = exactObject(
      discriminator,
      [
        "protocol",
        "type",
        "command_id",
        "code",
        "message",
        "retryable",
      ],
      "worker turn failed record",
    );
    if (parsed.protocol !== AGENTLY_WORKER_TURN_PROTOCOL) {
      throw new TypeError("worker turn protocol is unsupported");
    }
    command(parsed.command_id, expectedCommandId);
    if (typeof parsed.retryable !== "boolean") {
      throw new TypeError("worker retryable is invalid");
    }
    return {
      protocol: AGENTLY_WORKER_TURN_PROTOCOL,
      type: "failed",
      command_id: expectedCommandId,
      code: string(parsed.code, "worker failure code", 128),
      message: string(parsed.message, "worker failure message", 8_192),
      retryable: parsed.retryable,
    };
  }
  throw new TypeError("worker turn record type is unsupported");
}

export function normalizeAgentlyWorkerRequestV2(
  value: AgentlyWorkerRequestV2,
): AgentlyWorkerRequestV2 {
  return {
    ...value,
    continuation:
      value.continuation === null
        ? null
        : validateRuntimeCapabilityContinuation(value.continuation),
  };
}
