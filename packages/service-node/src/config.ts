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

export interface NodeAdmissionConfig {
  readonly subject_fingerprint_key: string;
  readonly grant_active_key_id: string;
  readonly grant_keys: Readonly<Record<string, string>>;
  readonly grant_ttl_seconds: number;
  readonly max_evidence_cache_entries: number;
}

export class NodeConfigurationError extends TypeError {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
  }
}

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
  readonly admission?: NodeAdmissionConfig;
  readonly listen: { readonly host: string; readonly port: number };
  readonly identities: readonly LocalIdentityRecord[];
  readonly authority_rules: readonly LocalAuthorityAllowRule[];
  readonly sqlite?: { readonly location: string; readonly busy_timeout_ms: number };
  readonly postgres?: { readonly connection_string: string };
  readonly cluster?: ClusterHostConfig;
}

const ADMISSION_KEYS = [
  "subject_fingerprint_key",
  "grant_active_key_id",
  "grant_keys",
  "grant_ttl_seconds",
  "max_evidence_cache_entries",
] as const;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function admissionError(path: string): never {
  throw new NodeConfigurationError("service_admission_invalid", path);
}

function ownData(value: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return admissionError(path);
  }
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
    return admissionError(path);
  }
  return descriptor.value;
}

function exactAdmissionObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return admissionError(path);
  }
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    return admissionError(path);
  }
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return admissionError(path);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) result[key] = ownData(value, key, `${path}.${key}`);
  return result;
}

function admissionGrantKeyId(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^[A-Za-z0-9_-]+$/.test(value)
    || PROTOTYPE_KEYS.has(value)
  ) return admissionError(path);
  return value;
}

function admissionSecret(value: unknown, path: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength < 32) {
    return admissionError(path);
  }
  return value;
}

function parseAdmissionConfig(value: unknown): NodeAdmissionConfig {
  const path = "service.admission";
  const raw = exactAdmissionObject(value, path, ADMISSION_KEYS);
  const fingerprintKey = admissionSecret(raw.subject_fingerprint_key, `${path}.subject_fingerprint_key`);
  const activeKeyId = admissionGrantKeyId(raw.grant_active_key_id, `${path}.grant_active_key_id`);
  const rawKeys = raw.grant_keys;
  if (typeof rawKeys !== "object" || rawKeys === null || Array.isArray(rawKeys)) {
    return admissionError(`${path}.grant_keys`);
  }
  let keyIds: readonly PropertyKey[];
  try {
    keyIds = Reflect.ownKeys(rawKeys);
  } catch {
    return admissionError(`${path}.grant_keys`);
  }
  if (
    keyIds.length === 0
    || keyIds.length > 100
    || keyIds.some((key) => typeof key !== "string" || PROTOTYPE_KEYS.has(key))
  ) return admissionError(`${path}.grant_keys`);
  const grantKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const keyId of keyIds as readonly string[]) {
    const normalizedId = admissionGrantKeyId(keyId, `${path}.grant_keys`);
    grantKeys[normalizedId] = admissionSecret(
      ownData(rawKeys, keyId, `${path}.grant_keys.${keyId}`),
      `${path}.grant_keys.${keyId}`,
    );
  }
  if (!Object.hasOwn(grantKeys, activeKeyId)) return admissionError(`${path}.grant_active_key_id`);
  const ttl = raw.grant_ttl_seconds;
  if (!Number.isSafeInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 300) {
    return admissionError(`${path}.grant_ttl_seconds`);
  }
  const cache = raw.max_evidence_cache_entries;
  if (!Number.isSafeInteger(cache) || (cache as number) < 1 || (cache as number) > 100_000) {
    return admissionError(`${path}.max_evidence_cache_entries`);
  }
  return Object.freeze({
    subject_fingerprint_key: fingerprintKey,
    grant_active_key_id: activeKeyId,
    grant_keys: Object.freeze(grantKeys),
    grant_ttl_seconds: ttl as number,
    max_evidence_cache_entries: cache as number,
  });
}

export function serviceAdmissionSecretPaths(service: unknown): readonly string[] {
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    return admissionError("service");
  }
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(service, "admission"); } catch {
    return admissionError("service.admission");
  }
  if (descriptor === undefined) {
    try {
      if (Reflect.has(service, "admission")) return admissionError("service.admission");
    } catch {
      return admissionError("service.admission");
    }
    return [];
  }
  if (!("value" in descriptor) || descriptor.value === undefined) {
    return admissionError("service.admission");
  }
  const raw = exactAdmissionObject(descriptor.value, "service.admission", ADMISSION_KEYS);
  admissionGrantKeyId(raw.grant_active_key_id, "service.admission.grant_active_key_id");
  const keys = raw.grant_keys;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    return admissionError("service.admission.grant_keys");
  }
  let keyIds: readonly PropertyKey[];
  try { keyIds = Reflect.ownKeys(keys); } catch {
    return admissionError("service.admission.grant_keys");
  }
  if (keyIds.length === 0 || keyIds.length > 100 || keyIds.some((key) => typeof key !== "string")) {
    return admissionError("service.admission.grant_keys");
  }
  const safeKeyIds = (keyIds as readonly string[]).map((keyId) => {
    admissionGrantKeyId(keyId, "service.admission.grant_keys");
    ownData(keys, keyId, `service.admission.grant_keys.${keyId}`);
    return keyId;
  });
  return [
    "service.admission.subject_fingerprint_key",
    ...safeKeyIds.map((keyId) => `service.admission.grant_keys.${keyId}`),
  ];
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
  let admission: NodeAdmissionConfig | undefined;
  let admissionDescriptor: PropertyDescriptor | undefined;
  try {
    admissionDescriptor = Object.getOwnPropertyDescriptor(raw, "admission");
  } catch {
    return admissionError("service.admission");
  }
  if (admissionDescriptor === undefined) {
    try {
      if (Reflect.has(raw, "admission")) return admissionError("service.admission");
    } catch {
      return admissionError("service.admission");
    }
  } else {
    if (!("value" in admissionDescriptor) || admissionDescriptor.value === undefined) {
      return admissionError("service.admission");
    }
    admission = parseAdmissionConfig(admissionDescriptor.value);
  }
  return {
    storage_profile: storageProfile,
    role,
    development_mode: developmentMode,
    tenant_id: tenantId,
    exchange_id: exchangeId,
    cursor_secret: cursorSecret,
    ...(admission === undefined ? {} : { admission }),
    listen,
    identities,
    authority_rules: authorityRules,
    ...(sqlite === undefined ? {} : { sqlite }),
    ...(postgres === undefined ? {} : { postgres }),
    ...(cluster === undefined ? {} : { cluster }),
  };
}
