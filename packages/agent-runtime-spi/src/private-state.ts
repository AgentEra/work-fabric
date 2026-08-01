import type {
  RuntimeJsonObject,
  RuntimeJsonValue,
} from "./json.js";

export interface AgentPrivateStateRecord {
  readonly tenant_id: string;
  readonly namespace: string;
  readonly key: string;
  readonly version: number;
  readonly value: RuntimeJsonObject;
  readonly updated_at: string;
}

export interface AgentPrivateStateStore {
  getPrivateState(
    tenantId: string,
    namespace: string,
    key: string,
  ): Promise<AgentPrivateStateRecord | null>;
  putPrivateState(input: {
    readonly tenant_id: string;
    readonly namespace: string;
    readonly key: string;
    readonly expected_version: number;
    readonly value: RuntimeJsonObject;
    readonly updated_at: string;
  }): Promise<AgentPrivateStateRecord>;
}

export class AgentPrivateStateConflictError extends Error {
  constructor() {
    super("Agent private state version conflict");
    this.name = "AgentPrivateStateConflictError";
  }
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

function identifier(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !RFC3339.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("updated_at must be RFC3339");
  }
  return new Date(Date.parse(value)).toISOString();
}

interface JsonBudget {
  nodes: number;
  bytes: number;
  readonly seen: WeakSet<object>;
}

function json(
  value: unknown,
  budget: JsonBudget,
  depth = 0,
): RuntimeJsonValue {
  if (depth > 32) throw new RangeError("private state exceeds maximum depth");
  budget.nodes += 1;
  if (budget.nodes > 10_000) {
    throw new RangeError("private state exceeds maximum nodes");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("private state number is invalid");
    }
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += encoder.encode(value).byteLength;
    if (budget.bytes > 131_072) {
      throw new RangeError("private state exceeds maximum bytes");
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("private state is not JSON");
  }
  if (budget.seen.has(value)) {
    throw new TypeError("private state contains a cycle");
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_024) {
      throw new RangeError("private state array is too large");
    }
    return value.map((item) => json(item, budget, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("private state object is invalid");
  }
  const output: Record<string, RuntimeJsonValue> = {};
  for (const key of Object.keys(value)) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      FORBIDDEN_KEYS.has(key)
    ) {
      throw new TypeError("private state key is invalid");
    }
    budget.bytes += encoder.encode(key).byteLength;
    if (budget.bytes > 131_072) {
      throw new RangeError("private state exceeds maximum bytes");
    }
    output[key] = json(
      (value as Record<string, unknown>)[key],
      budget,
      depth + 1,
    );
  }
  return output;
}

function value(value: unknown): RuntimeJsonObject {
  const normalized = json(value, {
    nodes: 0,
    bytes: 0,
    seen: new WeakSet<object>(),
  });
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    throw new TypeError("private state value must be an object");
  }
  return normalized as RuntimeJsonObject;
}

export function validateAgentPrivateStateIdentity(
  tenantId: unknown,
  namespace: unknown,
  key: unknown,
): {
  readonly tenant_id: string;
  readonly namespace: string;
  readonly key: string;
} {
  return {
    tenant_id: identifier(tenantId, "tenant_id", 128),
    namespace: identifier(namespace, "namespace", 128),
    key: identifier(key, "key", 512),
  };
}

export function validateAgentPrivateStatePut(
  input: Parameters<AgentPrivateStateStore["putPrivateState"]>[0],
): Parameters<AgentPrivateStateStore["putPrivateState"]>[0] {
  const identity = validateAgentPrivateStateIdentity(
    input.tenant_id,
    input.namespace,
    input.key,
  );
  if (
    !Number.isSafeInteger(input.expected_version) ||
    input.expected_version < 0
  ) {
    throw new TypeError("expected_version is invalid");
  }
  return {
    ...identity,
    expected_version: input.expected_version,
    value: value(input.value),
    updated_at: timestamp(input.updated_at),
  };
}

export function validateAgentPrivateStateRecord(
  input: AgentPrivateStateRecord,
): AgentPrivateStateRecord {
  const identity = validateAgentPrivateStateIdentity(
    input.tenant_id,
    input.namespace,
    input.key,
  );
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError("version is invalid");
  }
  return {
    ...identity,
    version: input.version,
    value: value(input.value),
    updated_at: timestamp(input.updated_at),
  };
}
