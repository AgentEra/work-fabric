import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  AUDIT_STORE_REQUIRED_CAPABILITIES,
  createOpaqueCursorCodec,
  normalizePageLimit,
  validateAuditRecord,
  type AuditQuery,
  type AuditRecord,
  type AuditStore,
  type CursorAuthenticator,
  type CursorPage,
  type OpaqueCursorCodec,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface MemoryAuditStoreOptions {
  readonly cursor_secret?: string;
  readonly max_page_limit?: number;
  readonly max_cursor_length?: number;
}

function bounded(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${field} is invalid`);
  }
}

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function cursorAuthenticator(secret: string): CursorAuthenticator {
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

function queryFilters(query: AuditQuery): JsonObject {
  return {
    occurred_from: query.occurred_from ?? null,
    occurred_to: query.occurred_to ?? null,
    principal_id: query.principal_id ?? null,
    operation: query.operation ?? null,
    outcome: query.outcome ?? null,
  };
}

function positionString(position: JsonObject, field: string): string {
  const value = position[field];
  if (typeof value !== "string") throw new TypeError(`cursor ${field} is invalid`);
  return value;
}

export class MemoryAuditStore implements AuditStore {
  readonly manifest = {
    profile: "workfabric.operation-audit.v1",
    adapter: "memory",
    capabilities: Object.fromEntries(
      AUDIT_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
  } as const;

  private readonly records = new Map<string, AuditRecord>();
  private readonly cursor: OpaqueCursorCodec;
  private readonly maxPageLimit: number;

  constructor(options: MemoryAuditStoreOptions = {}) {
    this.maxPageLimit = options.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
    const secret = options.cursor_secret ?? randomBytes(32).toString("base64url");
    bounded(secret, "cursor_secret");
    this.cursor = createOpaqueCursorCodec(cursorAuthenticator(secret), {
      max_length: options.max_cursor_length ?? 2048,
    });
  }

  async append(input: AuditRecord): Promise<void> {
    const record = validateAuditRecord(input);
    const storageKey = JSON.stringify([record.tenant_id, record.audit_id]);
    const existing = this.records.get(storageKey);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, record)) return;
      throw new Error("audit record is immutable and conflicts with first write");
    }
    this.records.set(storageKey, record);
  }

  async list(query: AuditQuery): Promise<CursorPage<AuditRecord>> {
    bounded(query.tenant_id, "tenant_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "audit" as const,
      sort: "occurred_desc_audit_asc",
      filters: queryFilters(query),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    const occurredAt = position === null
      ? null
      : positionString(position, "occurred_at");
    const auditId = position === null ? null : positionString(position, "audit_id");
    const candidates = [...this.records.values()]
      .filter((record) =>
        record.tenant_id === query.tenant_id &&
        (query.occurred_from === undefined || record.occurred_at >= query.occurred_from) &&
        (query.occurred_to === undefined || record.occurred_at <= query.occurred_to) &&
        (query.principal_id === undefined || record.principal_id === query.principal_id) &&
        (query.operation === undefined || record.operation === query.operation) &&
        (query.outcome === undefined || record.outcome === query.outcome) &&
        (occurredAt === null || auditId === null ||
          record.occurred_at < occurredAt ||
          (record.occurred_at === occurredAt && record.audit_id > auditId)),
      )
      .sort((left, right) =>
        right.occurred_at.localeCompare(left.occurred_at) ||
        left.audit_id.localeCompare(right.audit_id),
      );
    const selected = candidates.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: structuredClone(selected),
      next_cursor:
        candidates.length > limit && last !== undefined
          ? await this.cursor.encode({
              ...context,
              position: { occurred_at: last.occurred_at, audit_id: last.audit_id },
            })
          : null,
    };
  }

  async pruneBefore(
    tenantId: string,
    occurredBefore: string,
    limit: number,
  ): Promise<number> {
    bounded(tenantId, "tenantId");
    if (!Number.isFinite(Date.parse(occurredBefore))) {
      throw new TypeError("occurredBefore is invalid");
    }
    positive(limit, "limit");
    if (limit > this.maxPageLimit) throw new TypeError("limit exceeds maximum");
    const removable = [...this.records.entries()]
      .filter(([, record]) =>
        record.tenant_id === tenantId && record.occurred_at < occurredBefore,
      )
      .sort((left, right) =>
        left[1].occurred_at.localeCompare(right[1].occurred_at) ||
        left[1].audit_id.localeCompare(right[1].audit_id),
      )
      .slice(0, limit);
    for (const [storageKey] of removable) this.records.delete(storageKey);
    return removable.length;
  }
}
