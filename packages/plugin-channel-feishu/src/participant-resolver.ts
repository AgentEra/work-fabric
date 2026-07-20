import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import type {
  FeishuParticipantResolution,
  FeishuParticipantResolver,
} from "@work-fabric/connector-feishu";

import type { FeishuPluginIdentity } from "./config.js";

interface FeishuParticipantScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
}

function scopeMatches(
  scope: FeishuParticipantScope,
  claim: Parameters<FeishuParticipantResolver["resolve"]>[0]["claim"],
): boolean {
  return claim.envelope.tenant_id === scope.tenant_id
    && claim.envelope.connector_id === scope.connector_id
    && claim.envelope.source_system === "feishu"
    && claim.envelope.external_tenant_id === scope.external_tenant_id;
}

export interface LegacyFeishuParticipantResolverOptions extends FeishuParticipantScope {
  readonly identities: readonly FeishuPluginIdentity[];
}

export class LegacyFeishuParticipantResolver implements FeishuParticipantResolver {
  private readonly identities: ReadonlyMap<string, FeishuPluginIdentity>;

  constructor(private readonly options: LegacyFeishuParticipantResolverOptions) {
    this.identities = new Map(options.identities.map((identity) => [
      identity.external_open_id,
      structuredClone(identity),
    ]));
  }

  async resolve(
    input: Parameters<FeishuParticipantResolver["resolve"]>[0],
  ): Promise<FeishuParticipantResolution> {
    if (!scopeMatches(this.options, input.claim) || input.external_subject_type !== "human") {
      return { kind: "denied", reason_code: "scope_mismatch" };
    }
    const mapped = this.identities.get(input.external_subject_id);
    return mapped === undefined
      ? { kind: "denied", reason_code: "identity_unmapped" }
      : {
          kind: "resolved",
          identity: {
            actor_id: mapped.actor_id,
            actor_type: mapped.actor_type,
            endpoint_id: mapped.endpoint_id,
          },
        };
  }
}

export interface AdmissionFeishuParticipantResolverOptions extends FeishuParticipantScope {
  readonly policy_id: string;
  readonly admission: CollaborationAdmissionService;
}

export class AdmissionFeishuParticipantResolver implements FeishuParticipantResolver {
  constructor(private readonly options: AdmissionFeishuParticipantResolverOptions) {}

  async resolve(
    input: Parameters<FeishuParticipantResolver["resolve"]>[0],
  ): Promise<FeishuParticipantResolution> {
    if (!scopeMatches(this.options, input.claim) || input.external_subject_type !== "human") {
      return { kind: "denied", reason_code: "scope_mismatch" };
    }
    let result;
    try {
      result = await this.options.admission.admit(this.options.policy_id, {
        tenant_id: this.options.tenant_id,
        connector_id: this.options.connector_id,
        source_system: "feishu",
        external_tenant_id: this.options.external_tenant_id,
        external_subject_type: "human",
        external_subject_id: input.external_subject_id,
        ingress_id: input.claim.ingress_id,
      });
    } catch {
      return { kind: "temporarily_unavailable", reason_code: "admission_unavailable" };
    }
    if (result.decision.kind === "temporarily_unavailable") {
      return {
        kind: "temporarily_unavailable",
        reason_code: result.decision.reason_code,
      };
    }
    if (result.decision.kind === "deny") {
      return { kind: "denied", reason_code: result.decision.reason_code };
    }
    const binding = result.decision.binding;
    if (
      result.decision.policy_id !== this.options.policy_id
      || binding.tenant_id !== this.options.tenant_id
      || binding.connector_id !== this.options.connector_id
      || binding.source_system !== "feishu"
      || binding.external_tenant_id !== this.options.external_tenant_id
      || binding.external_subject_type !== "human"
    ) {
      return { kind: "denied", reason_code: "scope_mismatch" };
    }
    if (
      typeof result.representation_grant !== "string"
      || result.representation_grant.length === 0
      || result.representation_grant.length > 16_384
    ) {
      return { kind: "temporarily_unavailable", reason_code: "grant_unavailable" };
    }
    return {
      kind: "resolved",
      identity: {
        actor_id: binding.actor_id,
        actor_type: binding.actor_type,
        endpoint_id: binding.endpoint_id,
      },
      representation_grant: result.representation_grant,
    };
  }
}
