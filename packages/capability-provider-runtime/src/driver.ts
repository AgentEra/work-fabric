import type {
  AgentRuntimeDriver,
  RuntimeDriverResult,
  RuntimeJsonObject,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";
import type {
  CapabilityExecutionContext,
  CapabilityExecutionRequest,
  CapabilityExecutor,
  CitizenJsonObject,
} from "@work-fabric/network-citizen-spi";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

export interface CapabilityProviderDriverOptions {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly capabilities: readonly string[];
  readonly executor: CapabilityExecutor;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  const prototype =
    value !== null && typeof value === "object"
      ? Object.getPrototypeOf(value)
      : undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requestInput(task: RuntimeTaskPackage): CitizenJsonObject {
  if (task.intent.length !== 1) throw new TypeError("capability intent is invalid");
  const content = object(task.intent[0], "capability intent");
  if (
    content.kind !== "data" ||
    typeof content.schema_ref !== "string"
  ) throw new TypeError("capability intent is invalid");
  return structuredClone(
    object(content.data, "capability input"),
  ) as CitizenJsonObject;
}

function authority(task: RuntimeTaskPackage): {
  readonly capability_version: string;
  readonly contract_digest: `sha256:${string}`;
  readonly invocation_id: string;
  readonly evidence: CitizenJsonObject;
} {
  const scope = object(task.authority_scope, "capability Authority");
  const extensions = object(scope.extensions, "capability Authority extensions");
  const evidence = object(
    extensions["workfabric.dev/capability_authority"],
    "capability Authority evidence",
  );
  const version = nonEmpty(
    evidence.capability_version,
    "capability Authority version",
  );
  const digest = nonEmpty(
    evidence.contract_digest,
    "capability Authority contract digest",
  );
  if (!DIGEST.test(digest)) {
    throw new TypeError("capability Authority contract digest is invalid");
  }
  return {
    invocation_id: nonEmpty(
      evidence.invocation_id,
      "capability Authority invocation",
    ),
    capability_version: version,
    contract_digest: digest as `sha256:${string}`,
    evidence: structuredClone(evidence) as CitizenJsonObject,
  };
}

export class CapabilityProviderDriver implements AgentRuntimeDriver {
  readonly manifest;

  constructor(private readonly options: CapabilityProviderDriverOptions) {
    if (options.capabilities.length === 0) {
      throw new TypeError("Capability Provider must expose capabilities");
    }
    this.manifest = Object.freeze({
      driver_type: "capability-provider",
      protocol_version: "1" as const,
      capability_ids: Object.freeze([...options.capabilities]),
    });
  }

  async execute(
    task: RuntimeTaskPackage,
    _progress: Parameters<AgentRuntimeDriver["execute"]>[1],
    signal: AbortSignal,
  ): Promise<RuntimeDriverResult> {
    if (
      task.capability_id === null ||
      !this.options.capabilities.includes(task.capability_id)
    ) throw new TypeError("capability is not provided by this runtime");
    const bound = authority(task);
    const declaration = this.options.executor.describeCapabilities().find(
      (item) => item.declaration_id === task.capability_id,
    );
    if (
      declaration === undefined ||
      declaration.version !== bound.capability_version ||
      canonicalCitizenDigest(declaration) !== bound.contract_digest
    ) throw new TypeError("capability bound Contract is unavailable");
    const request: CapabilityExecutionRequest = {
      invocation_id: bound.invocation_id,
      capability_id: task.capability_id,
      capability_version: bound.capability_version,
      contract_digest: bound.contract_digest,
      input: requestInput(task),
    };
    const context: CapabilityExecutionContext = {
      tenant_id: task.tenant_id,
      citizen_id: this.options.citizen_id,
      endpoint_id: this.options.endpoint_id,
      fencing_token: task.stream_version,
      authority_evidence: bound.evidence,
      signal,
    };
    const outcome = await this.options.executor.execute(request, context);
    const data = structuredClone(outcome) as RuntimeJsonObject;
    return {
      summary: [{
        kind: "data",
        schema_ref: "urn:work-fabric:schema:capability-result:1",
        data,
      }],
      artifacts: [],
      evidence: [],
      extensions: {
        "workfabric.dev/capability_outcome": outcome.outcome,
      },
    };
  }
}
