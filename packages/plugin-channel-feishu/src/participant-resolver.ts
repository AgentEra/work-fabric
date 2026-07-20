import type {
  AdmissionResult,
  CollaborationAdmissionService,
  ParticipantBinding,
} from "@work-fabric/admission-spi";
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

const DENY_REASONS = new Set([
  "explicit_deny",
  "not_internal_member",
  "inactive_subject",
  "default_deny",
  "scope_mismatch",
]);
const UNAVAILABLE_REASONS = new Set([
  "policy_unavailable",
  "evidence_unavailable",
  "store_unavailable",
  "grant_unavailable",
]);
const ALLOW_REASONS = new Set(["explicit_allow", "internal_member"]);

function strictRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("admission result is invalid");
  }
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("admission result is invalid");
  }
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new TypeError("admission result is invalid");
  }
  const parsed: Record<string, unknown> = {};
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError("admission result is invalid");
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("admission result is invalid");
    }
    parsed[key] = descriptor.value;
  }
  return parsed;
}

function bounded(value: unknown, maximum = 255): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value;
}

function kindOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("admission result is invalid");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("admission result is invalid");
    }
    return descriptor.value;
  } catch {
    throw new TypeError("admission result is invalid");
  }
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("admission result is invalid");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("admission result is invalid");
    }
    return descriptor.value;
  } catch {
    throw new TypeError("admission result is invalid");
  }
}

function parseBinding(value: unknown): ParticipantBinding {
  const binding = strictRecord(value, [
    "tenant_id", "connector_id", "source_system", "external_tenant_id",
    "external_subject_type", "external_subject_fingerprint", "actor_id",
    "actor_type", "endpoint_id", "created_at",
  ]);
  if (
    !bounded(binding.tenant_id)
    || !bounded(binding.connector_id)
    || !bounded(binding.source_system)
    || !bounded(binding.external_tenant_id)
    || binding.external_subject_type !== "human"
    || !bounded(binding.external_subject_fingerprint)
    || !bounded(binding.actor_id)
    || binding.actor_type !== "human"
    || !bounded(binding.endpoint_id)
    || !bounded(binding.created_at)
  ) {
    throw new TypeError("admission result is invalid");
  }
  return {
    tenant_id: binding.tenant_id,
    connector_id: binding.connector_id,
    source_system: binding.source_system,
    external_tenant_id: binding.external_tenant_id,
    external_subject_type: "human",
    external_subject_fingerprint: binding.external_subject_fingerprint,
    actor_id: binding.actor_id,
    actor_type: "human",
    endpoint_id: binding.endpoint_id,
    created_at: binding.created_at,
  };
}

function parseAdmissionResult(value: unknown): AdmissionResult {
  const rawDecision = ownData(value, "decision");
  const rawDecisionKind = kindOf(rawDecision);
  const result = strictRecord(
    value,
    rawDecisionKind === "allow"
      ? ["decision", "representation_grant"]
      : ["decision"],
  );
  const decisionKind = kindOf(result.decision);
  if (decisionKind === "temporarily_unavailable") {
    const decision = strictRecord(result.decision, ["kind", "reason_code", "retry_after_seconds"]);
    if (
      typeof decision.reason_code !== "string"
      || !UNAVAILABLE_REASONS.has(decision.reason_code)
      || !Number.isSafeInteger(decision.retry_after_seconds)
      || (decision.retry_after_seconds as number) <= 0
      || (decision.retry_after_seconds as number) > 86_400
    ) throw new TypeError("admission result is invalid");
    return {
      decision: {
        kind: "temporarily_unavailable",
        reason_code: decision.reason_code as "policy_unavailable" | "evidence_unavailable" | "store_unavailable" | "grant_unavailable",
        retry_after_seconds: decision.retry_after_seconds as number,
      },
    };
  }
  if (decisionKind === "deny") {
    const decision = strictRecord(result.decision, ["kind", "reason_code", "policy_id", "policy_revision", "decision_id"]);
    if (
      typeof decision.reason_code !== "string"
      || !DENY_REASONS.has(decision.reason_code)
      || !bounded(decision.policy_id)
      || !bounded(decision.policy_revision)
      || !bounded(decision.decision_id)
    ) throw new TypeError("admission result is invalid");
    return {
      decision: {
        kind: "deny",
        reason_code: decision.reason_code as "explicit_deny" | "not_internal_member" | "inactive_subject" | "default_deny" | "scope_mismatch",
        policy_id: decision.policy_id,
        policy_revision: decision.policy_revision,
        decision_id: decision.decision_id,
      },
    };
  }
  if (decisionKind === "allow") {
    const decision = strictRecord(result.decision, ["kind", "reason_code", "policy_id", "policy_revision", "binding", "decision_id"]);
    if (
      typeof decision.reason_code !== "string"
      || !ALLOW_REASONS.has(decision.reason_code)
      || !bounded(decision.policy_id)
      || !bounded(decision.policy_revision)
      || !bounded(decision.decision_id)
      || !bounded(result.representation_grant, 16_384)
    ) throw new TypeError("admission result is invalid");
    return {
      decision: {
        kind: "allow",
        reason_code: decision.reason_code as "explicit_allow" | "internal_member",
        policy_id: decision.policy_id,
        policy_revision: decision.policy_revision,
        binding: parseBinding(decision.binding),
        decision_id: decision.decision_id,
      },
      representation_grant: result.representation_grant,
    };
  }
  throw new TypeError("admission result is invalid");
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
    let result: AdmissionResult;
    try {
      result = parseAdmissionResult(
        await this.options.admission.admit(this.options.policy_id, {
          tenant_id: this.options.tenant_id,
          connector_id: this.options.connector_id,
          source_system: "feishu",
          external_tenant_id: this.options.external_tenant_id,
          external_subject_type: "human",
          external_subject_id: input.external_subject_id,
          ingress_id: input.claim.ingress_id,
        }),
      );
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
