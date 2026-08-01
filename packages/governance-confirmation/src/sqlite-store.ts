import type { DatabaseSync } from "node:sqlite";

import type {
  ConfirmationBinding,
  ConfirmationRecord,
  ConfirmationStore,
} from "./contracts.js";

function record(row: Record<string, unknown>): ConfirmationRecord {
  return {
    tenant_id: String(row.tenant_id),
    human_actor_id: String(row.human_actor_id),
    capability_id: String(row.capability_id),
    document_token: String(row.document_token),
    normalized_input_digest:
      String(row.normalized_input_digest) as `sha256:${string}`,
    challenge_id: String(row.challenge_id),
    challenge_code: String(row.challenge_code),
    phrase: String(row.phrase),
    expires_at: String(row.expires_at),
    proof_reference:
      row.proof_reference === null ? null : String(row.proof_reference),
    confirmed_at: row.confirmed_at === null ? null : String(row.confirmed_at),
    consumed_at: row.consumed_at === null ? null : String(row.consumed_at),
  };
}

export class SqliteConfirmationStore implements ConfirmationStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS work_fabric_confirmation (
        challenge_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        human_actor_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        document_token TEXT NOT NULL,
        normalized_input_digest TEXT NOT NULL,
        challenge_code TEXT NOT NULL,
        phrase TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        proof_reference TEXT UNIQUE,
        confirmed_at TEXT,
        consumed_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS work_fabric_confirmation_pending
      ON work_fabric_confirmation (
        tenant_id, human_actor_id, phrase, expires_at
      );
    `);
  }

  async put(value: ConfirmationRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO work_fabric_confirmation (
        challenge_id, tenant_id, human_actor_id, capability_id,
        document_token, normalized_input_digest, challenge_code, phrase,
        expires_at, proof_reference, confirmed_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.challenge_id,
      value.tenant_id,
      value.human_actor_id,
      value.capability_id,
      value.document_token,
      value.normalized_input_digest,
      value.challenge_code,
      value.phrase,
      value.expires_at,
      value.proof_reference,
      value.confirmed_at,
      value.consumed_at,
    );
  }

  async findPending(
    tenantId: string,
    humanActorId: string,
    phrase: string,
  ): Promise<ConfirmationRecord | null> {
    const row = this.database.prepare(`
      SELECT * FROM work_fabric_confirmation
      WHERE tenant_id = ? AND human_actor_id = ? AND phrase = ?
        AND proof_reference IS NULL AND consumed_at IS NULL
      ORDER BY expires_at DESC
      LIMIT 1
    `).get(tenantId, humanActorId, phrase) as Record<string, unknown> | undefined;
    return row === undefined ? null : record(row);
  }

  async confirm(
    challengeId: string,
    proofReference: string,
    confirmedAt: string,
  ): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE work_fabric_confirmation
      SET proof_reference = ?, confirmed_at = ?
      WHERE challenge_id = ? AND proof_reference IS NULL
    `).run(proofReference, confirmedAt, challengeId);
    return result.changes === 1;
  }

  async consume(
    binding: ConfirmationBinding,
    proofReference: string,
    consumedAt: string,
  ): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE work_fabric_confirmation
      SET consumed_at = ?
      WHERE proof_reference = ?
        AND tenant_id = ?
        AND human_actor_id = ?
        AND capability_id = ?
        AND document_token = ?
        AND normalized_input_digest = ?
        AND confirmed_at IS NOT NULL
        AND consumed_at IS NULL
        AND expires_at > ?
    `).run(
      consumedAt,
      proofReference,
      binding.tenant_id,
      binding.human_actor_id,
      binding.capability_id,
      binding.document_token,
      binding.normalized_input_digest,
      consumedAt,
    );
    return result.changes === 1;
  }
}
