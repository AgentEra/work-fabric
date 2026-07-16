import type {
  LocalAuthorityAllowRule,
  LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";
import {
  validateClusterLimits,
  type ClusterHostLimits,
} from "@work-fabric/cluster-spi";

export type ServiceStorageProfile = "memory-demo" | "sqlite-local" | "postgres";
export type ServiceRole = "all" | "api" | "worker";

export interface ClusterHostConfig extends ClusterHostLimits {
  readonly worker_owner_id: string;
  readonly tenant_ids: readonly string[];
}

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
  readonly cluster?: ClusterHostConfig;
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

function port(value: unknown): number {
  const normalized = value ?? 8787;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0 || (normalized as number) > 65_535) {
    throw new RangeError("listen.port is outside its bound");
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
  if (!["all", "api", "worker"].includes(role)) {
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
    port: port(listenRaw.port),
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
  let cluster: ClusterHostConfig | undefined;
  if (raw.cluster !== undefined) {
    if (role === "api") throw new TypeError("cluster is only valid for worker or all roles");
    if (storageProfile === "sqlite-local") {
      throw new TypeError("SQLite is single-process and cannot use clustered ownership");
    }
    const value = object(raw.cluster, "cluster");
    const limits = validateClusterLimits({
      max_concurrent_turns: value.max_concurrent_turns as number,
      max_ready_items: value.max_ready_items as number,
      catalog_page_size: value.catalog_page_size as number,
      turn_item_limit: value.turn_item_limit as number,
      lease_seconds: value.lease_seconds as number,
      drain_timeout_seconds: value.drain_timeout_seconds as number,
      poll_interval_ms: value.poll_interval_ms as number,
      max_tenants_per_host: value.max_tenants_per_host as number,
    });
    const tenantInput = value.tenant_ids ?? [tenantId];
    if (!Array.isArray(tenantInput) || tenantInput.length === 0) {
      throw new TypeError("cluster.tenant_ids must be non-empty");
    }
    const tenantIds = tenantInput.map((value) => identifier(value, "cluster.tenant_id"));
    if (
      new Set(tenantIds).size !== tenantIds.length ||
      tenantIds.length > limits.max_tenants_per_host
    ) throw new RangeError("cluster.tenant_ids exceeds its bound or contains duplicates");
    cluster = {
      worker_owner_id: identifier(value.worker_owner_id, "cluster.worker_owner_id"),
      tenant_ids: tenantIds,
      ...limits,
    };
  }
  if (role === "worker" && cluster === undefined) {
    throw new TypeError("worker role requires cluster configuration");
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
    ...(cluster === undefined ? {} : { cluster }),
  };
}
