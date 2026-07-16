import { isDeepStrictEqual } from "node:util";

import type { CapabilityManifest, JsonObject } from "@work-fabric/exchange-spi";
import {
  AUDIT_STORE_REQUIRED_CAPABILITIES,
  normalizePageLimit,
  validateAuditRecord,
  type AuditQuery,
  type AuditRecord,
  type AuditStore,
  type CursorPage,
  type OpaqueCursorCodec,
} from "@work-fabric/operations-spi";
import {
  clone,
  cursorCodec,
  filterJson,
  identity,
  json,
  positionString,
  positive,
  run,
  timestamp,
  type SessionFactory,
} from "./postgres-operability-common.js";
import type { PostgresOperabilityStoreOptions } from "./postgres-collaboration-store.js";

const manifest: CapabilityManifest = {
  profile: "workfabric.operation-audit.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    AUDIT_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

function add(
  where: string[],
  values: unknown[],
  clause: string,
  value: unknown,
): void {
  values.push(value);
  where.push(clause.replace("?", `$${values.length}`));
}

export class PostgresAuditStore implements AuditStore {
  readonly manifest = clone(manifest);
  private readonly cursor: OpaqueCursorCodec;
  private readonly maxPageLimit: number;

  constructor(
    private readonly sessions: SessionFactory,
    private readonly tenantId: string,
    options: PostgresOperabilityStoreOptions,
  ) {
    identity(tenantId, "tenantId");
    this.maxPageLimit = options.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
    this.cursor = cursorCodec(options.cursor_secret, options.max_cursor_length);
  }

  async append(input: AuditRecord): Promise<void> {
    const record = validateAuditRecord(input);
    if (record.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [this.tenantId, `audit:${record.audit_id}`],
      );
      const existingResult = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_operation_audit WHERE tenant_id=$1 AND audit_id=$2 FOR UPDATE",
        [this.tenantId, record.audit_id],
      );
      const row = existingResult.rows[0];
      if (row !== undefined) {
        const existing = validateAuditRecord(json<AuditRecord>(row.payload));
        if (isDeepStrictEqual(existing, record)) return;
        throw new Error("audit record is immutable and conflicts with first write");
      }
      await client.query(
        "INSERT INTO work_fabric_operation_audit (tenant_id,audit_id,occurred_at,principal_id,operation,outcome,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [
          this.tenantId, record.audit_id, record.occurred_at,
          record.principal_id, record.operation, record.outcome,
          JSON.stringify(record),
        ],
      );
    });
  }

  async list(query: AuditQuery): Promise<CursorPage<AuditRecord>> {
    if (query.tenant_id !== this.tenantId) return { items: [], next_cursor: null };
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "audit" as const,
      sort: "occurred_desc_audit_asc",
      filters: filterJson({
        occurred_from: query.occurred_from,
        occurred_to: query.occurred_to,
        principal_id: query.principal_id,
        operation: query.operation,
        outcome: query.outcome,
      }),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    return run(this.sessions, this.tenantId, async (client) => {
      const values: unknown[] = [this.tenantId];
      const where = ["tenant_id=$1"];
      if (query.occurred_from !== undefined) add(where, values, "occurred_at>=?::timestamptz", query.occurred_from);
      if (query.occurred_to !== undefined) add(where, values, "occurred_at<=?::timestamptz", query.occurred_to);
      if (query.principal_id !== undefined) add(where, values, "principal_id=?", query.principal_id);
      if (query.operation !== undefined) add(where, values, "operation=?", query.operation);
      if (query.outcome !== undefined) add(where, values, "outcome=?", query.outcome);
      if (position !== null) {
        const occurred = positionString(position, "occurred_at");
        const auditId = positionString(position, "audit_id");
        values.push(occurred, auditId);
        where.push(`(occurred_at < $${values.length - 1}::timestamptz OR (occurred_at = $${values.length - 1}::timestamptz AND audit_id > $${values.length}))`);
      }
      values.push(limit + 1);
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_operation_audit WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC,audit_id ASC LIMIT $${values.length}`,
        values,
      );
      const records = result.rows.map((row) =>
        validateAuditRecord(json<AuditRecord>(row.payload)),
      );
      if (records.some((record) => record.tenant_id !== this.tenantId)) {
        throw new Error("audit list identity mismatch");
      }
      const items = records.slice(0, limit);
      const last = items.at(-1);
      return {
        items: clone(items),
        next_cursor: records.length > limit && last !== undefined
          ? await this.cursor.encode({
              ...context,
              position: { occurred_at: last.occurred_at, audit_id: last.audit_id },
            })
          : null,
      };
    });
  }

  async pruneBefore(
    tenantId: string,
    occurredBefore: string,
    limit: number,
  ): Promise<number> {
    identity(tenantId, "tenantId");
    timestamp(occurredBefore, "occurredBefore");
    positive(limit, "limit");
    if (tenantId !== this.tenantId) throw new Error("tenant context mismatch");
    if (limit > this.maxPageLimit) throw new TypeError("limit exceeds maximum");
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query(
        "DELETE FROM work_fabric_operation_audit WHERE ctid IN (SELECT ctid FROM work_fabric_operation_audit WHERE tenant_id=$1 AND occurred_at<$2::timestamptz ORDER BY occurred_at,audit_id LIMIT $3 FOR UPDATE SKIP LOCKED)",
        [this.tenantId, occurredBefore, limit],
      );
      return result.rowCount;
    });
  }
}
