import { isDeepStrictEqual } from "node:util";

import type {
  PostgresClient,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import {
  ENDPOINT_INBOX_REQUIRED_CAPABILITIES,
  type CapabilityManifest,
  type EndpointClaimableHandoffPage,
  type EndpointClaimableHandoffQuery,
  type EndpointInboxPartitionPage,
  type EndpointInboxPartitionQuery,
  type EndpointInboxRoutingFact,
  type EndpointInboxStore,
  type EndpointExpiredClaimPage,
  type EndpointExpiredClaimQuery,
} from "@work-fabric/exchange-spi";
import { parseUtcTimestamp } from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.endpoint-inbox.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    ENDPOINT_INBOX_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json<T>(value: unknown): T {
  return typeof value === "string"
    ? (JSON.parse(value) as T)
    : clone(value as T);
}

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} is invalid`);
  }
}

function encodeCursor(
  query: EndpointInboxPartitionQuery,
  partitionId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tenant_id: query.tenant_id,
      actor_id: query.actor_id,
      endpoint_id: query.endpoint_id,
      partition_id: partitionId,
    }),
  ).toString("base64url");
}

function decodeCursor(query: EndpointInboxPartitionQuery): string | null {
  if (query.cursor === undefined) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.tenant_id !== query.tenant_id ||
      decoded.actor_id !== query.actor_id ||
      decoded.endpoint_id !== query.endpoint_id ||
      typeof decoded.partition_id !== "string"
    ) {
      throw new Error("cursor audience mismatch");
    }
    return decoded.partition_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function normalizedCapabilities(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function encodeClaimableCursor(
  query: EndpointClaimableHandoffQuery,
  handoffId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tenant_id: query.tenant_id,
      endpoint_id: query.endpoint_id,
      capability_ids: normalizedCapabilities(query.capability_ids),
      handoff_id: handoffId,
    }),
  ).toString("base64url");
}

function decodeClaimableCursor(
  query: EndpointClaimableHandoffQuery,
): string | null {
  if (query.cursor === undefined) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.tenant_id !== query.tenant_id ||
      decoded.endpoint_id !== query.endpoint_id ||
      JSON.stringify(decoded.capability_ids) !==
        JSON.stringify(normalizedCapabilities(query.capability_ids)) ||
      typeof decoded.handoff_id !== "string"
    ) {
      throw new Error("cursor query mismatch");
    }
    return decoded.handoff_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function encodeExpiredCursor(
  query: EndpointExpiredClaimQuery,
  expiresAt: string,
  handoffId: string,
): string {
  return Buffer.from(JSON.stringify({
    tenant_id: query.tenant_id,
    expires_at_or_before: query.expires_at_or_before,
    expires_at: expiresAt,
    handoff_id: handoffId,
  })).toString("base64url");
}

function decodeExpiredCursor(
  query: EndpointExpiredClaimQuery,
): { readonly expires_at: string; readonly handoff_id: string } | null {
  if (query.cursor === undefined) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.tenant_id !== query.tenant_id ||
      decoded.expires_at_or_before !== query.expires_at_or_before ||
      typeof decoded.expires_at !== "string" ||
      typeof decoded.handoff_id !== "string"
    ) throw new Error("cursor query mismatch");
    parseUtcTimestamp(decoded.expires_at, "cursor expires_at");
    return {
      expires_at: decoded.expires_at,
      handoff_id: decoded.handoff_id,
    };
  } catch {
    throw new TypeError("invalid cursor");
  }
}

export class PostgresEndpointInboxStore implements EndpointInboxStore {
  readonly manifest = clone(manifest);
  private tenantContext: string | undefined;

  constructor(
    private readonly sessionFactory: (tenantId: string) => TenantSession,
    tenantId?: string,
  ) {
    if (tenantId !== undefined) identity(tenantId, "tenantId");
    this.tenantContext = tenantId;
  }

  private bind(tenantId: string): void {
    identity(tenantId, "tenantId");
    if (this.tenantContext === undefined) this.tenantContext = tenantId;
    if (this.tenantContext !== tenantId) {
      throw new Error("tenant context mismatch");
    }
  }

  private run<T>(
    tenantId: string,
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    this.bind(tenantId);
    return this.sessionFactory(tenantId).withTransaction(operation);
  }

  async upsertRoutingFact(fact: EndpointInboxRoutingFact): Promise<void> {
    const candidate = clone(fact);
    await this.run(candidate.tenant_id, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_endpoint_inbox_facts WHERE tenant_id=$1 AND handoff_id=$2 FOR UPDATE",
        [candidate.tenant_id, candidate.handoff_id],
      );
      if (result.rows[0] !== undefined) {
        const existing = json<EndpointInboxRoutingFact>(
          result.rows[0].payload,
        );
        if (
          candidate.resource_version < existing.resource_version ||
          candidate.observed_position < existing.observed_position
        ) {
          throw new Error("Endpoint inbox projection must be monotonic");
        }
        if (candidate.resource_version === existing.resource_version) {
          if (isDeepStrictEqual(existing, candidate)) return;
          throw new Error("Endpoint inbox projection version conflicts");
        }
      }
      await client.query(
        "INSERT INTO work_fabric_endpoint_inbox_facts (tenant_id,handoff_id,partition_id,resource_version,observed_position,active,visible_actor_ids,visible_endpoint_ids,claim_id,claim_fencing_token,claim_expires_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11::timestamptz,$12::jsonb) ON CONFLICT (tenant_id,handoff_id) DO UPDATE SET partition_id=EXCLUDED.partition_id,resource_version=EXCLUDED.resource_version,observed_position=EXCLUDED.observed_position,active=EXCLUDED.active,visible_actor_ids=EXCLUDED.visible_actor_ids,visible_endpoint_ids=EXCLUDED.visible_endpoint_ids,claim_id=EXCLUDED.claim_id,claim_fencing_token=EXCLUDED.claim_fencing_token,claim_expires_at=EXCLUDED.claim_expires_at,payload=EXCLUDED.payload",
        [
          candidate.tenant_id,
          candidate.handoff_id,
          candidate.partition_id,
          candidate.resource_version,
          candidate.observed_position,
          candidate.active,
          candidate.visible_actor_ids,
          candidate.visible_endpoint_ids,
          candidate.active_claim?.claim_id ?? null,
          candidate.active_claim?.fencing_token ?? null,
          candidate.active_claim?.expires_at ?? null,
          JSON.stringify(candidate),
        ],
      );
    });
  }

  async listPartitions(
    input: EndpointInboxPartitionQuery,
  ): Promise<EndpointInboxPartitionPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const after = decodeCursor(input);
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT partition_id,MAX(observed_position) AS latest_position,COUNT(*) AS active_handoff_count
           FROM work_fabric_endpoint_inbox_facts
          WHERE tenant_id=$1 AND active=true AND partition_id > COALESCE($2,'')
            AND ($3=ANY(visible_actor_ids) OR $4=ANY(visible_endpoint_ids))
          GROUP BY partition_id
          ORDER BY partition_id
          LIMIT $5`,
        [input.tenant_id, after, input.actor_id, input.endpoint_id, input.limit + 1],
      );
      const items = result.rows.slice(0, input.limit).map((row) => ({
        partition_id: String(row.partition_id),
        latest_position: Number(row.latest_position),
        active_handoff_count: Number(row.active_handoff_count),
      }));
      return {
        items,
        ...(result.rows.length > input.limit
          ? {
              next_cursor: encodeCursor(
                input,
                items.at(-1)!.partition_id,
              ),
            }
          : {}),
      };
    });
  }

  async listClaimableHandoffs(
    input: EndpointClaimableHandoffQuery,
  ): Promise<EndpointClaimableHandoffPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const after = decodeClaimableCursor(input);
    const capabilities = normalizedCapabilities(input.capability_ids);
    if (capabilities.length === 0) return { items: [] };
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload
           FROM work_fabric_endpoint_inbox_facts
          WHERE tenant_id=$1
            AND active=true
            AND handoff_id > COALESCE($2,'')
            AND payload->>'lifecycle_state'='claimable'
            AND (payload->'capability_ids') ?| $3::text[]
          ORDER BY handoff_id
          LIMIT $4`,
        [input.tenant_id, after, capabilities, input.limit + 1],
      );
      const facts = result.rows.map(({ payload }) =>
        json<EndpointInboxRoutingFact>(payload)
      );
      const items = facts.slice(0, input.limit).map((fact) => ({
        partition_id: fact.partition_id,
        handoff_id: fact.handoff_id,
        resource_version: fact.resource_version,
        lifecycle_state: "claimable" as const,
        capability_ids: [...fact.capability_ids],
        last_event_id: fact.last_event_id,
        observed_position: fact.observed_position,
      }));
      return {
        items,
        ...(facts.length > input.limit
          ? {
              next_cursor: encodeClaimableCursor(
                input,
                items.at(-1)!.handoff_id,
              ),
            }
          : {}),
      };
    });
  }

  async listExpiredClaims(
    input: EndpointExpiredClaimQuery,
  ): Promise<EndpointExpiredClaimPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    parseUtcTimestamp(input.expires_at_or_before, "expires_at_or_before");
    const after = decodeExpiredCursor(input);
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<{
        partition_id: string;
        handoff_id: string;
        resource_version: string | number;
        claim_id: string;
        claim_fencing_token: string | number;
        claim_expires_at: string;
      }>(
        `SELECT partition_id,handoff_id,resource_version,claim_id,claim_fencing_token,
                claim_expires_at::text AS claim_expires_at
           FROM work_fabric_endpoint_inbox_facts
          WHERE tenant_id=$1
            AND active=true
            AND claim_expires_at <= $2::timestamptz
            AND (
              $3::timestamptz IS NULL
              OR (claim_expires_at,handoff_id) > ($3::timestamptz,$4)
            )
          ORDER BY claim_expires_at,handoff_id
          LIMIT $5`,
        [
          input.tenant_id,
          input.expires_at_or_before,
          after?.expires_at ?? null,
          after?.handoff_id ?? "",
          input.limit + 1,
        ],
      );
      const values = result.rows.map((row) => ({
        partition_id: String(row.partition_id),
        handoff_id: String(row.handoff_id),
        resource_version: Number(row.resource_version),
        claim_id: String(row.claim_id),
        fencing_token: Number(row.claim_fencing_token),
        expires_at: new Date(row.claim_expires_at).toISOString(),
      }));
      const items = values.slice(0, input.limit);
      const last = items.at(-1);
      return {
        items,
        ...(values.length > input.limit && last !== undefined
          ? {
              next_cursor: encodeExpiredCursor(
                input,
                last.expires_at,
                last.handoff_id,
              ),
            }
          : {}),
      };
    });
  }

  async clearTenantProjection(tenantId: string): Promise<void> {
    await this.run(tenantId, async (client) => {
      await client.query(
        "DELETE FROM work_fabric_endpoint_inbox_facts WHERE tenant_id=$1",
        [tenantId],
      );
    });
  }

  async clearPartitionProjection(tenantId: string, partitionId: string): Promise<void> {
    await this.run(tenantId, async (client) => {
      await client.query(
        "DELETE FROM work_fabric_endpoint_inbox_facts WHERE tenant_id=$1 AND partition_id=$2",
        [tenantId, partitionId],
      );
    });
  }
}
