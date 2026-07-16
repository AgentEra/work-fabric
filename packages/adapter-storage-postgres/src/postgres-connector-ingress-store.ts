import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type {
  PostgresClient,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import {
  CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
  ConnectorIngressStoreError,
  assertBoundedConnectorId,
  assertSafeConnectorJson,
  resolveConnectorIngressLimits,
  type AcceptConnectorIngressResult,
  type ClaimConnectorIngress,
  type ConnectorIngressClaim,
  type ConnectorIngressClaimMutation,
  type ConnectorIngressEnvelope,
  type ConnectorIngressLimits,
  type ConnectorIngressPage,
  type ConnectorIngressRecord,
  type ConnectorIngressState,
  type ConnectorIngressStore,
  type DeadLetterConnectorIngress,
  type GetConnectorIngress,
  type ListConnectorIngress,
  type RequeueConnectorIngress,
  type RenewConnectorIngress,
  type RetryConnectorIngress,
} from "@work-fabric/connector-spi";
import {
  addUtcTimestampSeconds,
  parseUtcTimestamp,
  type CapabilityManifest,
} from "@work-fabric/exchange-spi";

export const CONNECTOR_INGRESS_MIGRATION = {
  id: "005_connector_ingress",
  sql: readFileSync(
    new URL("../migrations/005_connector_ingress.sql", import.meta.url),
    "utf8",
  ),
} as const;

export const CONNECTOR_INGRESS_HARDENING_MIGRATION = {
  id: "006_connector_ingress_hardening",
  sql: readFileSync(
    new URL("../migrations/006_connector_ingress_hardening.sql", import.meta.url),
    "utf8",
  ),
} as const;

const manifest: CapabilityManifest = {
  profile: "connector.ingress.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    CONNECTOR_INGRESS_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json<T>(value: unknown): T {
  return typeof value === "string"
    ? (JSON.parse(value) as T)
    : clone(value as T);
}

function nullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function timestampString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function validateEnvelope(
  envelope: ConnectorIngressEnvelope,
  limits: ConnectorIngressLimits,
): void {
  for (const [label, value] of [
    ["tenant_id", envelope.tenant_id],
    ["connector_id", envelope.connector_id],
    ["source_system", envelope.source_system],
    ["external_tenant_id", envelope.external_tenant_id],
    ["external_event_id", envelope.external_event_id],
    ["dedupe_key", envelope.dedupe_key],
    ["event_type", envelope.event_type],
  ] as const) {
    assertBoundedConnectorId(value, label, limits.max_id_length);
  }
  if (envelope.partition_key !== undefined) {
    assertBoundedConnectorId(
      envelope.partition_key,
      "partition_key",
      limits.max_id_length,
    );
  }
  parseUtcTimestamp(envelope.occurred_at, "occurred_at");
  parseUtcTimestamp(envelope.received_at, "received_at");
  assertSafeConnectorJson(envelope.payload, "payload", limits);
  if (envelope.trace_context !== undefined) {
    if (Object.keys(envelope.trace_context).length > limits.max_trace_fields) {
      throw new RangeError("trace_context exceeds its configured field limit");
    }
    assertSafeConnectorJson(envelope.trace_context, "trace_context", limits);
  }
}

function encodeCursor(
  input: ListConnectorIngress,
  item: ConnectorIngressRecord,
): string {
  return Buffer.from(JSON.stringify({
    tenant_id: input.tenant_id,
    connector_id: input.connector_id,
    accepted_at: item.accepted_at,
    ingress_id: item.ingress_id,
  })).toString("base64url");
}

function decodeCursor(input: ListConnectorIngress): {
  readonly accepted_at: string;
  readonly ingress_id: string;
} | null {
  if (input.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(input.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.tenant_id !== input.tenant_id ||
      value.connector_id !== input.connector_id ||
      typeof value.accepted_at !== "string" ||
      typeof value.ingress_id !== "string"
    ) throw new Error("cursor scope mismatch");
    parseUtcTimestamp(value.accepted_at, "cursor accepted_at");
    return { accepted_at: value.accepted_at, ingress_id: value.ingress_id };
  } catch {
    throw new TypeError("invalid Connector ingress cursor");
  }
}

export interface PostgresConnectorIngressStoreOptions {
  readonly id_factory?: () => string;
  readonly claim_token_factory?: () => string;
  readonly limits?: Partial<ConnectorIngressLimits>;
  readonly completed_retention_seconds?: number;
  readonly dead_letter_retention_seconds?: number;
}

export interface PruneExpiredConnectorIngress {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly now: string;
  readonly limit: number;
}

export class PostgresConnectorIngressStore implements ConnectorIngressStore {
  readonly manifest = clone(manifest);
  private tenantContext: string | undefined;
  private readonly idFactory: () => string;
  private readonly claimTokenFactory: () => string;
  private readonly limits: ConnectorIngressLimits;
  private readonly completedRetentionSeconds: number;
  private readonly deadLetterRetentionSeconds: number;

  constructor(
    private readonly sessionFactory: (tenantId: string) => TenantSession,
    tenantId?: string,
    options: PostgresConnectorIngressStoreOptions = {},
  ) {
    this.idFactory = options.id_factory ?? randomUUID;
    this.claimTokenFactory = options.claim_token_factory ?? randomUUID;
    this.limits = resolveConnectorIngressLimits(options.limits);
    this.completedRetentionSeconds = options.completed_retention_seconds ?? 604_800;
    this.deadLetterRetentionSeconds =
      options.dead_letter_retention_seconds ?? 2_592_000;
    this.positiveBounded(
      this.completedRetentionSeconds,
      31_536_000,
      "completed_retention_seconds",
    );
    this.positiveBounded(
      this.deadLetterRetentionSeconds,
      31_536_000,
      "dead_letter_retention_seconds",
    );
    if (tenantId !== undefined) this.bind(tenantId);
  }

  async accept(
    envelope: ConnectorIngressEnvelope,
  ): Promise<AcceptConnectorIngressResult> {
    validateEnvelope(envelope, this.limits);
    const candidate = clone(envelope);
    const ingressId = this.idFactory();
    assertBoundedConnectorId(
      ingressId,
      "ingress_id",
      this.limits.max_id_length,
    );
    return this.run(candidate.tenant_id, async (client) => {
      const inserted = await client.query<Row>(
        `INSERT INTO work_fabric_connector_ingress
          (tenant_id,connector_id,ingress_id,source_system,external_event_id,dedupe_key,event_type,partition_key,occurred_at,received_at,envelope,state,attempt,available_at,accepted_at,updated_at,fencing_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'pending',0,$10,$10,$10,0)
         ON CONFLICT (tenant_id,connector_id,source_system,dedupe_key) DO NOTHING
         RETURNING *`,
        [candidate.tenant_id, candidate.connector_id, ingressId,
          candidate.source_system, candidate.external_event_id,
          candidate.dedupe_key, candidate.event_type,
          candidate.partition_key ?? null, candidate.occurred_at,
          candidate.received_at, JSON.stringify(candidate)],
      );
      if (inserted.rows[0] !== undefined) {
        return { kind: "accepted", record: this.record(inserted.rows[0]) };
      }
      const existing = await client.query<Row>(
        `SELECT * FROM work_fabric_connector_ingress
          WHERE tenant_id=$1 AND connector_id=$2 AND source_system=$3 AND dedupe_key=$4`,
        [candidate.tenant_id, candidate.connector_id,
          candidate.source_system, candidate.dedupe_key],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error("Connector ingress dedupe record disappeared");
      }
      const record = this.record(row);
      if (!isDeepStrictEqual(record.envelope, candidate)) {
        throw new ConnectorIngressStoreError(
          "dedupe_conflict",
          "Connector ingress dedupe key conflicts with payload",
        );
      }
      return { kind: "duplicate", record };
    });
  }

  async claim(
    input: ClaimConnectorIngress,
  ): Promise<readonly ConnectorIngressClaim[]> {
    this.validateScope(input.tenant_id, input.connector_id);
    this.positiveBounded(input.limit, this.limits.max_claim_limit, "limit");
    this.positiveBounded(
      input.lease_seconds,
      this.limits.max_lease_seconds,
      "lease_seconds",
    );
    assertBoundedConnectorId(
      input.worker_id,
      "worker_id",
      this.limits.max_id_length,
    );
    parseUtcTimestamp(input.now, "now");
    const leaseExpiresAt = addUtcTimestampSeconds(
      input.now,
      input.lease_seconds,
    );
    const tokenPrefix = this.claimTokenFactory();
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<Row>(
        `WITH eligible AS (
           SELECT tenant_id,connector_id,ingress_id
             FROM work_fabric_connector_ingress
            WHERE tenant_id=$1 AND connector_id=$2
              AND (
                (state IN ('pending','retry_wait') AND available_at <= $3)
                OR
                (state='processing' AND lease_expires_at <= $3)
              )
            ORDER BY available_at,received_at,ingress_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
         )
         UPDATE work_fabric_connector_ingress AS ingress
            SET state='processing',attempt=ingress.attempt+1,
                claim_owner=$5,claim_token=($6 || ':' || (ingress.fencing_token+1)::text),
                fencing_token=ingress.fencing_token+1,lease_expires_at=$7,updated_at=$3
           FROM eligible
          WHERE ingress.tenant_id=eligible.tenant_id
            AND ingress.connector_id=eligible.connector_id
            AND ingress.ingress_id=eligible.ingress_id
         RETURNING ingress.*`,
        [input.tenant_id, input.connector_id, input.now, input.limit,
          input.worker_id, tokenPrefix, leaseExpiresAt],
      );
      return result.rows.map((row) => this.claimRecord(row));
    });
  }

  async complete(
    input: ConnectorIngressClaimMutation,
  ): Promise<ConnectorIngressRecord> {
    const retentionExpiresAt = addUtcTimestampSeconds(
      input.now,
      this.completedRetentionSeconds,
    );
    return this.settleClaim(input,
      `state='completed',completed_at=$6,retention_expires_at=$7,
       last_error_code=NULL,last_error_detail=NULL`,
      [retentionExpiresAt]);
  }

  async renew(input: RenewConnectorIngress): Promise<ConnectorIngressClaim> {
    this.validateScope(input.tenant_id, input.connector_id);
    parseUtcTimestamp(input.now, "now");
    this.positiveBounded(
      input.lease_seconds,
      this.limits.max_lease_seconds,
      "lease_seconds",
    );
    const leaseExpiresAt = addUtcTimestampSeconds(input.now, input.lease_seconds);
    const result = await this.run(input.tenant_id, (client) =>
      client.query<Row>(
        `UPDATE work_fabric_connector_ingress
            SET lease_expires_at=$7,updated_at=$6
          WHERE tenant_id=$1 AND connector_id=$2 AND ingress_id=$3
            AND state='processing' AND claim_token=$4 AND fencing_token=$5
            AND lease_expires_at > $6
        RETURNING *`,
        [input.tenant_id, input.connector_id, input.ingress_id,
          input.claim_token, input.fencing_token, input.now, leaseExpiresAt],
      ));
    const row = result.rows[0];
    if (row === undefined) {
      throw new ConnectorIngressStoreError(
        "claim_lost",
        "Connector ingress claim is stale, expired, or invalid",
      );
    }
    return this.claimRecord(row);
  }

  async retry(input: RetryConnectorIngress): Promise<ConnectorIngressRecord> {
    parseUtcTimestamp(input.available_at, "available_at");
    this.validateError(input.error_code, input.error_detail);
    return this.settleClaim(input,
      `state='retry_wait',available_at=$7,last_error_code=$8,last_error_detail=$9`,
      [input.available_at, input.error_code, input.error_detail ?? null]);
  }

  async deadLetter(
    input: DeadLetterConnectorIngress,
  ): Promise<ConnectorIngressRecord> {
    this.validateError(input.error_code, input.error_detail);
    const retentionExpiresAt = addUtcTimestampSeconds(
      input.now,
      this.deadLetterRetentionSeconds,
    );
    return this.settleClaim(input,
      `state='dead_letter',retention_expires_at=$7,
       last_error_code=$8,last_error_detail=$9`,
      [retentionExpiresAt, input.error_code, input.error_detail ?? null]);
  }

  async requeue(
    input: RequeueConnectorIngress,
  ): Promise<ConnectorIngressRecord> {
    this.validateScope(input.tenant_id, input.connector_id);
    parseUtcTimestamp(input.now, "now");
    parseUtcTimestamp(input.available_at, "available_at");
    assertBoundedConnectorId(
      input.reason,
      "reason",
      this.limits.max_error_detail_length,
    );
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<Row>(
        `UPDATE work_fabric_connector_ingress
            SET state='retry_wait',available_at=$4,updated_at=$5,
                retention_expires_at=NULL,
                last_requeue_reason=$6,last_requeued_at=$5,
                last_error_code=NULL,last_error_detail=NULL
          WHERE tenant_id=$1 AND connector_id=$2 AND ingress_id=$3
            AND state='dead_letter'
        RETURNING *`,
        [input.tenant_id, input.connector_id, input.ingress_id,
          input.available_at, input.now, input.reason],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ConnectorIngressStoreError(
          "invalid_state",
          "Only a dead-letter Connector ingress can be requeued",
        );
      }
      return this.record(row);
    });
  }

  async get(
    input: GetConnectorIngress,
  ): Promise<ConnectorIngressRecord | null> {
    this.validateScope(input.tenant_id, input.connector_id);
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<Row>(
        `SELECT * FROM work_fabric_connector_ingress
          WHERE tenant_id=$1 AND connector_id=$2 AND ingress_id=$3`,
        [input.tenant_id, input.connector_id, input.ingress_id],
      );
      return result.rows[0] === undefined ? null : this.record(result.rows[0]);
    });
  }

  async pruneExpired(input: PruneExpiredConnectorIngress): Promise<number> {
    this.validateScope(input.tenant_id, input.connector_id);
    parseUtcTimestamp(input.now, "now");
    this.positiveBounded(input.limit, this.limits.max_page_limit, "limit");
    const result = await this.run(input.tenant_id, (client) =>
      client.query<Row>(
        `WITH expired AS (
           SELECT tenant_id,connector_id,ingress_id
             FROM work_fabric_connector_ingress
            WHERE tenant_id=$1 AND connector_id=$2
              AND state IN ('completed','dead_letter')
              AND retention_expires_at <= $3
            ORDER BY retention_expires_at,ingress_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
         )
         DELETE FROM work_fabric_connector_ingress AS ingress
          USING expired
          WHERE ingress.tenant_id=expired.tenant_id
            AND ingress.connector_id=expired.connector_id
            AND ingress.ingress_id=expired.ingress_id
         RETURNING ingress.ingress_id`,
        [input.tenant_id, input.connector_id, input.now, input.limit],
      ));
    return result.rowCount;
  }

  async list(input: ListConnectorIngress): Promise<ConnectorIngressPage> {
    this.validateScope(input.tenant_id, input.connector_id);
    this.positiveBounded(input.limit, this.limits.max_page_limit, "limit");
    const after = decodeCursor(input);
    const result = await this.run(input.tenant_id, (client) =>
      client.query<Row>(
        `SELECT * FROM work_fabric_connector_ingress
          WHERE tenant_id=$1 AND connector_id=$2
            AND ($3::text[] IS NULL OR state=ANY($3::text[]))
            AND (
              $4 IS NULL
              OR accepted_at > $4
              OR (accepted_at = $4 AND ingress_id > $5)
            )
          ORDER BY accepted_at,ingress_id
          LIMIT $6`,
        [input.tenant_id, input.connector_id, input.states ?? null,
          after?.accepted_at ?? null, after?.ingress_id ?? null,
          input.limit + 1],
      ));
    const items = result.rows.slice(0, input.limit).map((row) => this.record(row));
    return {
      items,
      ...(result.rows.length > input.limit
        ? { next_cursor: encodeCursor(input, items.at(-1)!) }
        : {}),
    };
  }

  private async settleClaim(
    input: ConnectorIngressClaimMutation,
    assignments: string,
    extra: readonly unknown[] = [],
  ): Promise<ConnectorIngressRecord> {
    this.validateScope(input.tenant_id, input.connector_id);
    parseUtcTimestamp(input.now, "now");
    const result = await this.run(input.tenant_id, (client) =>
      client.query<Row>(
        `UPDATE work_fabric_connector_ingress
            SET ${assignments},updated_at=$6,
                claim_owner=NULL,claim_token=NULL,lease_expires_at=NULL
          WHERE tenant_id=$1 AND connector_id=$2 AND ingress_id=$3
            AND state='processing' AND claim_token=$4 AND fencing_token=$5
            AND lease_expires_at > $6
        RETURNING *`,
        [input.tenant_id, input.connector_id, input.ingress_id,
          input.claim_token, input.fencing_token, input.now, ...extra],
      ));
    const row = result.rows[0];
    if (row === undefined) {
      throw new ConnectorIngressStoreError(
        "claim_lost",
        "Connector ingress claim is stale, expired, or invalid",
      );
    }
    return this.record(row);
  }

  private record(row: Row): ConnectorIngressRecord {
    return {
      ingress_id: String(row.ingress_id),
      envelope: json<ConnectorIngressEnvelope>(row.envelope),
      state: row.state as ConnectorIngressState,
      attempt: Number(row.attempt),
      available_at: timestampString(row.available_at),
      accepted_at: timestampString(row.accepted_at),
      updated_at: timestampString(row.updated_at),
      ...(nullableString(row.completed_at) === undefined
        ? {} : { completed_at: nullableString(row.completed_at)! }),
      ...(nullableString(row.last_error_code) === undefined
        ? {} : { last_error_code: nullableString(row.last_error_code)! }),
      ...(nullableString(row.last_error_detail) === undefined
        ? {} : { last_error_detail: nullableString(row.last_error_detail)! }),
      ...(nullableString(row.last_requeue_reason) === undefined
        ? {} : { last_requeue_reason: nullableString(row.last_requeue_reason)! }),
      ...(nullableString(row.last_requeued_at) === undefined
        ? {} : { last_requeued_at: nullableString(row.last_requeued_at)! }),
    };
  }

  private claimRecord(row: Row): ConnectorIngressClaim {
    return {
      ...this.record(row),
      state: "processing",
      claim_owner: String(row.claim_owner),
      claim_token: String(row.claim_token),
      fencing_token: Number(row.fencing_token),
      lease_expires_at: timestampString(row.lease_expires_at),
    };
  }

  private bind(tenantId: string): void {
    assertBoundedConnectorId(
      tenantId,
      "tenant_id",
      this.limits.max_id_length,
    );
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

  private validateScope(tenantId: string, connectorId: string): void {
    this.bind(tenantId);
    assertBoundedConnectorId(
      connectorId,
      "connector_id",
      this.limits.max_id_length,
    );
  }

  private positiveBounded(value: number, maximum: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new RangeError(`${label} must be between 1 and ${maximum}`);
    }
  }

  private validateError(code: string, detail: string | undefined): void {
    assertBoundedConnectorId(code, "error_code", this.limits.max_id_length);
    if (detail !== undefined && detail.length > this.limits.max_error_detail_length) {
      throw new RangeError("error_detail exceeds its configured limit");
    }
  }
}
