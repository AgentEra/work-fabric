import type { NamedConfigurationSectionValidator } from "@work-fabric/configuration-runtime";

export interface AgentRuntimeAuthorityGrant {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly subscription_id: string;
}

export interface AgentRuntimeAuthorityConfigurationSection {
  readonly grants: Readonly<Record<string, AgentRuntimeAuthorityGrant>>;
}

export class AgentRuntimeAuthorityConfigurationError extends TypeError {
  constructor(readonly path: string, reason = "is invalid") {
    super(`${path} ${reason}`);
  }
}

function invalid(path: string, reason?: string): never {
  throw new AgentRuntimeAuthorityConfigurationError(path, reason);
}

function ownKeys(value: object, path: string): readonly PropertyKey[] {
  try { return Reflect.ownKeys(value); } catch { return invalid(path); }
}

function ownData(value: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return invalid(path); }
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) return invalid(path);
  return descriptor.value;
}

function record(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "must be an object");
  const keys = ownKeys(value, path);
  if (keys.some((key) => typeof key !== "string" || !fields.includes(key))) return invalid(path, "contains unknown keys");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) result[field] = ownData(value, field, `${path}.${field}`);
  return result;
}

function namedRecord(value: unknown, path: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "must be an object");
  const keys = ownKeys(value, path);
  if (keys.length > maximum || keys.some((key) => typeof key !== "string")) return invalid(path, "exceeds its bound or contains symbol keys");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) result[key] = ownData(value, key, `${path}.${key}`);
  return result;
}

function identifier(value: unknown, path: string, maximum = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) return invalid(path);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateAgentRuntimeAuthorityConfiguration(
  value: unknown,
  path: string,
): AgentRuntimeAuthorityConfigurationSection {
  const root = record(value, path, ["grants"]);
  const grants = namedRecord(root.grants, `${path}.grants`, 1_000);
  const normalized: Record<string, AgentRuntimeAuthorityGrant> = Object.create(null) as Record<string, AgentRuntimeAuthorityGrant>;
  for (const grantName of Object.keys(grants)) {
    identifier(grantName, `${path}.grants key`, 128);
    const grant = record(grants[grantName], `${path}.grants.${grantName}`, [
      "tenant_id", "principal_id", "actor_id", "endpoint_id", "subscription_id",
    ]);
    normalized[grantName] = {
      tenant_id: identifier(grant.tenant_id, `${path}.grants.${grantName}.tenant_id`),
      principal_id: identifier(grant.principal_id, `${path}.grants.${grantName}.principal_id`),
      actor_id: identifier(grant.actor_id, `${path}.grants.${grantName}.actor_id`),
      endpoint_id: identifier(grant.endpoint_id, `${path}.grants.${grantName}.endpoint_id`),
      subscription_id: identifier(grant.subscription_id, `${path}.grants.${grantName}.subscription_id`),
    };
  }
  const values = Object.values(normalized);
  if (values.some((candidate, index) => values.slice(0, index).some((other) =>
    other.tenant_id === candidate.tenant_id
    && other.principal_id === candidate.principal_id
    && other.actor_id === candidate.actor_id
    && other.endpoint_id === candidate.endpoint_id,
  ))) return invalid(`${path}.grants`, "contains duplicate runtime identities");
  return deepFreeze({ grants: normalized });
}

export const agentRuntimeAuthorityConfigurationValidator: NamedConfigurationSectionValidator<AgentRuntimeAuthorityConfigurationSection> = {
  section: "agent_runtime_authority",
  type: "workfabric.agent-runtime-authority.configuration.v1",
  validate(value, path) { return validateAgentRuntimeAuthorityConfiguration(value, path); },
};
