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

function authority(value: CitizenJsonObject): {
  readonly original_handoff_id: string;
  readonly initiating_actor_id: string;
  readonly allowed_target_refs: readonly string[];
  readonly allowed_document_tokens: readonly string[];
  readonly allowed_resource_policy_refs: readonly string[];
  readonly confirmation_proof_refs: readonly string[];
} {
  return {
    original_handoff_id: nonEmpty(value.original_handoff_id),
    initiating_actor_id: nonEmpty(value.initiating_actor_id),
    allowed_target_refs: strings(value.allowed_target_refs),
    allowed_document_tokens: strings(value.allowed_document_tokens),
    allowed_resource_policy_refs: strings(
      value.allowed_resource_policy_refs,
    ),
    confirmation_proof_refs: strings(value.confirmation_proof_refs),
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
      initiating_actor_id: evidence.initiating_actor_id,
      invocation_id: request.invocation_id,
      idempotency_key: `${context.citizen_id}:${request.invocation_id}`,
      capability_id: request.capability_id,
      input: request.input,
      authority: {
        allowed_target_refs: evidence.allowed_target_refs,
        allowed_document_tokens: evidence.allowed_document_tokens,
        allowed_resource_policy_refs:
          evidence.allowed_resource_policy_refs,
        confirmation_proof_refs: evidence.confirmation_proof_refs,
      },
      signal: context.signal,
    });
  }
}
