import { DatabaseSync } from "node:sqlite";

import type {
  CalendarBinding,
  CalendarEventOwnership,
  CalendarExecutionRecord,
  FeishuCalendarStore,
} from "./calendar-contracts.js";

export interface SqliteFeishuCalendarStoreOptions {
  readonly location: string;
  readonly busy_timeout_ms?: number;
}

interface JsonRow {
  readonly record_json: string;
}

interface BindingRow extends JsonRow {
  readonly tenant_id: string;
  readonly alias: string;
  readonly resource_uri: string;
  readonly is_default: 0 | 1;
  readonly version: number;
}

interface ExecutionRow extends JsonRow {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input_digest: string;
  readonly state: string;
  readonly version: number;
}

interface EventRow extends JsonRow {
  readonly tenant_id: string;
  readonly event_resource_uri: string;
  readonly create_idempotency_key: string;
}

function timeout(value: number | undefined): number {
  const normalized = value ?? 5_000;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > 60_000
  ) throw new RangeError("busy_timeout_ms must be between 0 and 60000");
  return normalized;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parse<T>(row: JsonRow): T {
  return clone(JSON.parse(row.record_json) as T);
}

function incompatible(): never {
  throw new Error("calendar_record_incompatible");
}

function parseBinding(row: BindingRow): CalendarBinding {
  const value = parse<CalendarBinding>(row);
  if (
    value.tenant_id !== row.tenant_id ||
    value.alias !== row.alias ||
    value.resource_uri !== row.resource_uri ||
    value.is_default !== (row.is_default === 1) ||
    value.version !== row.version
  ) incompatible();
  return value;
}

function parseExecution(row: ExecutionRow): CalendarExecutionRecord {
  const value = parse<CalendarExecutionRecord>(row);
  if (
    value.tenant_id !== row.tenant_id ||
    value.idempotency_key !== row.idempotency_key ||
    value.capability_id !== row.capability_id ||
    value.input_digest !== row.input_digest ||
    value.state !== row.state ||
    value.version !== row.version
  ) incompatible();
  return value;
}

function parseEvent(row: EventRow): CalendarEventOwnership {
  const value = parse<CalendarEventOwnership>(row);
  if (
    value.tenant_id !== row.tenant_id ||
    value.event_resource_uri !== row.event_resource_uri ||
    value.create_idempotency_key !== row.create_idempotency_key
  ) incompatible();
  return value;
}

function bindingConflict(): never {
  throw new Error("calendar_binding_version_conflict");
}

function executionConflict(): never {
  throw new Error("calendar_execution_version_conflict");
}

function eventConflict(): never {
  throw new Error("calendar_event_version_conflict");
}

export class SqliteFeishuCalendarStore implements FeishuCalendarStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: SqliteFeishuCalendarStoreOptions) {
    if (
      typeof options.location !== "string" ||
      options.location.length === 0
    ) throw new TypeError("SQLite location must be non-empty");
    const busyTimeout = timeout(options.busy_timeout_ms);
    this.database = new DatabaseSync(options.location, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeout,
    });
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    if (options.location !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL");
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS feishu_calendar_bindings (
        tenant_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        resource_uri TEXT NOT NULL,
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        PRIMARY KEY (tenant_id, alias),
        UNIQUE (tenant_id, resource_uri)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS
        feishu_calendar_one_default
      ON feishu_calendar_bindings (tenant_id)
      WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS feishu_calendar_executions (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        PRIMARY KEY (tenant_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS feishu_calendar_events (
        tenant_id TEXT NOT NULL,
        event_resource_uri TEXT NOT NULL,
        create_idempotency_key TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        PRIMARY KEY (tenant_id, event_resource_uri),
        UNIQUE (tenant_id, create_idempotency_key)
      ) STRICT;
    `);
  }

  async bind(
    input: Omit<CalendarBinding, "version">,
    expectedVersion: number,
  ): Promise<CalendarBinding> {
    this.open();
    return this.transaction(() => {
      const existing = this.binding(input.tenant_id, input.alias);
      if (existing === null) {
        if (expectedVersion !== 0) bindingConflict();
        const created: CalendarBinding = { ...clone(input), version: 1 };
        try {
          this.database.prepare(`
            INSERT INTO feishu_calendar_bindings (
              tenant_id, alias, resource_uri, is_default, version, record_json
            ) VALUES (?, ?, ?, ?, 1, ?)
          `).run(
            input.tenant_id,
            input.alias,
            input.resource_uri,
            input.is_default ? 1 : 0,
            JSON.stringify(created),
          );
        } catch (error) {
          throw new Error(
            input.is_default
              ? "calendar_default_conflict"
              : "calendar_binding_resource_conflict",
            { cause: error },
          );
        }
        return clone(created);
      }
      const candidate: CalendarBinding = {
        ...clone(input),
        version: existing.version,
      };
      if (expectedVersion === 0 && same(existing, candidate)) {
        return clone(existing);
      }
      if (existing.version !== expectedVersion) bindingConflict();
      const updated: CalendarBinding = {
        ...clone(input),
        created_at: existing.created_at,
        version: existing.version + 1,
      };
      try {
        const result = this.database.prepare(`
          UPDATE feishu_calendar_bindings
          SET resource_uri = ?, is_default = ?, version = ?, record_json = ?
          WHERE tenant_id = ? AND alias = ? AND version = ?
        `).run(
          updated.resource_uri,
          updated.is_default ? 1 : 0,
          updated.version,
          JSON.stringify(updated),
          input.tenant_id,
          input.alias,
          expectedVersion,
        );
        if (result.changes !== 1) bindingConflict();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "calendar_binding_version_conflict"
        ) throw error;
        throw new Error(
          input.is_default
            ? "calendar_default_conflict"
            : "calendar_binding_resource_conflict",
          { cause: error },
        );
      }
      return clone(updated);
    });
  }

  async getBinding(
    tenantId: string,
    alias: string,
  ): Promise<CalendarBinding | null> {
    this.open();
    return this.binding(tenantId, alias);
  }

  async getBindingByResource(
    tenantId: string,
    resourceUri: string,
  ): Promise<CalendarBinding | null> {
    this.open();
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_bindings
      WHERE tenant_id = ? AND resource_uri = ?
    `).get(tenantId, resourceUri) as BindingRow | undefined;
    return row === undefined ? null : parseBinding(row);
  }

  async getDefault(tenantId: string): Promise<CalendarBinding | null> {
    this.open();
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_bindings
      WHERE tenant_id = ? AND is_default = 1
    `).get(tenantId) as BindingRow | undefined;
    if (row === undefined) return null;
    const binding = parseBinding(row);
    return binding.active ? binding : null;
  }

  async listBindings(input: {
    readonly tenant_id: string;
    readonly after_alias?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly CalendarBinding[];
    readonly next_after_alias: string | null;
  }> {
    this.open();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) throw new RangeError("calendar_binding_page_invalid");
    const rows = (
      input.after_alias === undefined
        ? this.database.prepare(`
            SELECT *
            FROM feishu_calendar_bindings
            WHERE tenant_id = ?
            ORDER BY alias ASC
            LIMIT ?
          `).all(input.tenant_id, input.limit + 1)
        : this.database.prepare(`
            SELECT *
            FROM feishu_calendar_bindings
            WHERE tenant_id = ? AND alias > ?
            ORDER BY alias ASC
            LIMIT ?
          `).all(input.tenant_id, input.after_alias, input.limit + 1)
    ) as unknown as readonly BindingRow[];
    const records = rows.map(parseBinding);
    const items = records.slice(0, input.limit);
    return {
      items,
      next_after_alias: records.length > items.length
        ? items.at(-1)!.alias
        : null,
    };
  }

  async setDefault(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly expected_version: number;
    readonly updated_at: string;
  }): Promise<CalendarBinding> {
    this.open();
    return this.transaction(() => {
      const selected = this.binding(input.tenant_id, input.alias);
      if (
        selected === null ||
        selected.version !== input.expected_version
      ) bindingConflict();
      if (selected.is_default) return selected;
      const currentRow = this.database.prepare(`
        SELECT *
        FROM feishu_calendar_bindings
        WHERE tenant_id = ? AND is_default = 1
      `).get(input.tenant_id) as BindingRow | undefined;
      if (currentRow !== undefined) {
        const current = parseBinding(currentRow);
        const cleared: CalendarBinding = {
          ...current,
          is_default: false,
          version: current.version + 1,
          updated_at: input.updated_at,
        };
        this.database.prepare(`
          UPDATE feishu_calendar_bindings
          SET is_default = 0, version = ?, record_json = ?
          WHERE tenant_id = ? AND alias = ? AND version = ?
        `).run(
          cleared.version,
          JSON.stringify(cleared),
          current.tenant_id,
          current.alias,
          current.version,
        );
      }
      const updated: CalendarBinding = {
        ...selected,
        is_default: true,
        version: selected.version + 1,
        updated_at: input.updated_at,
      };
      const result = this.database.prepare(`
        UPDATE feishu_calendar_bindings
        SET is_default = 1, version = ?, record_json = ?
        WHERE tenant_id = ? AND alias = ? AND version = ?
      `).run(
        updated.version,
        JSON.stringify(updated),
        input.tenant_id,
        input.alias,
        input.expected_version,
      );
      if (result.changes !== 1) bindingConflict();
      return clone(updated);
    });
  }

  async beginExecution(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly capability_id: string;
    readonly input_digest: `sha256:${string}`;
    readonly created_at: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: CalendarExecutionRecord;
  }> {
    this.open();
    const existing = this.execution(
      input.tenant_id,
      input.idempotency_key,
    );
    if (existing !== null) {
      if (
        existing.capability_id !== input.capability_id ||
        existing.input_digest !== input.input_digest
      ) throw new Error("calendar_execution_idempotency_conflict");
      return { created: false, record: existing };
    }
    const created: CalendarExecutionRecord = {
      ...clone(input),
      state: "started",
      event_resource_uri: null,
      outcome: null,
      version: 1,
      updated_at: input.created_at,
    };
    try {
      this.database.prepare(`
        INSERT INTO feishu_calendar_executions (
          tenant_id, idempotency_key, capability_id, input_digest,
          state, version, record_json
        ) VALUES (?, ?, ?, ?, 'started', 1, ?)
      `).run(
        input.tenant_id,
        input.idempotency_key,
        input.capability_id,
        input.input_digest,
        JSON.stringify(created),
      );
      return { created: true, record: clone(created) };
    } catch {
      const raced = this.execution(input.tenant_id, input.idempotency_key);
      if (
        raced === null ||
        raced.capability_id !== input.capability_id ||
        raced.input_digest !== input.input_digest
      ) throw new Error("calendar_execution_idempotency_conflict");
      return { created: false, record: raced };
    }
  }

  async checkpoint(
    input: Parameters<FeishuCalendarStore["checkpoint"]>[0],
  ): Promise<CalendarExecutionRecord> {
    this.open();
    return this.transaction(() => {
      const current = this.execution(
        input.tenant_id,
        input.idempotency_key,
      );
      if (
        current === null ||
        current.version !== input.expected_version
      ) executionConflict();
      const updated: CalendarExecutionRecord = {
        ...current,
        state: input.state,
        event_resource_uri: input.event_resource_uri ??
          current.event_resource_uri,
        outcome: input.outcome === undefined
          ? current.outcome
          : clone(input.outcome),
        version: current.version + 1,
        updated_at: input.updated_at,
      };
      const result = this.database.prepare(`
        UPDATE feishu_calendar_executions
        SET state = ?, version = ?, record_json = ?
        WHERE tenant_id = ? AND idempotency_key = ? AND version = ?
      `).run(
        updated.state,
        updated.version,
        JSON.stringify(updated),
        input.tenant_id,
        input.idempotency_key,
        input.expected_version,
      );
      if (result.changes !== 1) executionConflict();
      return clone(updated);
    });
  }

  async getExecution(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CalendarExecutionRecord | null> {
    this.open();
    return this.execution(tenantId, idempotencyKey);
  }

  async putEventOwnership(input: CalendarEventOwnership): Promise<void> {
    this.open();
    const existing = this.event(
      input.tenant_id,
      input.event_resource_uri,
    );
    if (existing !== null) {
      if (!same(existing, input)) {
        throw new Error("calendar_event_ownership_conflict");
      }
      return;
    }
    try {
      this.database.prepare(`
        INSERT INTO feishu_calendar_events (
          tenant_id, event_resource_uri, create_idempotency_key, record_json
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.tenant_id,
        input.event_resource_uri,
        input.create_idempotency_key,
        JSON.stringify(input),
      );
    } catch (error) {
      throw new Error("calendar_event_ownership_conflict", { cause: error });
    }
  }

  async getEventOwnership(
    tenantId: string,
    eventResourceUri: string,
  ): Promise<CalendarEventOwnership | null> {
    this.open();
    return this.event(tenantId, eventResourceUri);
  }

  async getEventOwnershipByCreateKey(
    tenantId: string,
    createIdempotencyKey: string,
  ): Promise<CalendarEventOwnership | null> {
    this.open();
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_events
      WHERE tenant_id = ? AND create_idempotency_key = ?
    `).get(tenantId, createIdempotencyKey) as EventRow | undefined;
    return row === undefined ? null : parseEvent(row);
  }

  async updateEventVersion(
    input: Parameters<FeishuCalendarStore["updateEventVersion"]>[0],
  ): Promise<CalendarEventOwnership> {
    this.open();
    return this.transaction(() => {
      const current = this.event(
        input.tenant_id,
        input.event_resource_uri,
      );
      if (
        current === null ||
        current.provider_version !== input.expected_version ||
        current.deleted_at !== null
      ) eventConflict();
      const updated: CalendarEventOwnership = {
        ...current,
        provider_version: current.provider_version + 1,
        external_updated_at: input.external_updated_at,
      };
      const result = this.database.prepare(`
        UPDATE feishu_calendar_events
        SET record_json = ?
        WHERE tenant_id = ? AND event_resource_uri = ?
          AND json_extract(record_json, '$.provider_version') = ?
      `).run(
        JSON.stringify(updated),
        input.tenant_id,
        input.event_resource_uri,
        input.expected_version,
      );
      if (result.changes !== 1) eventConflict();
      return clone(updated);
    });
  }

  async markEventDeleted(
    input: Parameters<FeishuCalendarStore["markEventDeleted"]>[0],
  ): Promise<CalendarEventOwnership> {
    this.open();
    return this.transaction(() => {
      const current = this.event(
        input.tenant_id,
        input.event_resource_uri,
      );
      if (current === null) eventConflict();
      if (
        current.deleted_at === input.deleted_at &&
        current.provider_version === input.expected_version
      ) return current;
      if (
        current.deleted_at !== null ||
        current.provider_version !== input.expected_version
      ) eventConflict();
      const updated: CalendarEventOwnership = {
        ...current,
        provider_version: current.provider_version + 1,
        deleted_at: input.deleted_at,
      };
      const result = this.database.prepare(`
        UPDATE feishu_calendar_events
        SET record_json = ?
        WHERE tenant_id = ? AND event_resource_uri = ?
          AND json_extract(record_json, '$.provider_version') = ?
      `).run(
        JSON.stringify(updated),
        input.tenant_id,
        input.event_resource_uri,
        input.expected_version,
      );
      if (result.changes !== 1) eventConflict();
      return clone(updated);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private binding(
    tenantId: string,
    alias: string,
  ): CalendarBinding | null {
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_bindings
      WHERE tenant_id = ? AND alias = ?
    `).get(tenantId, alias) as BindingRow | undefined;
    return row === undefined ? null : parseBinding(row);
  }

  private execution(
    tenantId: string,
    idempotencyKey: string,
  ): CalendarExecutionRecord | null {
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_executions
      WHERE tenant_id = ? AND idempotency_key = ?
    `).get(tenantId, idempotencyKey) as ExecutionRow | undefined;
    return row === undefined ? null : parseExecution(row);
  }

  private event(
    tenantId: string,
    eventResourceUri: string,
  ): CalendarEventOwnership | null {
    const row = this.database.prepare(`
      SELECT *
      FROM feishu_calendar_events
      WHERE tenant_id = ? AND event_resource_uri = ?
    `).get(tenantId, eventResourceUri) as EventRow | undefined;
    return row === undefined ? null : parseEvent(row);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private open(): void {
    if (this.closed) throw new Error("Feishu Calendar store is closed");
  }
}
