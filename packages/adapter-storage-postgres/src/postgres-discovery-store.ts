import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type {
  PostgresClient,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import type { CapabilityManifest } from "@work-fabric/exchange-spi";
import {
  DISCOVERY_REQUIRED_STORE_CAPABILITIES,
  isDiscoveryTombstone,
  type DiscoveryApplyResult,
  type DiscoveryChangePage,
  type DiscoveryPage,
  type DiscoveryPeerBinding,
  type DiscoveryPeerBindingStore,
  type DiscoveryScope,
  type DiscoveryStore,
  type DiscoveryStoredValue,
  type DiscoveryStoreQuery,
  type DiscoveryStoreStatus,
} from "@work-fabric/discovery-spi";

export const DISCOVERY_MIGRATION = {
  id: "010_discovery",
  sql: readFileSync(new URL("../migrations/010_discovery.sql", import.meta.url), "utf8"),
} as const;

type SessionFactory = () => TenantSession | Promise<TenantSession>;

const storeManifest: CapabilityManifest = {
  profile: "workfabric.discovery-store.v1",
  adapter: "postgres",
  capabilities: {
    ...Object.fromEntries(DISCOVERY_REQUIRED_STORE_CAPABILITIES.map((item) => [item, true])),
    clustered_claims: true,
    row_level_security: true,
  },
};

const peerManifest: CapabilityManifest = {
  profile: "workfabric.discovery-peer-store.v1",
  adapter: "postgres",
  capabilities: {
    tenant_view_isolation: true,
    optimistic_peer_binding: true,
    deterministic_listing: true,
    clustered_claims: true,
    row_level_security: true,
  },
};

function clone<T>(value: T): T { return structuredClone(value); }
function json<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : clone(value as T);
}
function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}
function safeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${label} is invalid`);
  return result;
}
function cursorSignature(input: DiscoveryStoreQuery): unknown {
  const { cursor: _cursor, now: _now, limit: _limit, ...signature } = input;
  return signature;
}
function recordCursor(input: DiscoveryStoreQuery, origin: string, recordId: string): string {
  return Buffer.from(JSON.stringify({ signature: cursorSignature(input), origin, record_id: recordId })).toString("base64url");
}
function decodeRecordCursor(input: DiscoveryStoreQuery): { readonly origin: string; readonly record_id: string } | null {
  if (input.cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!isDeepStrictEqual(value.signature, cursorSignature(input)) || typeof value.origin !== "string" || typeof value.record_id !== "string") throw new Error();
    return { origin: value.origin, record_id: value.record_id };
  } catch { throw new TypeError("discovery_cursor_invalid"); }
}
function changeCursor(scope: DiscoveryScope, peerId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ ...scope, peer_id: peerId, sequence })).toString("base64url");
}
function decodeChangeCursor(scope: DiscoveryScope, peerId: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.tenant_id !== scope.tenant_id || value.tenant_view_id !== scope.tenant_view_id || value.peer_id !== peerId ||
        !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new Error();
    return value.sequence as number;
  } catch { throw new TypeError("discovery_cursor_invalid"); }
}
function matchesVersion(version: string, constraint: string | undefined): boolean {
  if (constraint === undefined || constraint === "") return true;
  if (constraint.startsWith(">=")) return version.localeCompare(constraint.slice(2)) >= 0;
  if (constraint.startsWith("^")) return version.split(".")[0] === constraint.slice(1).split(".")[0];
  return version === constraint;
}
function matches(value: DiscoveryStoredValue, query: DiscoveryStoreQuery): boolean {
  if (isDiscoveryTombstone(value)) return false;
  if (query.record_kinds !== undefined && !query.record_kinds.includes(value.record_kind)) return false;
  if (query.record_id !== undefined && query.record_id !== value.record_id) return false;
  if (query.origin_exchange_id !== undefined && query.origin_exchange_id !== value.origin_exchange_id) return false;
  if (query.exchange_id !== undefined && (value.record_kind !== "exchange" || value.payload.exchange_id !== query.exchange_id)) return false;
  if (query.actor_id !== undefined && (value.record_kind !== "participant" || value.payload.actor.actor_id !== query.actor_id)) return false;
  if (query.endpoint_id !== undefined && (value.record_kind !== "endpoint" || value.payload.endpoint_id !== query.endpoint_id)) return false;
  const capabilityFilter = query.capability_id !== undefined || query.version_constraint !== undefined ||
    query.input_media_types !== undefined || query.output_media_types !== undefined ||
    query.interaction_modes !== undefined || query.binding_types !== undefined;
  if (capabilityFilter) {
    if (value.record_kind !== "capability_route") return false;
    if (query.capability_id !== undefined && value.payload.capability_id !== query.capability_id) return false;
    if (!value.payload.versions.some((version) => matchesVersion(version, query.version_constraint))) return false;
    if (query.input_media_types?.some((item) => !value.payload.input_media_types.includes(item))) return false;
    if (query.output_media_types?.some((item) => !value.payload.output_media_types.includes(item))) return false;
    if (query.interaction_modes?.some((item) => !value.payload.interaction_modes.includes(item as never))) return false;
    if (query.binding_types?.some((item) => !value.payload.binding_types.includes(item))) return false;
  }
  return true;
}

export interface PostgresDiscoveryStoreOptions {
  readonly max_records_per_origin: number;
  readonly max_query_scan_results?: number;
}

abstract class ScopedPostgres {
  constructor(
    protected readonly sessions: SessionFactory,
    protected readonly tenantId: string,
    protected readonly tenantViewId: string,
  ) {
    identity(tenantId, "tenant_id");
    identity(tenantViewId, "tenant_view_id");
  }
  protected bind(scope: DiscoveryScope): void {
    if (scope.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    if (scope.tenant_view_id !== this.tenantViewId) throw new Error("tenant view context mismatch");
  }
  protected async run<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    const session = await this.sessions();
    if (session.tenant_id !== this.tenantId) throw new Error("tenant session mismatch");
    return session.withTransaction(operation);
  }
}

export class PostgresDiscoveryStore extends ScopedPostgres implements DiscoveryStore {
  readonly manifest = clone(storeManifest);
  private readonly maxScan: number;
  private conflicts = 0;

  constructor(sessions: SessionFactory, tenantId: string, tenantViewId: string, private readonly options: PostgresDiscoveryStoreOptions) {
    super(sessions, tenantId, tenantViewId);
    if (!Number.isSafeInteger(options.max_records_per_origin) || options.max_records_per_origin < 1) throw new RangeError("max_records_per_origin is invalid");
    this.maxScan = options.max_query_scan_results ?? 10_000;
    if (!Number.isSafeInteger(this.maxScan) || this.maxScan < 1 || this.maxScan > 100_000) throw new RangeError("max_query_scan_results is invalid");
  }

  async apply(input: DiscoveryScope & { readonly source_peer_id: string | null; readonly value: DiscoveryStoredValue }): Promise<DiscoveryApplyResult> {
    this.bind(input);
    const value = clone(input.value);
    return this.run(async (client) => {
      const existing = await client.query<{ payload: unknown; change_sequence?: string | number }>(
        "SELECT payload FROM work_fabric_discovery_records WHERE tenant_id=$1 AND tenant_view_id=$2 AND origin_exchange_id=$3 AND record_id=$4 FOR UPDATE",
        [this.tenantId, this.tenantViewId, value.origin_exchange_id, value.record_id],
      );
      const current = existing.rows[0] === undefined ? null : json<DiscoveryStoredValue>(existing.rows[0].payload);
      if (current !== null) {
        if (value.revision < current.revision) return { outcome: "stale", sequence: 0 };
        if (value.revision === current.revision) {
          if (!isDeepStrictEqual(value, current)) { this.conflicts += 1; throw new Error("discovery_record_conflict"); }
          return { outcome: "duplicate", sequence: 0 };
        }
      }
      await client.query(
        `INSERT INTO work_fabric_discovery_records
          (tenant_id,tenant_view_id,origin_exchange_id,record_id,revision,is_tombstone,expires_at,retain_until,source_peer_id,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (tenant_id,tenant_view_id,origin_exchange_id,record_id) DO UPDATE SET
          revision=EXCLUDED.revision,is_tombstone=EXCLUDED.is_tombstone,expires_at=EXCLUDED.expires_at,
          retain_until=EXCLUDED.retain_until,source_peer_id=EXCLUDED.source_peer_id,payload=EXCLUDED.payload,updated_at=clock_timestamp()`,
        [this.tenantId, this.tenantViewId, value.origin_exchange_id, value.record_id, value.revision,
          isDiscoveryTombstone(value), isDiscoveryTombstone(value) ? null : value.expires_at,
          isDiscoveryTombstone(value) ? value.retain_until : null, input.source_peer_id, JSON.stringify(value)],
      );
      const changed = await client.query<{ change_sequence: string | number }>(
        `INSERT INTO work_fabric_discovery_changes
          (tenant_id,tenant_view_id,origin_exchange_id,record_id,revision,payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING change_sequence`,
        [this.tenantId, this.tenantViewId, value.origin_exchange_id, value.record_id, value.revision, JSON.stringify(value)],
      );
      const sequence = safeInteger(changed.rows[0]?.change_sequence, "change_sequence");
      await client.query(
        `DELETE FROM work_fabric_discovery_records WHERE (tenant_id,tenant_view_id,origin_exchange_id,record_id) IN (
           SELECT tenant_id,tenant_view_id,origin_exchange_id,record_id FROM work_fabric_discovery_records
           WHERE tenant_id=$1 AND tenant_view_id=$2 AND origin_exchange_id=$3
           ORDER BY updated_at DESC,record_id DESC OFFSET $4
         )`,
        [this.tenantId, this.tenantViewId, value.origin_exchange_id, this.options.max_records_per_origin],
      );
      return { outcome: "applied", sequence };
    });
  }

  async get(input: DiscoveryScope & { readonly origin_exchange_id: string; readonly record_id: string; readonly now: string }) {
    this.bind(input);
    return this.run(async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_discovery_records WHERE tenant_id=$1 AND tenant_view_id=$2 AND origin_exchange_id=$3 AND record_id=$4 AND is_tombstone=false AND expires_at>$5",
        [this.tenantId, this.tenantViewId, input.origin_exchange_id, input.record_id, input.now],
      );
      return result.rows[0] === undefined ? null : json<Exclude<DiscoveryStoredValue, { readonly withdrawn_at: string }>>(result.rows[0].payload);
    });
  }

  async query(input: DiscoveryStoreQuery): Promise<DiscoveryPage> {
    this.bind(input);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("limit is invalid");
    const after = decodeRecordCursor(input);
    return this.run(async (client) => {
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_discovery_records
         WHERE tenant_id=$1 AND tenant_view_id=$2 AND is_tombstone=false AND expires_at>$3
           AND (origin_exchange_id,record_id)>($4,$5)
         ORDER BY origin_exchange_id,record_id LIMIT $6`,
        [this.tenantId, this.tenantViewId, input.now, after?.origin ?? "", after?.record_id ?? "", this.maxScan + 1],
      );
      const scanned = result.rows.slice(0, this.maxScan).map((row) => json<DiscoveryStoredValue>(row.payload));
      const filtered = scanned.filter((value) => matches(value, input));
      const page = filtered.slice(0, input.limit) as Exclude<DiscoveryStoredValue, { readonly withdrawn_at: string }>[];
      const more = filtered.length > page.length || result.rows.length > this.maxScan;
      return {
        coverage: result.rows.length > this.maxScan ? "partial" : "complete",
        items: page,
        warnings: result.rows.length > this.maxScan ? ["discovery_scan_limit_reached"] : [],
        ...(more && page.length > 0 ? { next_cursor: recordCursor(input, page.at(-1)!.origin_exchange_id, page.at(-1)!.record_id) } : {}),
      };
    });
  }

  async changes(input: DiscoveryScope & { readonly peer_id: string; readonly cursor?: string; readonly limit: number }): Promise<DiscoveryChangePage> {
    this.bind(input);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("limit is invalid");
    const after = decodeChangeCursor(input, input.peer_id, input.cursor);
    return this.run(async (client) => {
      const result = await client.query<{ change_sequence: string | number; payload: unknown }>(
        `SELECT change_sequence,payload FROM work_fabric_discovery_changes
         WHERE tenant_id=$1 AND tenant_view_id=$2 AND change_sequence>$3
         ORDER BY change_sequence LIMIT $4`,
        [this.tenantId, this.tenantViewId, after, input.limit],
      );
      const sequence = result.rows.length === 0 ? after : safeInteger(result.rows.at(-1)!.change_sequence, "change_sequence");
      const maximum = await client.query<{ maximum: string | number }>(
        "SELECT COALESCE(MAX(change_sequence),0) AS maximum FROM work_fabric_discovery_changes WHERE tenant_id=$1 AND tenant_view_id=$2",
        [this.tenantId, this.tenantViewId],
      );
      return {
        items: result.rows.map((row) => json<DiscoveryStoredValue>(row.payload)),
        etag: `W/\"${safeInteger(maximum.rows[0]?.maximum ?? 0, "maximum") }\"`,
        ...(result.rows.length > 0 ? { next_cursor: changeCursor(input, input.peer_id, sequence) } : {}),
      };
    });
  }

  async prune(input: DiscoveryScope & { readonly now: string }): Promise<number> {
    this.bind(input);
    return this.run(async (client) => {
      const result = await client.query(
        `DELETE FROM work_fabric_discovery_records WHERE tenant_id=$1 AND tenant_view_id=$2
         AND ((is_tombstone AND retain_until<=$3) OR (NOT is_tombstone AND expires_at<=$3))`,
        [this.tenantId, this.tenantViewId, input.now],
      );
      return result.rowCount;
    });
  }

  async status(input: DiscoveryScope & { readonly now: string }): Promise<DiscoveryStoreStatus> {
    this.bind(input);
    return this.run(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT COUNT(*) FILTER (WHERE NOT is_tombstone AND expires_at>$3) AS live,
          COUNT(*) FILTER (WHERE NOT is_tombstone AND expires_at<=$3) AS expired,
          COUNT(*) FILTER (WHERE is_tombstone) AS withdrawn
         FROM work_fabric_discovery_records WHERE tenant_id=$1 AND tenant_view_id=$2`,
        [this.tenantId, this.tenantViewId, input.now],
      );
      const row = result.rows[0] ?? {};
      return {
        live: safeInteger(row.live ?? 0, "live"), expired: safeInteger(row.expired ?? 0, "expired"),
        withdrawn: safeInteger(row.withdrawn ?? 0, "withdrawn"), conflicts: this.conflicts,
        capacity: this.options.max_records_per_origin,
      };
    });
  }
}

export class PostgresDiscoveryPeerBindingStore extends ScopedPostgres implements DiscoveryPeerBindingStore {
  readonly manifest = clone(peerManifest);

  async put(input: { readonly binding: DiscoveryPeerBinding; readonly expected_version: number | null }): Promise<DiscoveryPeerBinding> {
    this.bind(input.binding);
    const candidate = clone(input.binding);
    return this.run(async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_discovery_peers WHERE tenant_id=$1 AND tenant_view_id=$2 AND peer_id=$3 FOR UPDATE",
        [this.tenantId, this.tenantViewId, candidate.peer_id],
      );
      const current = result.rows[0] === undefined ? null : json<DiscoveryPeerBinding>(result.rows[0].payload);
      if (current === null) {
        if (input.expected_version !== null || candidate.version !== 1) throw new Error("discovery_peer_version_conflict");
      } else {
        if (isDeepStrictEqual(current, candidate)) return current;
        if (current.exchange_id !== candidate.exchange_id) throw new Error("discovery_peer_immutable_binding");
        if (input.expected_version !== current.version || candidate.version !== current.version + 1) throw new Error("discovery_peer_version_conflict");
      }
      const written = await client.query(
        `INSERT INTO work_fabric_discovery_peers (tenant_id,tenant_view_id,peer_id,exchange_id,version,payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (tenant_id,tenant_view_id,peer_id) DO UPDATE SET version=EXCLUDED.version,payload=EXCLUDED.payload
         WHERE work_fabric_discovery_peers.version=$7`,
        [this.tenantId, this.tenantViewId, candidate.peer_id, candidate.exchange_id, candidate.version, JSON.stringify(candidate), input.expected_version],
      );
      if (written.rowCount !== 1) throw new Error("discovery_peer_version_conflict");
      return candidate;
    });
  }

  async get(scope: DiscoveryScope, peerId: string): Promise<DiscoveryPeerBinding | null> {
    this.bind(scope);
    return this.run(async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_discovery_peers WHERE tenant_id=$1 AND tenant_view_id=$2 AND peer_id=$3",
        [this.tenantId, this.tenantViewId, peerId],
      );
      return result.rows[0] === undefined ? null : json<DiscoveryPeerBinding>(result.rows[0].payload);
    });
  }

  async list(scope: DiscoveryScope): Promise<readonly DiscoveryPeerBinding[]> {
    this.bind(scope);
    return this.run(async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_discovery_peers WHERE tenant_id=$1 AND tenant_view_id=$2 ORDER BY peer_id",
        [this.tenantId, this.tenantViewId],
      );
      return result.rows.map((row) => json<DiscoveryPeerBinding>(row.payload));
    });
  }
}
