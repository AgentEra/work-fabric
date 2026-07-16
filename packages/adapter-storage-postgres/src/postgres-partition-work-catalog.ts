import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import type { TenantSession } from "@work-fabric/adapter-postgres-common";
import {
  CLUSTER_REQUIRED_CAPABILITIES,
  PARTITION_WORK_KINDS,
  clusterIdentifier,
  clusterTimestamp,
  clusterWorkKind,
  type ClusterCapabilityManifest,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
  type PartitionWorkKind,
  type PartitionWorkPage,
} from "@work-fabric/cluster-spi";

export const CLUSTER_RUNTIME_MIGRATION = {
  id: "008_cluster_runtime",
  sql: readFileSync(
    new URL("../migrations/008_cluster_runtime.sql", import.meta.url),
    "utf8",
  ),
} as const;

const manifest: ClusterCapabilityManifest = {
  profile: "workfabric.cluster.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    CLUSTER_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

interface CursorPayload {
  readonly version: 1;
  readonly tenant_id: string;
  readonly kinds: readonly PartitionWorkKind[];
  readonly available_at_or_before: string;
  readonly after: {
    readonly available_at: string;
    readonly partition_id: string;
    readonly kind_rank: number;
  };
}

interface CatalogRow extends Record<string, unknown> {
  readonly tenant_id: unknown;
  readonly partition_id: unknown;
  readonly kind: unknown;
  readonly observed_position: unknown;
  readonly available_at: unknown;
}

const READY_SQL = `
SELECT ready.tenant_id,
       ready.partition_id,
       ready.kind,
       ready.observed_position,
       ready.available_at
FROM work_fabric_partition_readiness AS ready
WHERE ready.tenant_id = $1
  AND ready.kind = ANY($2::text[])
  AND ready.available_at <= $3::timestamptz
  AND (
    $4::timestamptz IS NULL OR
    (ready.available_at, ready.partition_id, ready.kind_rank) >
      ($4::timestamptz, $5::text, $6::smallint)
  )
  AND CASE ready.kind
    WHEN 'outbox_wakeup' THEN EXISTS (
      SELECT 1
      FROM work_fabric_outbox AS pending
      WHERE pending.tenant_id = ready.tenant_id
        AND pending.partition_id = ready.partition_id
        AND work_fabric_timestamp_key(COALESCE(
          pending.next_attempt_at,
          '1970-01-01T00:00:00.000Z'
        )) <= work_fabric_timestamp_key($3)
        AND (
          pending.lease_expires_at IS NULL OR
          work_fabric_timestamp_key(pending.lease_expires_at) <=
            work_fabric_timestamp_key($3)
        )
    )
    WHEN 'handoff_projection' THEN ready.observed_position > COALESCE((
      SELECT checkpoint.position
      FROM work_fabric_projection_checkpoints AS checkpoint
      WHERE checkpoint.tenant_id = ready.tenant_id
        AND checkpoint.partition_id = ready.partition_id
        AND checkpoint.projector_id = 'workfabric.handoff.read-model.v1'
    ), 0)
    WHEN 'collaboration_projection' THEN ready.observed_position > COALESCE((
      SELECT checkpoint.position
      FROM work_fabric_projection_checkpoints AS checkpoint
      WHERE checkpoint.tenant_id = ready.tenant_id
        AND checkpoint.partition_id = ready.partition_id
        AND checkpoint.projector_id = 'workfabric.collaboration.visibility.v1'
    ), 0)
    WHEN 'signal_delivery' THEN EXISTS (
      SELECT 1
      FROM work_fabric_subscriptions AS subscription
      LEFT JOIN work_fabric_delivery_positions AS delivery
        ON delivery.tenant_id = subscription.tenant_id
       AND delivery.subscription_id = subscription.subscription_id
       AND delivery.partition_id = ready.partition_id
      WHERE subscription.tenant_id = ready.tenant_id
        AND subscription.payload->>'state' = 'active'
        AND subscription.payload->>'delivery_mode' IN ('sse', 'webhook')
        AND COALESCE(delivery.position, 0) < ready.observed_position
        AND NOT EXISTS (
          SELECT 1
          FROM work_fabric_events AS next_event
          JOIN LATERAL (
            SELECT attempt.next_attempt_at
            FROM work_fabric_delivery_attempts AS attempt
            WHERE attempt.tenant_id = subscription.tenant_id
              AND attempt.subscription_id = subscription.subscription_id
              AND attempt.event_id = next_event.event_id
            ORDER BY attempt.attempt DESC
            LIMIT 1
          ) AS latest_attempt ON true
          WHERE next_event.tenant_id = ready.tenant_id
            AND next_event.partition_id = ready.partition_id
            AND next_event.partition_position = (
              SELECT MIN(candidate.partition_position)
              FROM work_fabric_events AS candidate
              WHERE candidate.tenant_id = ready.tenant_id
                AND candidate.partition_id = ready.partition_id
                AND candidate.partition_position > COALESCE(delivery.position, 0)
            )
            AND latest_attempt.next_attempt_at IS NOT NULL
            AND work_fabric_timestamp_key(latest_attempt.next_attempt_at) >
              work_fabric_timestamp_key($3)
        )
    )
    ELSE false
  END
ORDER BY ready.available_at ASC,
         ready.partition_id ASC,
         ready.kind_rank ASC
LIMIT $7`;

function normalizeKinds(input: readonly PartitionWorkKind[]): PartitionWorkKind[] {
  if (input.length === 0 || input.length > PARTITION_WORK_KINDS.length) {
    throw new TypeError("kinds must be non-empty and bounded");
  }
  const values = input.map((kind) => clusterWorkKind(kind));
  if (new Set(values).size !== values.length) {
    throw new TypeError("kinds must be unique");
  }
  return [...values].sort(
    (left, right) =>
      PARTITION_WORK_KINDS.indexOf(left) - PARTITION_WORK_KINDS.indexOf(right),
  );
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

function positivePosition(value: unknown): number {
  const position = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(position) || (position as number) <= 0) {
    throw new RangeError("observed_position must be a positive safe integer");
  }
  return position as number;
}

export class PostgresPartitionWorkCatalog implements PartitionWorkCatalog {
  private readonly secret: Buffer;

  constructor(
    private readonly sessionFactory: (tenantId: string) => TenantSession,
    secret: string,
  ) {
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new RangeError("cursor secret must contain at least 32 bytes");
    }
    if (Buffer.byteLength(secret, "utf8") > 1_024) {
      throw new RangeError("cursor secret is too long");
    }
    this.secret = Buffer.from(secret, "utf8");
  }

  get manifest(): ClusterCapabilityManifest {
    return structuredClone(manifest);
  }

  async scanReady(input: {
    readonly tenant_id: string;
    readonly kinds: readonly PartitionWorkKind[];
    readonly available_at_or_before: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<PartitionWorkPage> {
    const tenantId = clusterIdentifier(input.tenant_id, "tenant_id");
    const kinds = normalizeKinds(input.kinds);
    const due = clusterTimestamp(
      input.available_at_or_before,
      "available_at_or_before",
    );
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new RangeError("limit must be between 1 and 1000");
    }
    const cursor = input.cursor === undefined
      ? undefined
      : this.decodeCursor(input.cursor);
    if (
      cursor !== undefined &&
      (cursor.tenant_id !== tenantId ||
        cursor.available_at_or_before !== due ||
        JSON.stringify(cursor.kinds) !== JSON.stringify(kinds))
    ) throw new TypeError("cursor context does not match scan");

    const session = this.sessionFactory(tenantId);
    if (session.tenant_id !== tenantId) {
      throw new Error("tenant session context mismatch");
    }
    const result = await session.withTransaction((client) =>
      client.query<CatalogRow>(READY_SQL, [
        tenantId,
        kinds,
        due,
        cursor?.after.available_at ?? null,
        cursor?.after.partition_id ?? null,
        cursor?.after.kind_rank ?? null,
        input.limit + 1,
      ])
    );
    const mapped = result.rows.map((row) => this.mapRow(row, tenantId));
    const hasNext = mapped.length > input.limit;
    const items = mapped.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      next_cursor: hasNext && last !== undefined
        ? this.encodeCursor({
          version: 1,
          tenant_id: tenantId,
          kinds,
          available_at_or_before: due,
          after: {
            available_at: last.available_at,
            partition_id: last.partition_id,
            kind_rank: PARTITION_WORK_KINDS.indexOf(last.kind),
          },
        })
        : null,
    };
  }

  private mapRow(row: CatalogRow, tenantId: string): PartitionWorkItem {
    if (row.tenant_id !== tenantId) throw new Error("catalog tenant mismatch");
    return {
      tenant_id: tenantId,
      partition_id: clusterIdentifier(row.partition_id, "partition_id"),
      kind: clusterWorkKind(row.kind),
      observed_position: positivePosition(row.observed_position),
      available_at: canonicalTimestamp(row.available_at, "available_at"),
    };
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  private decodeCursor(value: string): CursorPayload {
    if (value.length === 0 || value.length > 2_048) {
      throw new TypeError("cursor is invalid");
    }
    const parts = value.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new TypeError("cursor is invalid");
    }
    const expected = createHmac("sha256", this.secret).update(parts[0]).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(parts[1], "base64url");
    } catch {
      throw new TypeError("cursor is invalid");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new TypeError("cursor signature is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new TypeError("cursor is invalid");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("cursor is invalid");
    }
    const raw = parsed as Record<string, unknown>;
    if (
      raw.version !== 1 || typeof raw.tenant_id !== "string" ||
      !Array.isArray(raw.kinds) ||
      typeof raw.available_at_or_before !== "string" ||
      typeof raw.after !== "object" || raw.after === null ||
      Array.isArray(raw.after)
    ) throw new TypeError("cursor is invalid");
    const after = raw.after as Record<string, unknown>;
    const kinds = normalizeKinds(raw.kinds as PartitionWorkKind[]);
    const kindRank = after.kind_rank;
    if (
      typeof after.available_at !== "string" ||
      typeof after.partition_id !== "string" ||
      !Number.isSafeInteger(kindRank) || (kindRank as number) < 0 ||
      (kindRank as number) >= PARTITION_WORK_KINDS.length
    ) throw new TypeError("cursor is invalid");
    return {
      version: 1,
      tenant_id: clusterIdentifier(raw.tenant_id, "cursor tenant_id"),
      kinds,
      available_at_or_before: clusterTimestamp(
        raw.available_at_or_before,
        "cursor available_at_or_before",
      ),
      after: {
        available_at: clusterTimestamp(after.available_at, "cursor available_at"),
        partition_id: clusterIdentifier(
          after.partition_id,
          "cursor partition_id",
        ),
        kind_rank: kindRank as number,
      },
    };
  }
}
