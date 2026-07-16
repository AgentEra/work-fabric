import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  createOpaqueCursorCodec,
  normalizePageLimit,
  type CursorAuthenticator,
  type OpaqueCursorCodec,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface MemoryDiscrepancyStoreOptions {
  readonly cursor_secret?: string;
  readonly max_page_limit?: number;
  readonly max_cursor_length?: number;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function timestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} is invalid`);
  return value;
}

function nullable(value: string | null, field: string): string | null {
  return value === null ? null : identifier(value, field);
}

function reason(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.trim() !== value || /(?:bearer|token|secret|password|credential)/i.test(value)
  ) throw new TypeError("acknowledgement reason is invalid");
  return value;
}

function validate(input: ConnectorDiscrepancy): ConnectorDiscrepancy {
  const value = structuredClone(input);
  identifier(value.discrepancy_id, "discrepancy_id");
  identifier(value.tenant_id, "tenant_id");
  identifier(value.connector_id, "connector_id");
  identifier(value.external_object_id, "external_object_id");
  nullable(value.resource_id, "resource_id");
  nullable(value.expected_state, "expected_state");
  if (value.expected_version !== null) positive(value.expected_version, "expected_version");
  identifier(value.observed_state, "observed_state");
  timestamp(value.observed_at, "observed_at");
  assertSafeOperationsJson(value.metadata, "discrepancy metadata");
  if (value.status !== "open" && value.status !== "acknowledged") {
    throw new TypeError("discrepancy status is invalid");
  }
  positive(value.version, "version");
  nullable(value.acknowledged_at, "acknowledged_at");
  nullable(value.acknowledged_by, "acknowledged_by");
  if (value.acknowledgement_reason !== null) reason(value.acknowledgement_reason);
  if (
    value.status === "open" &&
    (value.version !== 1 || value.acknowledged_at !== null ||
      value.acknowledged_by !== null || value.acknowledgement_reason !== null)
  ) throw new TypeError("open discrepancy acknowledgement state is invalid");
  if (
    value.status === "acknowledged" &&
    (value.acknowledged_at === null || value.acknowledged_by === null ||
      value.acknowledgement_reason === null)
  ) throw new TypeError("acknowledged discrepancy state is invalid");
  return value;
}

function authenticator(secret: string): CursorAuthenticator {
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    async sign(payload) { return sign(payload); },
    async verify(payload, signature) {
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}

function key(tenantId: string, discrepancyId: string): string {
  return JSON.stringify([tenantId, discrepancyId]);
}

export class MemoryDiscrepancyStore implements ConnectorDiscrepancyStore {
  private readonly records = new Map<string, ConnectorDiscrepancy>();
  private readonly cursor: OpaqueCursorCodec;
  private readonly maxPageLimit: number;

  constructor(options: MemoryDiscrepancyStoreOptions = {}) {
    this.maxPageLimit = options.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
    const secret = options.cursor_secret ?? randomBytes(32).toString("base64url");
    identifier(secret, "cursor_secret");
    this.cursor = createOpaqueCursorCodec(authenticator(secret), {
      max_length: options.max_cursor_length ?? 2048,
    });
  }

  async put(input: ConnectorDiscrepancy): Promise<void> {
    const record = validate(input);
    const storageKey = key(record.tenant_id, record.discrepancy_id);
    const existing = this.records.get(storageKey);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, record)) return;
      throw new Error("discrepancy conflicts with first write");
    }
    this.records.set(storageKey, record);
  }

  async get(tenantId: string, discrepancyId: string): Promise<ConnectorDiscrepancy | null> {
    identifier(tenantId, "tenantId");
    identifier(discrepancyId, "discrepancyId");
    const record = this.records.get(key(tenantId, discrepancyId));
    return record === undefined ? null : structuredClone(record);
  }

  async list(input: ListConnectorDiscrepancies): Promise<ConnectorDiscrepancyPage> {
    identifier(input.tenant_id, "tenant_id");
    if (input.connector_id !== undefined) identifier(input.connector_id, "connector_id");
    if (input.statuses !== undefined && (
      input.statuses.length === 0 ||
      input.statuses.some((status) => status !== "open" && status !== "acknowledged")
    )) throw new TypeError("statuses are invalid");
    const limit = normalizePageLimit(input.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const filters: JsonObject = {
      connector_id: input.connector_id ?? null,
      statuses: input.statuses === undefined ? null : [...new Set(input.statuses)].sort(),
    };
    const context = {
      kind: "operations" as const,
      sort: "discrepancy_observed_desc_id_asc",
      filters,
    };
    const position = input.cursor === undefined
      ? null
      : await this.cursor.decode(input.cursor, context);
    const observedAt = position?.observed_at;
    const discrepancyId = position?.discrepancy_id;
    if (position !== null && (
      typeof observedAt !== "string" || typeof discrepancyId !== "string"
    )) throw new TypeError("cursor position is invalid");
    const cursorObservedAt = position === null ? null : observedAt as string;
    const cursorDiscrepancyId = position === null ? null : discrepancyId as string;
    const candidates = [...this.records.values()]
      .filter((record) =>
        record.tenant_id === input.tenant_id &&
        (input.connector_id === undefined || record.connector_id === input.connector_id) &&
        (input.statuses === undefined || input.statuses.includes(record.status)) &&
        (cursorObservedAt === null || cursorDiscrepancyId === null ||
          record.observed_at < cursorObservedAt ||
          (record.observed_at === cursorObservedAt &&
            record.discrepancy_id > cursorDiscrepancyId))
      )
      .sort((left, right) =>
        right.observed_at.localeCompare(left.observed_at) ||
        left.discrepancy_id.localeCompare(right.discrepancy_id),
      );
    const items = candidates.slice(0, limit);
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      next_cursor: candidates.length > limit && last !== undefined
        ? await this.cursor.encode({
            ...context,
            position: {
              observed_at: last.observed_at,
              discrepancy_id: last.discrepancy_id,
            },
          })
        : null,
    };
  }

  async acknowledge(
    input: AcknowledgeConnectorDiscrepancy,
  ): Promise<AcknowledgeDiscrepancyResult> {
    identifier(input.tenant_id, "tenant_id");
    identifier(input.discrepancy_id, "discrepancy_id");
    positive(input.expected_version, "expected_version");
    timestamp(input.acknowledged_at, "acknowledged_at");
    identifier(input.acknowledged_by, "acknowledged_by");
    reason(input.reason);
    const storageKey = key(input.tenant_id, input.discrepancy_id);
    const existing = this.records.get(storageKey);
    if (existing === undefined) return { kind: "not_found" };
    if (
      existing.status === "acknowledged" &&
      input.expected_version + 1 === existing.version &&
      existing.acknowledged_at === input.acknowledged_at &&
      existing.acknowledged_by === input.acknowledged_by &&
      existing.acknowledgement_reason === input.reason
    ) return { kind: "replayed", discrepancy: structuredClone(existing) };
    if (existing.version !== input.expected_version || existing.status !== "open") {
      return { kind: "conflict", current_version: existing.version };
    }
    const acknowledged = validate({
      ...existing,
      status: "acknowledged",
      version: existing.version + 1,
      acknowledged_at: input.acknowledged_at,
      acknowledged_by: input.acknowledged_by,
      acknowledgement_reason: input.reason,
    });
    this.records.set(storageKey, acknowledged);
    return { kind: "acknowledged", discrepancy: structuredClone(acknowledged) };
  }
}
