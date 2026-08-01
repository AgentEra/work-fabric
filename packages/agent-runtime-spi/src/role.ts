export interface AgentRoleProfile {
  readonly role_id: string;
  readonly version: number;
  readonly display_name: string;
  readonly description: string;
  readonly capability_ids: readonly string[];
}

const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function requireId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (id.trim() !== id || id.length === 0 || id.length > 128) {
    throw new TypeError(`${field} must be a trimmed identifier no longer than 128 characters`);
  }
  return id;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function defineAgentRoleProfile(value: unknown): Readonly<AgentRoleProfile> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Agent role profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  const keys = ["role_id", "version", "display_name", "description", "capability_ids"];
  if (Object.keys(profile).length !== keys.length || Object.keys(profile).some((key) => !keys.includes(key))) {
    throw new TypeError("Agent role profile contains unsupported or missing fields");
  }
  const version = profile.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError("version must be a positive safe integer");
  }
  if (!Array.isArray(profile.capability_ids) || profile.capability_ids.length === 0) {
    throw new TypeError("capability_ids must be a non-empty array");
  }
  const capability_ids = profile.capability_ids.map((value) => requireId(value, "capability_id"));
  if (capability_ids.some((id) => !CAPABILITY_ID.test(id))) {
    throw new TypeError("capability_ids must use dotted lowercase identifiers");
  }
  if (new Set(capability_ids).size !== capability_ids.length) {
    throw new TypeError("capability_ids contains duplicate values");
  }
  return deepFreeze({
    role_id: requireId(profile.role_id, "role_id"),
    version,
    display_name: requireString(profile.display_name, "display_name"),
    description: requireString(profile.description, "description"),
    capability_ids,
  });
}
