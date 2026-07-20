import type { AdmissionPolicy, AdmissionPolicyProvider, AdmissionSubjectType } from "@work-fabric/admission-spi";
import type { NamedConfigurationSectionValidator } from "@work-fabric/configuration-runtime";

export interface AdmissionConfigurationSection {
  readonly policies: Readonly<Record<string, AdmissionPolicy>>;
  readonly evidence_providers: Readonly<Record<string, {
    readonly type: string;
    readonly config: Readonly<Record<string, unknown>>;
  }>>;
}

export class AdmissionConfigurationValidationError extends TypeError {
  constructor(readonly path: string, reason: string) {
    super(`${path} ${reason}`);
  }
}

function invalid(path: string, reason = "is invalid"): never {
  throw new AdmissionConfigurationValidationError(path, reason);
}

function ownKeys(value: object, path: string): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return invalid(path);
  }
}

function ownData(value: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalid(path);
  }
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
    return invalid(path);
  }
  return descriptor.value;
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "must be an object");
  const keys = ownKeys(value, path);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    return invalid(path, "contains unknown keys");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) result[key] = ownData(value, key, `${path}.${key}`);
  return result;
}

function identifier(value: unknown, path: string, maximum = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    return invalid(path);
  }
  return value;
}

function subjectType(value: unknown, path: string): AdmissionSubjectType {
  if (value !== "human" && value !== "agent" && value !== "system") return invalid(path);
  return value;
}

function namedRecord(value: unknown, path: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "must be an object");
  const keys = ownKeys(value, path);
  if (keys.some((key) => typeof key !== "string") || keys.length > maximum) return invalid(path, "exceeds its bound or contains symbol keys");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) {
    identifier(key, `${path} key`, 128);
    result[key] = ownData(value, key, `${path}.${key}`);
  }
  return result;
}

function arrayValues(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(path, "is outside its bound");
  const keys = ownKeys(value, path);
  const expected = new Set<string>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    return invalid(path);
  }
  return Array.from({ length: value.length }, (_, index) => ownData(value, String(index), `${path}[${index}]`));
}

function safeConfigurationValue(
  value: unknown,
  path: string,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || depth >= 64) return invalid(path);
  if (seen.has(value)) return invalid(path);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return arrayValues(value, path, 10_000).map((item, index) =>
        safeConfigurationValue(item, `${path}[${index}]`, depth + 1, seen));
    }
    let prototype: object | null;
    try { prototype = Object.getPrototypeOf(value) as object | null; } catch { return invalid(path); }
    if (prototype !== Object.prototype && prototype !== null) return invalid(path);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys(value, path)) {
      if (typeof key !== "string") return invalid(path);
      result[key] = safeConfigurationValue(
        ownData(value, key, `${path}.${key}`),
        `${path}.${key}`,
        depth + 1,
        seen,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function subjectIds(value: unknown, path: string): readonly string[] {
  const result = arrayValues(value, path, 10_000).map((item, index) => {
    const id = identifier(item, `${path}[${index}]`);
    if (id === "*") return invalid(`${path}[${index}]`, "must not be a wildcard");
    return id;
  });
  if (new Set(result).size !== result.length) return invalid(path, "contains duplicates");
  return result;
}

function ttl(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 86_400) return invalid(path, "is outside its bound");
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
  if (root.default !== "deny") return invalid(`${path}.default`, "must be deny");
  if (typeof allow.all_internal_members !== "boolean") return invalid(`${path}.allow.all_internal_members`);
  const allInternalMembers = allow.all_internal_members;
  let internalMembership: AdmissionPolicy["internal_membership"];
  if (root.internal_membership !== undefined) {
    const membership = object(root.internal_membership, `${path}.internal_membership`, [
      "evidence_provider_ref", "positive_ttl_seconds", "negative_ttl_seconds",
    ]);
    const evidenceProviderRef = identifier(membership.evidence_provider_ref, `${path}.internal_membership.evidence_provider_ref`, 128);
    if (!Object.hasOwn(evidenceProviders, evidenceProviderRef)) return invalid(`${path}.internal_membership.evidence_provider_ref`, "is unknown");
    internalMembership = {
      evidence_provider_ref: evidenceProviderRef,
      positive_ttl_seconds: ttl(membership.positive_ttl_seconds, `${path}.internal_membership.positive_ttl_seconds`),
      negative_ttl_seconds: ttl(membership.negative_ttl_seconds, `${path}.internal_membership.negative_ttl_seconds`),
    };
  }
  const actorType = subjectType(binding.actor_type, `${path}.binding.actor_type`);
  if (allInternalMembers && internalMembership === undefined) return invalid(`${path}.internal_membership`, "is required for internal members");
  if (allInternalMembers && actorType !== "human") return invalid(`${path}.binding.actor_type`, "must be human for internal members");
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
      config: safeConfigurationValue(config, `${path}.evidence_providers.${providerRef}.config`) as Readonly<Record<string, unknown>>,
    }];
  }));
  const policies = namedRecord(root.policies, `${path}.policies`, 1_000);
  const normalizedPolicies = Object.fromEntries(Object.entries(policies).map(([policyId, candidate]) => {
    const policy = validatePolicy(candidate, `${path}.policies.${policyId}`, evidenceProviders);
    if (policy.policy_id !== policyId) return invalid(`${path}.policies.${policyId}.policy_id`, "must match its map key");
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
    if (!Object.hasOwn(this.section.policies, policyId)) return null;
    const policy = this.section.policies[policyId];
    return structuredClone(policy!);
  }
}
