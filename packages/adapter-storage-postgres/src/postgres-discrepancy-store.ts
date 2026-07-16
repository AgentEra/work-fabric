import { isDeepStrictEqual } from "node:util";

import type {
  AcknowledgeConnectorDiscrepancy,
  AcknowledgeDiscrepancyResult,
  ConnectorDiscrepancy,
  ConnectorDiscrepancyPage,
  ConnectorDiscrepancyStore,
  ListConnectorDiscrepancies,
} from "@work-fabric/connector-runtime";
import {
  assertSafeOperationsJson,
  normalizePageLimit,
  type OpaqueCursorCodec,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";
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

function code(value: unknown, field: string): string {
  const result = identity(value, field, 128);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result) ||
    /(?:bearer|token|secret|password|credential)/i.test(result)
  ) throw new TypeError(`${field} is invalid`);
  return result;
}

function nullable(value: string | null, field: string): string | null {
  return value === null ? null : identity(value, field);
}

function validate(input: ConnectorDiscrepancy): ConnectorDiscrepancy {
  const value = clone(input);
  identity(value.discrepancy_id, "discrepancy_id");
  identity(value.tenant_id, "tenant_id");
  identity(value.connector_id, "connector_id");
  identity(value.external_object_id, "external_object_id");
  nullable(value.resource_id, "resource_id");
  nullable(value.expected_state, "expected_state");
  if (value.expected_version !== null) positive(value.expected_version, "expected_version");
  identity(value.observed_state, "observed_state");
  timestamp(value.observed_at, "observed_at");
  assertSafeOperationsJson(value.metadata, "discrepancy metadata");
  if (value.status !== "open" && value.status !== "acknowledged") {
    throw new TypeError("discrepancy status is invalid");
  }
  positive(value.version, "version");
  if (value.acknowledged_at !== null) timestamp(value.acknowledged_at, "acknowledged_at");
  nullable(value.acknowledged_by, "acknowledged_by");
  if (value.acknowledgement_reason !== null) code(value.acknowledgement_reason, "acknowledgement_reason");
  if (
    value.status === "open" &&
    (value.version !== 1 || value.acknowledged_at !== null ||
      value.acknowledged_by !== null || value.acknowledgement_reason !== null)
  ) throw new TypeError("open discrepancy state is invalid");
  if (
    value.status === "acknowledged" &&
    (value.acknowledged_at === null || value.acknowledged_by === null ||
      value.acknowledgement_reason === null)
  ) throw new TypeError("acknowledged discrepancy state is invalid");
  return value;
}

function add(where: string[], values: unknown[], clause: string, value: unknown): void {
  values.push(value);
  where.push(clause.replace("?", `$${values.length}`));
}

export class PostgresDiscrepancyStore implements ConnectorDiscrepancyStore {
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

  async put(input: ConnectorDiscrepancy): Promise<void> {
    const record = validate(input);
    if (record.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [this.tenantId, `discrepancy:${record.discrepancy_id}`],
      );
      const existingResult = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_connector_discrepancies WHERE tenant_id=$1 AND discrepancy_id=$2 FOR UPDATE",
        [this.tenantId, record.discrepancy_id],
      );
      const row = existingResult.rows[0];
      if (row !== undefined) {
        const existing = validate(json<ConnectorDiscrepancy>(row.payload));
        if (isDeepStrictEqual(existing, record)) return;
        throw new Error("discrepancy conflicts with first write");
      }
      await client.query(
        "INSERT INTO work_fabric_connector_discrepancies (tenant_id,discrepancy_id,connector_id,observed_at,status,version,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [this.tenantId, record.discrepancy_id, record.connector_id, record.observed_at, record.status, record.version, JSON.stringify(record)],
      );
    });
  }

  async get(tenantId: string, discrepancyId: string): Promise<ConnectorDiscrepancy | null> {
    identity(tenantId, "tenantId");
    identity(discrepancyId, "discrepancyId");
    if (tenantId !== this.tenantId) return null;
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_connector_discrepancies WHERE tenant_id=$1 AND discrepancy_id=$2",
        [this.tenantId, discrepancyId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const record = validate(json<ConnectorDiscrepancy>(row.payload));
      if (record.tenant_id !== this.tenantId || record.discrepancy_id !== discrepancyId) {
        throw new Error("discrepancy identity mismatch");
      }
      return clone(record);
    });
  }

  async list(input: ListConnectorDiscrepancies): Promise<ConnectorDiscrepancyPage> {
    if (input.tenant_id !== this.tenantId) return { items: [], next_cursor: null };
    if (input.connector_id !== undefined) identity(input.connector_id, "connector_id");
    if (input.statuses !== undefined && (
      input.statuses.length === 0 ||
      input.statuses.some((status) => status !== "open" && status !== "acknowledged")
    )) throw new TypeError("statuses are invalid");
    const limit = normalizePageLimit(input.limit, {
      default_limit: Math.min(25, this.maxPageLimit), max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "operations" as const,
      sort: "discrepancy_observed_desc_id_asc",
      filters: filterJson({
        connector_id: input.connector_id,
        statuses: input.statuses,
      }),
    };
    const position = input.cursor === undefined ? null : await this.cursor.decode(input.cursor, context);
    return run(this.sessions, this.tenantId, async (client) => {
      const values: unknown[] = [this.tenantId];
      const where = ["tenant_id=$1"];
      if (input.connector_id !== undefined) add(where, values, "connector_id=?", input.connector_id);
      if (input.statuses !== undefined) add(where, values, "status=ANY(?::text[])", input.statuses);
      if (position !== null) {
        const observedAt = positionString(position, "observed_at");
        const discrepancyId = positionString(position, "discrepancy_id");
        values.push(observedAt, discrepancyId);
        where.push(`(observed_at < $${values.length - 1}::timestamptz OR (observed_at = $${values.length - 1}::timestamptz AND discrepancy_id > $${values.length}))`);
      }
      values.push(limit + 1);
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_connector_discrepancies WHERE ${where.join(" AND ")} ORDER BY observed_at DESC,discrepancy_id ASC LIMIT $${values.length}`,
        values,
      );
      const candidates = result.rows.map((row) => validate(json<ConnectorDiscrepancy>(row.payload)));
      if (candidates.some((record) => record.tenant_id !== this.tenantId)) {
        throw new Error("discrepancy page tenant mismatch");
      }
      const items = candidates.slice(0, limit);
      const last = items.at(-1);
      return {
        items: clone(items),
        next_cursor: candidates.length > limit && last !== undefined
          ? await this.cursor.encode({
              ...context,
              position: { observed_at: last.observed_at, discrepancy_id: last.discrepancy_id },
            })
          : null,
      };
    });
  }

  async acknowledge(input: AcknowledgeConnectorDiscrepancy): Promise<AcknowledgeDiscrepancyResult> {
    identity(input.tenant_id, "tenant_id");
    identity(input.discrepancy_id, "discrepancy_id");
    positive(input.expected_version, "expected_version");
    timestamp(input.acknowledged_at, "acknowledged_at");
    identity(input.acknowledged_by, "acknowledged_by");
    const reason = code(input.reason, "reason");
    if (input.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_connector_discrepancies WHERE tenant_id=$1 AND discrepancy_id=$2 FOR UPDATE",
        [this.tenantId, input.discrepancy_id],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "not_found" };
      const existing = validate(json<ConnectorDiscrepancy>(row.payload));
      if (
        existing.status === "acknowledged" &&
        input.expected_version + 1 === existing.version &&
        existing.acknowledged_at === input.acknowledged_at &&
        existing.acknowledged_by === input.acknowledged_by &&
        existing.acknowledgement_reason === reason
      ) return { kind: "replayed", discrepancy: clone(existing) };
      if (existing.status !== "open" || existing.version !== input.expected_version) {
        return { kind: "conflict", current_version: existing.version };
      }
      const acknowledged = validate({
        ...existing,
        status: "acknowledged",
        version: existing.version + 1,
        acknowledged_at: input.acknowledged_at,
        acknowledged_by: input.acknowledged_by,
        acknowledgement_reason: reason,
      });
      await client.query(
        "UPDATE work_fabric_connector_discrepancies SET status='acknowledged',version=$3,payload=$4::jsonb WHERE tenant_id=$1 AND discrepancy_id=$2",
        [this.tenantId, input.discrepancy_id, acknowledged.version, JSON.stringify(acknowledged)],
      );
      return { kind: "acknowledged", discrepancy: clone(acknowledged) };
    });
  }
}
