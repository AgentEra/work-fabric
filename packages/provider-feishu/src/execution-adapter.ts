import type {
  CapabilityExecutionContext,
  CapabilityExecutionRequest,
  CapabilityExecutionResult,
  CapabilityExecutor,
  CitizenJsonObject,
} from "@work-fabric/network-citizen-spi";

import type {
  FeishuCapabilityExecutionRequest,
  FeishuCapabilityOutcome,
} from "./contracts.js";
import { feishuCapabilityDeclarations } from "./declarations.js";

export interface FeishuCapabilityExecutorLike {
  execute(request: FeishuCapabilityExecutionRequest): Promise<FeishuCapabilityOutcome>;
}

function nonEmpty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError("invalid authority evidence");
  }
  return value;
}

function strings(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) =>
      typeof item !== "string" || item.length === 0 || item.length > 1_024
    )
  ) throw new TypeError("invalid authority evidence");
  return Object.freeze([...value] as string[]);
}

function sourceReference(value: unknown): CitizenJsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).uri !== "string" ||
    (value as Record<string, unknown>).extensions === null ||
    typeof (value as Record<string, unknown>).extensions !== "object" ||
    Array.isArray((value as Record<string, unknown>).extensions)
  ) {
    throw new TypeError("invalid authority evidence");
  }
  return structuredClone(value) as CitizenJsonObject;
}

function authority(value: CitizenJsonObject): {
  readonly original_handoff_id: string;
  readonly represented_actor_id: string;
  readonly delegation_id: string;
  readonly delegation_scopes: readonly string[];
  readonly delegation_expires_at: string;
  readonly allowed_target_refs: readonly string[];
  readonly confirmation_proof_refs: readonly string[];
  readonly source_reference?: CitizenJsonObject;
} {
  return {
    original_handoff_id: nonEmpty(value.original_handoff_id),
    represented_actor_id: nonEmpty(value.represented_actor_id),
    delegation_id: nonEmpty(value.delegation_id),
    delegation_scopes: strings(value.delegation_scopes),
    delegation_expires_at: nonEmpty(value.delegation_expires_at),
    allowed_target_refs: strings(value.allowed_target_refs),
    confirmation_proof_refs: strings(value.confirmation_proof_refs),
    ...(value.source_reference === undefined
      ? {}
      : { source_reference: sourceReference(value.source_reference) }),
  };
}

export class FeishuCapabilityExecutorPortAdapter
  implements CapabilityExecutor {
  constructor(private readonly executor: FeishuCapabilityExecutorLike) {}

  describeCapabilities() {
    return feishuCapabilityDeclarations();
  }

  async execute(
    request: CapabilityExecutionRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    let evidence: ReturnType<typeof authority>;
    try {
      evidence = authority(context.authority_evidence);
    } catch {
      return {
        outcome: "rejected",
        code: "authority_denied",
        message: "Capability Authority evidence is invalid",
        retryable: false,
      };
    }
    return this.executor.execute({
      tenant_id: context.tenant_id,
      original_handoff_id: evidence.original_handoff_id,
      represented_actor_id: evidence.represented_actor_id,
      delegation_id: evidence.delegation_id,
      delegation_scopes: evidence.delegation_scopes,
      delegation_expires_at: evidence.delegation_expires_at,
      invocation_id: request.invocation_id,
      idempotency_key: `${context.citizen_id}:${request.invocation_id}`,
      capability_id: request.capability_id,
      input: request.input,
      authority: {
        allowed_target_refs: evidence.allowed_target_refs,
        confirmation_proof_refs: evidence.confirmation_proof_refs,
        ...(evidence.source_reference === undefined
          ? {}
          : { source_reference: evidence.source_reference }),
      },
      signal: context.signal,
    });
  }
}
