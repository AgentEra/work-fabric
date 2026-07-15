import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";

import type {
  CapabilityManifest,
  ContextAccessRequest,
  ContextAvailability,
  ContextReference,
  ContextRepository,
  JsonObject,
  JsonValue,
} from "@work-fabric/exchange-spi";
import type { PostgresClient, TenantSession } from "@work-fabric/adapter-postgres-common";

const manifest: CapabilityManifest = {
  profile: "exchange.context.v1",
  adapter: "postgres",
  capabilities: {
    immutable_versions: true,
    digest_verification: true,
    visibility_enforcement: true,
  },
};

function clone<T>(value: T): T { return structuredClone(value); }
function id(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new TypeError(`${label} must be a non-empty opaque ID`); }
function object(value: JsonValue | undefined, label: string): JsonObject { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value as JsonObject; }
function version(value: JsonValue | undefined): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new RangeError("version must be a positive safe integer"); return value; }
function digest(value: JsonValue | undefined): string | null { if (value === null) return null; const candidate = object(value, "digest"); if (Object.keys(candidate).length !== 2 || typeof candidate.algorithm !== "string" || typeof candidate.value !== "string" || !["sha-256", "sha-384", "sha-512"].includes(candidate.algorithm) || candidate.value.length === 0) throw new TypeError("digest must contain a supported algorithm and value"); return `${candidate.algorithm}:${candidate.value}`; }
function strings(value: JsonValue | undefined, label: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) throw new TypeError(`${label} must be a unique string array`); return value as string[]; }
function reference(bundle: JsonObject): { reference: ContextReference; actorIds: readonly string[]; endpointIds: readonly string[] } {
  const contextId = bundle.context_id; id(contextId, "context_id"); const bundleVersion = version(bundle.version); const bundleDigest = digest(bundle.digest); const visibility = object(bundle.visibility_scope, "visibility_scope");
  return { reference: { context_id: contextId, version: bundleVersion, digest: bundleDigest }, actorIds: strings(visibility.actor_ids, "visibility_scope.actor_ids"), endpointIds: strings(visibility.endpoint_ids, "visibility_scope.endpoint_ids") };
}
function rowJson<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : clone(value as T); }

export const CONTEXT_MIGRATION = { id: "004_context", sql: readFileSync(new URL("../migrations/004_context.sql", import.meta.url), "utf8") } as const;

export class PostgresContextRepository implements ContextRepository {
  readonly manifest = clone(manifest);
  constructor(private readonly sessionFactory: (tenantId: string) => TenantSession) {}
  private run<T>(tenantId: string, operation: (client: PostgresClient) => Promise<T>): Promise<T> { id(tenantId, "tenant_id"); return this.sessionFactory(tenantId).withTransaction(operation); }

  async putBundle(tenantId: string, bundle: JsonObject): Promise<ContextReference> {
    id(tenantId, "tenant_id"); const candidate = clone(bundle); const parsed = reference(candidate);
    return this.run(tenantId, async (client) => {
      const existing = await client.query<Record<string, unknown>>("SELECT bundle,digest FROM work_fabric_context_bundles WHERE tenant_id=$1 AND context_id=$2 AND version=$3 FOR UPDATE", [tenantId, parsed.reference.context_id, parsed.reference.version]);
      if (existing.rows[0] !== undefined) {
        const stored = rowJson<JsonObject>(existing.rows[0].bundle);
        if (!isDeepStrictEqual(stored, candidate)) throw new Error(`Context ${parsed.reference.context_id} version ${parsed.reference.version} is immutable and has a different body`);
        return clone(parsed.reference);
      }
      await client.query("INSERT INTO work_fabric_context_bundles (tenant_id,context_id,version,digest,bundle,actor_ids,endpoint_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)", [tenantId, parsed.reference.context_id, parsed.reference.version, parsed.reference.digest, JSON.stringify(candidate), JSON.stringify(parsed.actorIds), JSON.stringify(parsed.endpointIds)]);
      return clone(parsed.reference);
    });
  }

  async checkAvailability(request: ContextAccessRequest): Promise<ContextAvailability> {
    const candidate = clone(request); id(candidate.tenant_id, "tenant_id"); id(candidate.actor_id, "actor_id"); id(candidate.endpoint_id, "endpoint_id"); if (candidate.reference === null) return { kind: "available" }; id(candidate.reference.context_id, "context_id"); version(candidate.reference.version);
    return this.run(candidate.tenant_id, async (client) => {
      const result = await client.query<Record<string, unknown>>("SELECT digest,actor_ids,endpoint_ids FROM work_fabric_context_bundles WHERE tenant_id=$1 AND context_id=$2 AND version=$3", [candidate.tenant_id, candidate.reference?.context_id, candidate.reference?.version]);
      const row = result.rows[0]; if (row === undefined) return { kind: "unavailable", reason: "Context version was not found" };
      const storedDigest = row.digest === null ? null : String(row.digest); if (candidate.reference?.digest !== null && candidate.reference?.digest !== storedDigest) return { kind: "unavailable", reason: "Context digest does not match" };
      const actorIds = rowJson<readonly string[]>(row.actor_ids); const endpointIds = rowJson<readonly string[]>(row.endpoint_ids); if (actorIds.length === 0 && endpointIds.length === 0) return { kind: "unavailable", reason: "Context declares no audience" }; if (actorIds.length > 0 && !actorIds.includes(candidate.actor_id)) return { kind: "unavailable", reason: "Actor is outside the Context audience" }; if (endpointIds.length > 0 && !endpointIds.includes(candidate.endpoint_id)) return { kind: "unavailable", reason: "Endpoint is outside the Context audience" }; return { kind: "available" };
    });
  }
}
