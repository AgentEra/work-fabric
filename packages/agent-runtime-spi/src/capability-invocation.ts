import type {
  AgentRuntimeDriver,
  RuntimeDriverResult,
  RuntimeProgress,
  RuntimeTaskPackage,
} from "./driver.js";
import type {
  RuntimeJsonObject,
  RuntimeJsonValue,
} from "./json.js";

export interface CapabilityRequirement {
  readonly capability_id: string;
  readonly version_constraint: string;
}

export interface CapabilityInvocationRequest {
  readonly invocation_id: string;
  readonly original_handoff_id: string;
  readonly thread_id: string;
  readonly capability_id: string;
  readonly version_constraint: string;
  readonly input: RuntimeJsonObject;
  readonly reason: string;
  readonly deadline: string;
}

export interface CapabilityCandidate {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly capability_id: string;
  readonly capability_version: string;
  readonly contract_digest: `sha256:${string}`;
}

export type CapabilityInvocationResult =
  | {
      readonly outcome: "succeeded";
      readonly invocation_id: string;
      readonly auxiliary_handoff_id: string;
      readonly candidate: CapabilityCandidate;
      readonly data: RuntimeJsonObject;
      readonly artifacts: readonly RuntimeJsonObject[];
    }
  | {
      readonly outcome: "rejected" | "failed";
      readonly invocation_id: string;
      readonly auxiliary_handoff_id: string | null;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface CapabilityInvocationPort {
  discover(
    requirement: CapabilityRequirement,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]>;
  invoke(
    request: CapabilityInvocationRequest,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationResult>;
}

export type CapabilityOperationKind =
  | "query"
  | "command"
  | "destructive";

export interface RuntimeCapabilitySummary {
  readonly citizen_id: string;
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly operation_kind: CapabilityOperationKind;
  /** Provider-owned, dynamically resolved invocation contract. */
  readonly input_schema: RuntimeJsonObject | null;
}

export interface CapabilityDisclosurePort {
  list(
    namespaces: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly RuntimeCapabilitySummary[]>;
}

export interface RuntimeCapabilityRequest {
  readonly invocation_id: string;
  readonly capability_id: string;
  readonly version_constraint: string;
  readonly input: RuntimeJsonObject;
  readonly reason: string;
}

export type RuntimeDriverTurn =
  | {
      readonly kind: "final";
      readonly response: RuntimeDriverResult;
    }
  | {
      readonly kind: "capability_request";
      readonly request: RuntimeCapabilityRequest;
    };

export interface RuntimeCapabilityContinuation {
  readonly request: RuntimeCapabilityRequest;
  readonly result: CapabilityInvocationResult;
}

export interface CapabilityAwareAgentRuntimeDriver {
  executeTurn(
    task: RuntimeTaskPackage,
    availableCapabilities: readonly RuntimeCapabilitySummary[],
    continuation: RuntimeCapabilityContinuation | null,
    progress: (update: RuntimeProgress) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDriverTurn>;
}

const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[a-z][a-z0-9_]*$/;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

interface JsonBudget {
  nodes: number;
  bytes: number;
  readonly seen: WeakSet<object>;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key === "string" && !fields.includes(key))
  ) {
    throw new TypeError(`${path} fields are invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function string(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function opaqueId(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!OPAQUE_ID.test(result)) throw new TypeError(`${path} is invalid`);
  return result;
}

function capabilityId(value: unknown): string {
  const result = string(value, "capability_id", 128);
  if (!CAPABILITY_ID.test(result)) {
    throw new TypeError("capability_id is invalid");
  }
  return result;
}

function versionConstraint(value: unknown): string {
  return string(value, "version_constraint", 256);
}

function json(
  value: unknown,
  path: string,
  budget: JsonBudget,
  depth = 0,
): RuntimeJsonValue {
  if (depth > 32) throw new RangeError(`${path} exceeds maximum depth`);
  budget.nodes += 1;
  if (budget.nodes > 10_000) throw new RangeError(`${path} exceeds maximum nodes`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} number is invalid`);
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += encoder.encode(value).byteLength;
    if (budget.bytes > 131_072) throw new RangeError(`${path} exceeds maximum bytes`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is invalid JSON`);
  if (budget.seen.has(value)) {
    throw new TypeError(`${path} contains a cyclic reference`);
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length)) {
      throw new TypeError(`${path}.length must be a data property`);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length),
      )
    ) {
      throw new TypeError(`${path} array fields are invalid`);
    }
    return value.map((item, index) =>
      json(item, `${path}[${index}]`, budget, depth + 1),
    );
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const output: Record<string, RuntimeJsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} contains a symbol key`);
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${path} contains unsafe key ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    budget.bytes += encoder.encode(key).byteLength;
    if (budget.bytes > 131_072) throw new RangeError(`${path} exceeds maximum bytes`);
    output[key] = json(descriptor.value, `${path}.${key}`, budget, depth + 1);
  }
  return output;
}

function jsonObject(value: unknown, path: string): RuntimeJsonObject {
  const result = json(
    value,
    path,
    { nodes: 0, bytes: 0, seen: new WeakSet<object>() },
  );
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`${path} must be a JSON object`);
  }
  return result as RuntimeJsonObject;
}

function jsonObjectArray(
  value: unknown,
  path: string,
): readonly RuntimeJsonObject[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError(`${path} must be a bounded array`);
  }
  return value.map((item, index) => jsonObject(item, `${path}[${index}]`));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function runtimeResult(value: unknown): RuntimeDriverResult {
  const source = exactObject(
    value,
    ["summary", "artifacts", "evidence", "extensions"],
    "final response",
  );
  return deepFreeze({
    summary: jsonObjectArray(source.summary, "final response.summary"),
    artifacts: jsonObjectArray(source.artifacts, "final response.artifacts"),
    evidence: jsonObjectArray(source.evidence, "final response.evidence"),
    extensions: jsonObject(source.extensions, "final response.extensions"),
  });
}

function runtimeRequest(value: unknown): RuntimeCapabilityRequest {
  const source = exactObject(
    value,
    [
      "invocation_id",
      "capability_id",
      "version_constraint",
      "input",
      "reason",
    ],
    "capability request",
  );
  return deepFreeze({
    invocation_id: opaqueId(source.invocation_id, "invocation_id"),
    capability_id: capabilityId(source.capability_id),
    version_constraint: versionConstraint(source.version_constraint),
    input: jsonObject(source.input, "input"),
    reason: string(source.reason, "reason", 8_192),
  });
}

function runtimeCapabilitySummary(value: unknown): RuntimeCapabilitySummary {
  const source = exactObject(
    value,
    [
      "citizen_id",
      "capability_id",
      "version",
      "name",
      "description",
      "operation_kind",
      "input_schema",
    ],
    "Runtime capability summary",
  );
  const version = string(source.version, "version", 64);
  if (!SEMVER.test(version)) throw new TypeError("version is invalid");
  const operationKind = source.operation_kind;
  if (
    operationKind !== "query" &&
    operationKind !== "command" &&
    operationKind !== "destructive"
  ) {
    throw new TypeError("operation_kind is invalid");
  }
  return deepFreeze({
    citizen_id: opaqueId(source.citizen_id, "citizen_id"),
    capability_id: capabilityId(source.capability_id),
    version,
    name: string(source.name, "name", 256),
    description: string(source.description, "description", 2_048),
    operation_kind: operationKind,
    input_schema: source.input_schema === null
      ? null
      : jsonObject(source.input_schema, "input_schema"),
  });
}

export function validateRuntimeCapabilitySummaries(
  value: unknown,
): readonly RuntimeCapabilitySummary[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError("Runtime capability summaries must be a bounded array");
  }
  const summaries = value.map((item) => runtimeCapabilitySummary(item));
  const identities = new Set<string>();
  for (const summary of summaries) {
    const identity =
      `${summary.citizen_id}\u0000${summary.capability_id}\u0000${summary.version}`;
    if (identities.has(identity)) {
      throw new TypeError("Runtime capability summaries contain a duplicate");
    }
    identities.add(identity);
  }
  return deepFreeze(summaries);
}

export function validateCapabilityInvocationRequest(
  value: unknown,
): Readonly<CapabilityInvocationRequest> {
  const source = exactObject(
    value,
    [
      "invocation_id",
      "original_handoff_id",
      "thread_id",
      "capability_id",
      "version_constraint",
      "input",
      "reason",
      "deadline",
    ],
    "Capability invocation request",
  );
  const deadline = string(source.deadline, "deadline", 128);
  if (!RFC3339.test(deadline) || !Number.isFinite(Date.parse(deadline))) {
    throw new TypeError("deadline is invalid");
  }
  return deepFreeze({
    invocation_id: opaqueId(source.invocation_id, "invocation_id"),
    original_handoff_id: opaqueId(
      source.original_handoff_id,
      "original_handoff_id",
    ),
    thread_id: opaqueId(source.thread_id, "thread_id"),
    capability_id: capabilityId(source.capability_id),
    version_constraint: versionConstraint(source.version_constraint),
    input: jsonObject(source.input, "input"),
    reason: string(source.reason, "reason", 8_192),
    deadline,
  });
}

export function validateCapabilityCandidate(
  value: unknown,
): Readonly<CapabilityCandidate> {
  const source = exactObject(
    value,
    [
      "citizen_id",
      "endpoint_id",
      "capability_id",
      "capability_version",
      "contract_digest",
    ],
    "Capability candidate",
  );
  const capabilityVersion = string(
    source.capability_version,
    "capability_version",
    64,
  );
  if (!SEMVER.test(capabilityVersion)) {
    throw new TypeError("capability_version is invalid");
  }
  const contractDigest = string(
    source.contract_digest,
    "contract_digest",
    71,
  );
  if (!DIGEST.test(contractDigest)) {
    throw new TypeError("contract_digest is invalid");
  }
  return deepFreeze({
    citizen_id: opaqueId(source.citizen_id, "citizen_id"),
    endpoint_id: opaqueId(source.endpoint_id, "endpoint_id"),
    capability_id: capabilityId(source.capability_id),
    capability_version: capabilityVersion,
    contract_digest: contractDigest as `sha256:${string}`,
  });
}

export function validateCapabilityInvocationResult(
  value: unknown,
): Readonly<CapabilityInvocationResult> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Capability invocation result must be an object");
  }
  const outcome = Object.getOwnPropertyDescriptor(value, "outcome");
  if (outcome === undefined || !("value" in outcome)) {
    throw new TypeError("Capability invocation result outcome is invalid");
  }
  if (outcome.value === "succeeded") {
    const source = exactObject(
      value,
      [
        "outcome",
        "invocation_id",
        "auxiliary_handoff_id",
        "candidate",
        "data",
        "artifacts",
      ],
      "Capability invocation success",
    );
    return deepFreeze({
      outcome: "succeeded",
      invocation_id: opaqueId(source.invocation_id, "invocation_id"),
      auxiliary_handoff_id: opaqueId(
        source.auxiliary_handoff_id,
        "auxiliary_handoff_id",
      ),
      candidate: validateCapabilityCandidate(source.candidate),
      data: jsonObject(source.data, "data"),
      artifacts: jsonObjectArray(source.artifacts, "artifacts"),
    });
  }
  if (outcome.value !== "rejected" && outcome.value !== "failed") {
    throw new TypeError("Capability invocation result outcome is invalid");
  }
  const source = exactObject(
    value,
    [
      "outcome",
      "invocation_id",
      "auxiliary_handoff_id",
      "code",
      "message",
      "retryable",
    ],
    "Capability invocation failure",
  );
  const code = string(source.code, "code", 128);
  if (!CODE.test(code)) throw new TypeError("code is invalid");
  if (
    source.auxiliary_handoff_id !== null &&
    typeof source.auxiliary_handoff_id !== "string"
  ) {
    throw new TypeError("auxiliary_handoff_id is invalid");
  }
  if (typeof source.retryable !== "boolean") {
    throw new TypeError("retryable is invalid");
  }
  return deepFreeze({
    outcome: outcome.value,
    invocation_id: opaqueId(source.invocation_id, "invocation_id"),
    auxiliary_handoff_id:
      source.auxiliary_handoff_id === null
        ? null
        : opaqueId(source.auxiliary_handoff_id, "auxiliary_handoff_id"),
    code,
    message: string(source.message, "message", 8_192),
    retryable: source.retryable,
  });
}

export function validateRuntimeDriverTurn(
  value: unknown,
): Readonly<RuntimeDriverTurn> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runtime Driver turn must be an object");
  }
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (kind === undefined || !("value" in kind)) {
    throw new TypeError("Runtime Driver turn kind is invalid");
  }
  if (kind.value === "final") {
    const source = exactObject(
      value,
      ["kind", "response"],
      "Runtime Driver final turn",
    );
    return deepFreeze({
      kind: "final",
      response: runtimeResult(source.response),
    });
  }
  if (kind.value === "capability_request") {
    const source = exactObject(
      value,
      ["kind", "request"],
      "Runtime Driver capability turn",
    );
    return deepFreeze({
      kind: "capability_request",
      request: runtimeRequest(source.request),
    });
  }
  throw new TypeError("Runtime Driver turn kind is invalid");
}

export function validateRuntimeCapabilityContinuation(
  value: unknown,
): Readonly<RuntimeCapabilityContinuation> {
  const source = exactObject(
    value,
    ["request", "result"],
    "Runtime capability continuation",
  );
  const request = runtimeRequest(source.request);
  const result = validateCapabilityInvocationResult(source.result);
  if (request.invocation_id !== result.invocation_id) {
    throw new TypeError("continuation invocation_id does not match");
  }
  return deepFreeze({ request, result });
}

export function isCapabilityAwareAgentRuntimeDriver(
  driver: AgentRuntimeDriver,
): driver is AgentRuntimeDriver & CapabilityAwareAgentRuntimeDriver {
  return typeof (driver as Partial<CapabilityAwareAgentRuntimeDriver>)
    .executeTurn === "function";
}
