import { isDeepStrictEqual } from "node:util";
import type { SqliteSession } from "@work-fabric/adapter-storage-sqlite";
import {
  DebugChannelStoreError,
  assertDebugCapture,
  assertDebugSubmission,
  assertListDebugCaptures,
  assertPruneExpiredDebugRecords,
  debugChannelStoreManifest,
  type AppendDebugCapture,
  type CreateDebugSubmission,
  type CreateDebugSubmissionResult,
  type DebugCapture,
  type DebugCapturePage,
  type DebugCaptureScope,
  type DebugChannelStore,
  type DebugSubmission,
  type DebugSubmissionScope,
  type LinkDebugHandoff,
  type LinkDebugIngress,
  type ListDebugCaptures,
  type PruneExpiredDebugRecords,
} from "@work-fabric/debug-channel-spi";

function parseSubmission(payload: string): DebugSubmission {
  const value = JSON.parse(payload) as unknown;
  assertDebugSubmission(value);
  return value;
}

function parseCapture(payload: string): DebugCapture {
  const value = JSON.parse(payload) as unknown;
  assertDebugCapture(value);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SqliteDebugChannelStore implements DebugChannelStore {
  readonly manifest = debugChannelStoreManifest("sqlite");
  constructor(private readonly session: SqliteSession) {}

  async createSubmission(
    input: CreateDebugSubmission,
  ): Promise<CreateDebugSubmissionResult> {
    assertDebugSubmission(input.submission);
    const candidate = clone(input.submission);
    return this.session.transaction(() => {
      const byIdentity = this.session.prepare(`
        SELECT payload
        FROM work_fabric_debug_submissions
        WHERE tenant_id=? AND plugin_instance_id=?
          AND conversation_id=? AND idempotency_key=?
      `).get(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.conversation_id,
        candidate.idempotency_key,
      ) as { payload: string } | undefined;
      if (byIdentity !== undefined) {
        const existing = parseSubmission(byIdentity.payload);
        return {
          kind: existing.request_digest === candidate.request_digest
            ? "existing"
            : "conflict",
          submission: clone(existing),
        };
      }
      const byScope = this.session.prepare(`
        SELECT payload
        FROM work_fabric_debug_submissions
        WHERE tenant_id=? AND plugin_instance_id=? AND submission_id=?
      `).get(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.submission_id,
      ) as { payload: string } | undefined;
      if (byScope !== undefined) {
        return {
          kind: "conflict",
          submission: clone(parseSubmission(byScope.payload)),
        };
      }
      this.session.prepare(`
        INSERT INTO work_fabric_debug_submissions
          (tenant_id,plugin_instance_id,submission_id,conversation_id,
           idempotency_key,request_digest,expires_at,payload)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.submission_id,
        candidate.conversation_id,
        candidate.idempotency_key,
        candidate.request_digest,
        candidate.expires_at,
        JSON.stringify(candidate),
      );
      return { kind: "created", submission: clone(candidate) };
    });
  }

  async linkIngress(input: LinkDebugIngress): Promise<DebugSubmission> {
    return this.link(input, "ingress_id", "ingress_conflict");
  }

  async linkHandoff(input: LinkDebugHandoff): Promise<DebugSubmission> {
    return this.link(input, "handoff_id", "handoff_conflict");
  }

  async getSubmission(
    scope: DebugSubmissionScope,
  ): Promise<DebugSubmission | null> {
    const row = this.session.prepare(`
      SELECT payload
      FROM work_fabric_debug_submissions
      WHERE tenant_id=? AND plugin_instance_id=? AND submission_id=?
    `).get(
      scope.tenant_id,
      scope.plugin_instance_id,
      scope.submission_id,
    ) as { payload: string } | undefined;
    return row === undefined ? null : clone(parseSubmission(row.payload));
  }

  async appendCapture(input: AppendDebugCapture): Promise<{
    readonly kind: "created" | "existing";
    readonly capture: DebugCapture;
  }> {
    assertDebugCapture(input.capture);
    const candidate = clone(input.capture);
    return this.session.transaction(() => {
      const byIdentity = this.session.prepare(`
        SELECT payload
        FROM work_fabric_debug_captures
        WHERE tenant_id=? AND plugin_instance_id=?
          AND event_id=? AND destination_id=?
      `).get(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.event_id,
        candidate.destination_id,
      ) as { payload: string } | undefined;
      if (byIdentity !== undefined) {
        const existing = parseCapture(byIdentity.payload);
        if (!isDeepStrictEqual(existing, candidate)) {
          throw new DebugChannelStoreError("capture_conflict");
        }
        return { kind: "existing", capture: clone(existing) };
      }
      const byScope = this.session.prepare(`
        SELECT payload
        FROM work_fabric_debug_captures
        WHERE tenant_id=? AND plugin_instance_id=? AND capture_id=?
      `).get(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.capture_id,
      ) as { payload: string } | undefined;
      if (byScope !== undefined) {
        const existing = parseCapture(byScope.payload);
        if (!isDeepStrictEqual(existing, candidate)) {
          throw new DebugChannelStoreError("capture_conflict");
        }
        return { kind: "existing", capture: clone(existing) };
      }
      this.session.prepare(`
        INSERT INTO work_fabric_debug_captures
          (tenant_id,plugin_instance_id,capture_id,conversation_id,event_id,
           destination_id,captured_at,expires_at,payload)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        candidate.tenant_id,
        candidate.plugin_instance_id,
        candidate.capture_id,
        candidate.conversation_id,
        candidate.event_id,
        candidate.destination_id,
        candidate.captured_at,
        candidate.expires_at,
        JSON.stringify(candidate),
      );
      return { kind: "created", capture: clone(candidate) };
    });
  }

  async getCapture(scope: DebugCaptureScope): Promise<DebugCapture | null> {
    const row = this.session.prepare(`
      SELECT payload
      FROM work_fabric_debug_captures
      WHERE tenant_id=? AND plugin_instance_id=? AND capture_id=?
    `).get(
      scope.tenant_id,
      scope.plugin_instance_id,
      scope.capture_id,
    ) as { payload: string } | undefined;
    return row === undefined ? null : clone(parseCapture(row.payload));
  }

  async listCaptures(query: ListDebugCaptures): Promise<DebugCapturePage> {
    assertListDebugCaptures(query);
    const rows = query.after_captured_at === undefined
      ? this.session.prepare(`
          SELECT payload
          FROM work_fabric_debug_captures
          WHERE tenant_id=? AND plugin_instance_id=? AND conversation_id=?
          ORDER BY captured_at,capture_id
          LIMIT ?
        `).all(
          query.tenant_id,
          query.plugin_instance_id,
          query.conversation_id,
          query.limit,
        )
      : this.session.prepare(`
          SELECT payload
          FROM work_fabric_debug_captures
          WHERE tenant_id=? AND plugin_instance_id=? AND conversation_id=?
            AND (captured_at>? OR (captured_at=? AND capture_id>?))
          ORDER BY captured_at,capture_id
          LIMIT ?
        `).all(
          query.tenant_id,
          query.plugin_instance_id,
          query.conversation_id,
          query.after_captured_at,
          query.after_captured_at,
          query.after_capture_id!,
          query.limit,
        );
    return {
      items: (rows as unknown as Array<{ payload: string }>)
        .map((row) => clone(parseCapture(row.payload))),
    };
  }

  async pruneExpired(input: PruneExpiredDebugRecords): Promise<{
    readonly submissions: number;
    readonly captures: number;
  }> {
    assertPruneExpiredDebugRecords(input);
    return this.session.transaction(() => {
      const captureRows = this.session.prepare(`
        SELECT capture_id
        FROM work_fabric_debug_captures
        WHERE tenant_id=? AND plugin_instance_id=? AND expires_at<=?
        ORDER BY expires_at,capture_id
        LIMIT ?
      `).all(
        input.tenant_id,
        input.plugin_instance_id,
        input.now,
        input.limit,
      ) as unknown as Array<{ capture_id: string }>;
      for (const row of captureRows) {
        this.session.prepare(`
          DELETE FROM work_fabric_debug_captures
          WHERE tenant_id=? AND plugin_instance_id=? AND capture_id=?
        `).run(input.tenant_id, input.plugin_instance_id, row.capture_id);
      }
      const remaining = input.limit - captureRows.length;
      const submissionRows = remaining === 0
        ? []
        : this.session.prepare(`
            SELECT submission_id
            FROM work_fabric_debug_submissions
            WHERE tenant_id=? AND plugin_instance_id=? AND expires_at<=?
            ORDER BY expires_at,submission_id
            LIMIT ?
          `).all(
            input.tenant_id,
            input.plugin_instance_id,
            input.now,
            remaining,
          ) as unknown as Array<{ submission_id: string }>;
      for (const row of submissionRows) {
        this.session.prepare(`
          DELETE FROM work_fabric_debug_submissions
          WHERE tenant_id=? AND plugin_instance_id=? AND submission_id=?
        `).run(input.tenant_id, input.plugin_instance_id, row.submission_id);
      }
      return {
        submissions: submissionRows.length,
        captures: captureRows.length,
      };
    });
  }

  private async link(
    input: LinkDebugIngress | LinkDebugHandoff,
    field: "ingress_id" | "handoff_id",
    conflict: "ingress_conflict" | "handoff_conflict",
  ): Promise<DebugSubmission> {
    return this.session.transaction(() => {
      const row = this.session.prepare(`
        SELECT payload
        FROM work_fabric_debug_submissions
        WHERE tenant_id=? AND plugin_instance_id=? AND submission_id=?
      `).get(
        input.tenant_id,
        input.plugin_instance_id,
        input.submission_id,
      ) as { payload: string } | undefined;
      if (row === undefined) {
        throw new DebugChannelStoreError("submission_not_found");
      }
      const current = parseSubmission(row.payload);
      const value = field === "ingress_id"
        ? (input as LinkDebugIngress).ingress_id
        : (input as LinkDebugHandoff).handoff_id;
      if (current[field] !== undefined) {
        if (current[field] !== value) throw new DebugChannelStoreError(conflict);
        return clone(current);
      }
      const candidate = { ...current, [field]: value, updated_at: input.updated_at };
      assertDebugSubmission(candidate);
      const result = this.session.prepare(`
        UPDATE work_fabric_debug_submissions
        SET payload=?
        WHERE tenant_id=? AND plugin_instance_id=? AND submission_id=?
      `).run(
        JSON.stringify(candidate),
        input.tenant_id,
        input.plugin_instance_id,
        input.submission_id,
      );
      if (result.changes !== 1) {
        throw new DebugChannelStoreError("submission_not_found");
      }
      return clone(candidate);
    });
  }
}
