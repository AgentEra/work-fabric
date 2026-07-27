import { DatabaseSync } from "node:sqlite";

import type {
  FeishuCapabilityExecutionStore,
  FeishuCapabilityOutcome,
  FeishuExecutionRecord,
  FeishuResourceOwnership,
  FeishuResourceOwnershipStore,
} from "./contracts.js";

export interface SqliteFeishuProviderStoreOptions {
  readonly location: string;
  readonly busy_timeout_ms?: number;
}

interface ExecutionRow {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input_digest: `sha256:${string}`;
  readonly outcome_json: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

interface OwnershipRow {
  readonly record_json: string;
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

function executionRecord(row: ExecutionRow): FeishuExecutionRecord {
  return structuredClone({
    tenant_id: row.tenant_id,
    idempotency_key: row.idempotency_key,
    capability_id: row.capability_id,
    input_digest: row.input_digest,
    outcome:
      row.outcome_json === null
        ? null
        : JSON.parse(row.outcome_json) as FeishuCapabilityOutcome,
    created_at: row.created_at,
    completed_at: row.completed_at,
  });
}

export class SqliteFeishuProviderStore
  implements FeishuCapabilityExecutionStore, FeishuResourceOwnershipStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: SqliteFeishuProviderStoreOptions) {
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
      CREATE TABLE IF NOT EXISTS feishu_provider_executions (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (tenant_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_provider_ownership (
        tenant_id TEXT NOT NULL,
        document_token TEXT NOT NULL,
        create_idempotency_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, document_token),
        UNIQUE (tenant_id, create_idempotency_key)
      ) STRICT;
    `);
  }

  async begin(
    input: Omit<FeishuExecutionRecord, "outcome" | "completed_at">,
  ): Promise<{
    readonly created: boolean;
    readonly record: FeishuExecutionRecord;
  }> {
    this.open();
    const existing = this.execution(input.tenant_id, input.idempotency_key);
    if (existing !== undefined) {
      if (
        existing.capability_id !== input.capability_id ||
        existing.input_digest !== input.input_digest
      ) throw new Error("Feishu Provider idempotency conflict");
      return { created: false, record: executionRecord(existing) };
    }
    this.database.prepare(`
      INSERT INTO feishu_provider_executions (
        tenant_id, idempotency_key, capability_id, input_digest,
        outcome_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL)
    `).run(
      input.tenant_id,
      input.idempotency_key,
      input.capability_id,
      input.input_digest,
      input.created_at,
    );
    const created = this.execution(input.tenant_id, input.idempotency_key);
    if (created === undefined) throw new Error("Execution insert failed");
    return { created: true, record: executionRecord(created) };
  }

  async complete(
    tenantId: string,
    idempotencyKey: string,
    outcome: FeishuCapabilityOutcome,
    completedAt: string,
  ): Promise<void> {
    this.open();
    const serialized = JSON.stringify(outcome);
    const result = this.database.prepare(`
      UPDATE feishu_provider_executions
      SET outcome_json = ?, completed_at = ?
      WHERE tenant_id = ? AND idempotency_key = ? AND outcome_json IS NULL
    `).run(serialized, completedAt, tenantId, idempotencyKey);
    if (result.changes === 1) return;
    const current = this.execution(tenantId, idempotencyKey);
    if (current === undefined) throw new Error("Execution record not found");
    if (current.outcome_json !== serialized) {
      throw new Error("Execution outcome conflict");
    }
  }

  async putOwnership(input: FeishuResourceOwnership): Promise<void> {
    this.open();
    const existing = await this.getOwnership(
      input.tenant_id,
      input.document_token,
    );
    if (existing !== null) {
      if (existing.create_idempotency_key !== input.create_idempotency_key) {
        throw new Error("Feishu document ownership conflict");
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO feishu_provider_ownership (
        tenant_id, document_token, create_idempotency_key, record_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      input.tenant_id,
      input.document_token,
      input.create_idempotency_key,
      JSON.stringify(input),
    );
  }

  async getOwnership(
    tenantId: string,
    documentToken: string,
  ): Promise<FeishuResourceOwnership | null> {
    this.open();
    const row = this.database.prepare(`
      SELECT record_json
      FROM feishu_provider_ownership
      WHERE tenant_id = ? AND document_token = ?
    `).get(tenantId, documentToken) as OwnershipRow | undefined;
    return row === undefined
      ? null
      : structuredClone(JSON.parse(row.record_json) as FeishuResourceOwnership);
  }

  async updateRevision(
    tenantId: string,
    documentToken: string,
    revision: string,
  ): Promise<void> {
    const current = await this.getOwnership(tenantId, documentToken);
    if (current === null) return;
    this.database.prepare(`
      UPDATE feishu_provider_ownership
      SET record_json = ?
      WHERE tenant_id = ? AND document_token = ?
    `).run(
      JSON.stringify({ ...current, last_known_revision: revision }),
      tenantId,
      documentToken,
    );
  }

  async markDeleted(
    tenantId: string,
    documentToken: string,
    deletedAt: string,
  ): Promise<void> {
    const current = await this.getOwnership(tenantId, documentToken);
    if (current === null) throw new Error("Ownership record not found");
    this.database.prepare(`
      UPDATE feishu_provider_ownership
      SET record_json = ?
      WHERE tenant_id = ? AND document_token = ?
    `).run(
      JSON.stringify({ ...current, deleted_at: deletedAt }),
      tenantId,
      documentToken,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private execution(
    tenantId: string,
    idempotencyKey: string,
  ): ExecutionRow | undefined {
    return this.database.prepare(`
      SELECT *
      FROM feishu_provider_executions
      WHERE tenant_id = ? AND idempotency_key = ?
    `).get(tenantId, idempotencyKey) as ExecutionRow | undefined;
  }

  private open(): void {
    if (this.closed) throw new Error("Feishu Provider store is closed");
  }
}
