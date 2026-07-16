import type {
  LocalAuthorityAllowRule,
  LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";

export type ServiceStorageProfile = "memory-demo" | "sqlite-local" | "postgres";
export type ServiceRole = "all" | "api" | "projector" | "delivery" | "connector";

export interface NodeServiceConfig {
  readonly storage_profile: ServiceStorageProfile;
  readonly role: ServiceRole;
  readonly development_mode: boolean;
  readonly tenant_id: string;
  readonly exchange_id: string;
  readonly cursor_secret: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly identities: readonly LocalIdentityRecord[];
  readonly authority_rules: readonly LocalAuthorityAllowRule[];
  readonly sqlite?: { readonly location: string; readonly busy_timeout_ms: number };
  readonly postgres?: { readonly connection_string: string };
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.trim() !== value ||
    value.length === 0 || value.length > 128
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, field: string, maximum: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || (normalized as number) <= 0 || (normalized as number) > maximum) {
    throw new RangeError(`${field} is outside its bound`);
  }
  return normalized as number;
}

export function parseServiceConfig(input: unknown): NodeServiceConfig {
  const raw = object(input, "service config");
  if (!["memory-demo", "sqlite-local", "postgres"].includes(String(raw.storage_profile))) {
    throw new TypeError("storage_profile is invalid");
  }
  const storageProfile = raw.storage_profile as ServiceStorageProfile;
  const role = (raw.role ?? "all") as ServiceRole;
  if (!["all", "api", "projector", "delivery", "connector"].includes(role)) {
    throw new TypeError("role is invalid");
  }
  const tenantId = identifier(raw.tenant_id, "tenant_id");
  const exchangeId = identifier(raw.exchange_id, "exchange_id");
  const cursorSecret = identifier(raw.cursor_secret, "cursor_secret");
  if (cursorSecret.length < 32) throw new TypeError("cursor_secret must contain at least 32 characters");
  if (!Array.isArray(raw.identities) || raw.identities.length === 0) {
    throw new TypeError("at least one explicit identity is required");
  }
  if (!Array.isArray(raw.authority_rules) || raw.authority_rules.length === 0) {
    throw new TypeError("at least one explicit authority rule is required");
  }
  const identities = structuredClone(raw.identities) as unknown as LocalIdentityRecord[];
  const authorityRules = structuredClone(raw.authority_rules) as unknown as LocalAuthorityAllowRule[];
  if (identities.some((record) => record.principal?.tenant_id !== tenantId)) {
    throw new TypeError("identity tenant must match service tenant");
  }
  if (authorityRules.some((rule) => rule.tenant_id !== tenantId)) {
    throw new TypeError("authority tenant must match service tenant");
  }
  const developmentMode = raw.development_mode === true;
  if (storageProfile === "memory-demo" && !developmentMode) {
    throw new TypeError("memory-demo requires explicit development_mode");
  }
  const listenRaw = raw.listen === undefined ? {} : object(raw.listen, "listen");
  const listen = {
    host: listenRaw.host === undefined ? "127.0.0.1" : identifier(listenRaw.host, "listen.host"),
    port: integer(listenRaw.port, 8787, "listen.port", 65_535),
  };
  let sqlite: NodeServiceConfig["sqlite"];
  if (storageProfile === "sqlite-local") {
    const value = object(raw.sqlite, "sqlite");
    sqlite = {
      location: identifier(value.location, "sqlite.location"),
      busy_timeout_ms: integer(value.busy_timeout_ms, 5_000, "sqlite.busy_timeout_ms", 60_000),
    };
  }
  let postgres: NodeServiceConfig["postgres"];
  if (storageProfile === "postgres") {
    if (raw.postgres === undefined) {
      throw new TypeError("postgres.connection_string is required");
    }
    const value = object(raw.postgres, "postgres");
    if (typeof value.connection_string !== "string" || value.connection_string.trim() === "") {
      throw new TypeError("postgres.connection_string is required");
    }
    postgres = { connection_string: value.connection_string };
  }
  return {
    storage_profile: storageProfile,
    role,
    development_mode: developmentMode,
    tenant_id: tenantId,
    exchange_id: exchangeId,
    cursor_secret: cursorSecret,
    listen,
    identities,
    authority_rules: authorityRules,
    ...(sqlite === undefined ? {} : { sqlite }),
    ...(postgres === undefined ? {} : { postgres }),
  };
}
