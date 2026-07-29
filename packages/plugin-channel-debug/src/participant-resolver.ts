import type {
  AdmissionResult,
  CollaborationAdmissionService,
} from "@work-fabric/admission-spi";

import type { DebugParticipantConfig } from "./config.js";

export type DebugParticipantResolution =
  | {
      readonly kind: "resolved";
      readonly identity: {
        readonly actor_id: string;
        readonly actor_type: "human" | "agent" | "system";
        readonly endpoint_id: string;
      };
      readonly representation_grant?: string;
    }
  | { readonly kind: "denied"; readonly reason_code: string }
  | {
      readonly kind: "temporarily_unavailable";
      readonly reason_code: string;
    };

export interface DebugParticipantResolutionInput {
  readonly participant_ref: string;
  readonly ingress_id: string;
  readonly idempotency_key: string;
}

export interface ConfiguredDebugParticipantResolverOptions {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly participants: Readonly<Record<string, DebugParticipantConfig>>;
  readonly admission: CollaborationAdmissionService;
}

function validGrant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function decision(result: unknown): AdmissionResult | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const candidate = result as Partial<AdmissionResult>;
  if (
    typeof candidate.decision !== "object"
    || candidate.decision === null
  ) {
    return null;
  }
  return candidate as AdmissionResult;
}

export class ConfiguredDebugParticipantResolver {
  constructor(
    private readonly options: ConfiguredDebugParticipantResolverOptions,
  ) {}

  async resolve(
    input: DebugParticipantResolutionInput,
  ): Promise<DebugParticipantResolution> {
    const participant = this.options.participants[input.participant_ref];
    if (participant === undefined) {
      return { kind: "denied", reason_code: "participant_unknown" };
    }
    if (participant.mode === "static") {
      return {
        kind: "resolved",
        identity: {
          actor_id: participant.actor_id,
          actor_type: participant.actor_type,
          endpoint_id: participant.endpoint_id,
        },
      };
    }
    let admitted: AdmissionResult | null;
    try {
      admitted = decision(await this.options.admission.admit(
        participant.policy_id,
        {
          tenant_id: this.options.tenant_id,
          connector_id: this.options.connector_id,
          source_system: "workfabric-debug",
          external_tenant_id: this.options.external_tenant_id,
          external_subject_type: participant.external_subject_type,
          external_subject_id: participant.external_subject_id,
          ingress_id: input.ingress_id,
          idempotency_key: input.idempotency_key,
        },
      ));
    } catch {
      return {
        kind: "temporarily_unavailable",
        reason_code: "admission_unavailable",
      };
    }
    if (admitted === null) {
      return {
        kind: "temporarily_unavailable",
        reason_code: "admission_invalid",
      };
    }
    if (admitted.decision.kind === "temporarily_unavailable") {
      return {
        kind: "temporarily_unavailable",
        reason_code: admitted.decision.reason_code,
      };
    }
    if (admitted.decision.kind === "deny") {
      return {
        kind: "denied",
        reason_code: admitted.decision.reason_code,
      };
    }
    const binding = admitted.decision.binding;
    if (
      admitted.decision.policy_id !== participant.policy_id
      || binding.tenant_id !== this.options.tenant_id
      || binding.connector_id !== this.options.connector_id
      || binding.source_system !== "workfabric-debug"
      || binding.external_tenant_id !== this.options.external_tenant_id
      || binding.external_subject_type !== participant.external_subject_type
      || !validGrant(admitted.representation_grant)
    ) {
      return { kind: "denied", reason_code: "scope_mismatch" };
    }
    return {
      kind: "resolved",
      identity: {
        actor_id: binding.actor_id,
        actor_type: binding.actor_type,
        endpoint_id: binding.endpoint_id,
      },
      representation_grant: admitted.representation_grant,
    };
  }
}
