import type { AdmissionPolicy, AdmissionPolicyProvider, AdmissionSubjectType } from "@work-fabric/admission-spi";
import type { NamedConfigurationSectionValidator } from "@work-fabric/configuration-runtime";

export interface AdmissionConfigurationSection {
  readonly policies: Readonly<Record<string, AdmissionPolicy>>;
  readonly evidence_providers: Readonly<Record<string, {
    readonly type: string;
    readonly config: Readonly<Record<string, unknown>>;
  }>>;
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`${path} contains unknown key ${unknown}`);
  return result;
}

function identifier(value: unknown, path: string, maximum = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function subjectType(value: unknown, path: string): AdmissionSubjectType {
  if (value !== "human" && value !== "agent" && value !== "system") throw new TypeError(`${path} is invalid`);
  return value;
}

function namedRecord(value: unknown, path: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length > maximum) throw new RangeError(`${path} exceeds its bound`);
  for (const key of Object.keys(result)) identifier(key, `${path} key`, 128);
  return result;
}

function subjectIds(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new RangeError(`${path} is outside its bound`);
  const result = value.map((item, index) => {
    const id = identifier(item, `${path}[${index}]`);
    if (id === "*") throw new TypeError(`${path}[${index}] must not be a wildcard`);
    return id;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${path} contains duplicates`);
  return result;
}

function ttl(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 86_400) throw new RangeError(`${path} is outside its bound`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validatePolicy(value: unknown, path: string, evidenceProviders: Readonly<Record<string, unknown>>): AdmissionPolicy {
  const root = object(value, path, [
    "policy_id", "revision", "tenant_id", "connector_id", "source_system", "external_tenant_id",
    "default", "allow", "deny", "internal_membership", "binding",
  ]);
  const allow = object(root.allow, `${path}.allow`, ["all_internal_members", "external_subject_ids"]);
  const deny = object(root.deny, `${path}.deny`, ["external_subject_ids"]);
  const binding = object(root.binding, `${path}.binding`, ["actor_type", "store_ref"]);
  if (root.default !== "deny") throw new TypeError(`${path}.default must be deny`);
  if (typeof allow.all_internal_members !== "boolean") throw new TypeError(`${path}.allow.all_internal_members is invalid`);
  const allInternalMembers = allow.all_internal_members;
  let internalMembership: AdmissionPolicy["internal_membership"];
  if (root.internal_membership !== undefined) {
    const membership = object(root.internal_membership, `${path}.internal_membership`, [
      "evidence_provider_ref", "positive_ttl_seconds", "negative_ttl_seconds",
    ]);
    const evidenceProviderRef = identifier(membership.evidence_provider_ref, `${path}.internal_membership.evidence_provider_ref`, 128);
    if (evidenceProviders[evidenceProviderRef] === undefined) throw new TypeError(`${path}.internal_membership.evidence_provider_ref is unknown`);
    internalMembership = {
      evidence_provider_ref: evidenceProviderRef,
      positive_ttl_seconds: ttl(membership.positive_ttl_seconds, `${path}.internal_membership.positive_ttl_seconds`),
      negative_ttl_seconds: ttl(membership.negative_ttl_seconds, `${path}.internal_membership.negative_ttl_seconds`),
    };
  }
  const actorType = subjectType(binding.actor_type, `${path}.binding.actor_type`);
  if (allInternalMembers && internalMembership === undefined) throw new TypeError(`${path}.internal_membership is required for internal members`);
  if (allInternalMembers && actorType !== "human") throw new TypeError(`${path}.binding.actor_type must be human for internal members`);
  return {
    policy_id: identifier(root.policy_id, `${path}.policy_id`, 128),
    revision: identifier(root.revision, `${path}.revision`, 128),
    tenant_id: identifier(root.tenant_id, `${path}.tenant_id`),
    connector_id: identifier(root.connector_id, `${path}.connector_id`),
    source_system: identifier(root.source_system, `${path}.source_system`),
    external_tenant_id: identifier(root.external_tenant_id, `${path}.external_tenant_id`),
    default: "deny",
    allow: { all_internal_members: allInternalMembers, external_subject_ids: subjectIds(allow.external_subject_ids, `${path}.allow.external_subject_ids`) },
    deny: { external_subject_ids: subjectIds(deny.external_subject_ids, `${path}.deny.external_subject_ids`) },
    ...(internalMembership === undefined ? {} : { internal_membership: internalMembership }),
    binding: { actor_type: actorType, store_ref: identifier(binding.store_ref, `${path}.binding.store_ref`, 128) },
  };
}

export function validateAdmissionConfiguration(value: unknown, path: string): AdmissionConfigurationSection {
  const root = object(value, path, ["policies", "evidence_providers"]);
  const evidence = namedRecord(root.evidence_providers, `${path}.evidence_providers`, 100);
  const evidenceProviders = Object.fromEntries(Object.entries(evidence).map(([providerRef, candidate]) => {
    const descriptor = object(candidate, `${path}.evidence_providers.${providerRef}`, ["type", "config"]);
    const config = namedRecord(descriptor.config, `${path}.evidence_providers.${providerRef}.config`, 100);
    return [providerRef, {
      type: identifier(descriptor.type, `${path}.evidence_providers.${providerRef}.type`, 128),
      config: structuredClone(config),
    }];
  }));
  const policies = namedRecord(root.policies, `${path}.policies`, 1_000);
  const normalizedPolicies = Object.fromEntries(Object.entries(policies).map(([policyId, candidate]) => {
    const policy = validatePolicy(candidate, `${path}.policies.${policyId}`, evidenceProviders);
    if (policy.policy_id !== policyId) throw new TypeError(`${path}.policies.${policyId}.policy_id must match its map key`);
    return [policyId, policy];
  }));
  return deepFreeze({ policies: normalizedPolicies, evidence_providers: evidenceProviders });
}

export const admissionConfigurationValidator: NamedConfigurationSectionValidator<AdmissionConfigurationSection> = {
  section: "admission",
  type: "workfabric.admission.configuration.v1",
  validate(value, path) { return validateAdmissionConfiguration(value, path); },
};

export class ConfigurationAdmissionPolicyProvider implements AdmissionPolicyProvider {
  readonly manifest = {
    profile: "admission.policy-provider.v1",
    adapter: "configuration",
    capabilities: { immutable_revision: true, source_neutral: true },
  } as const;

  constructor(private readonly section: AdmissionConfigurationSection) {}

  async load(policyId: string): Promise<AdmissionPolicy | null> {
    const policy = this.section.policies[policyId];
    return policy === undefined ? null : structuredClone(policy);
  }
}
