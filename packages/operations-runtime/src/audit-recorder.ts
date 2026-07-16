import { createHash } from "node:crypto";

import {
  validateAuditRecord,
  type AuditOutcome,
  type AuditRecord,
  type AuditServiceCategory,
  type AuditStore,
  type AuthorizationDecision,
  type ParticipantRef,
} from "@work-fabric/operations-spi";

export interface AuditRecorderClock {
  now(): string;
}

export interface AuditRecorderOptions extends AuditRecorderClock {
  readonly max_recent_records?: number;
}

export interface OperationAuditInput {
  readonly tenant_id: string;
  readonly request_id: string;
  readonly trace_id: string | null;
  readonly principal_id: string;
  readonly represented_actor: ParticipantRef | null;
  readonly represented_endpoint_id: string | null;
  readonly delegation_id: string | null;
  readonly operation: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly authorization_decision: AuthorizationDecision;
  readonly outcome: AuditOutcome;
  readonly reason_code: string | null;
  readonly service_category: AuditServiceCategory;
}

export type HttpAuthorizationAuditInput = Omit<
  OperationAuditInput,
  "request_id" | "outcome" | "reason_code" | "service_category"
>;

export interface AuditRecorderStatus {
  readonly healthy: boolean;
  readonly failed_writes: number;
  readonly last_failure_at: string | null;
}

interface StagedHttpAudit {
  readonly input: HttpAuthorizationAuditInput;
  readonly occurred_at: string;
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function auditId(input: Pick<
  OperationAuditInput,
  "tenant_id" | "request_id" | "operation" | "resource_kind" | "resource_id"
>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.tenant_id,
      input.request_id,
      input.operation,
      input.resource_kind,
      input.resource_id,
    ]))
    .digest("base64url");
  return `audit_${digest}`;
}

function httpResult(statusCode: number): {
  readonly outcome: AuditOutcome;
  readonly reason_code: string | null;
} {
  const outcome = statusCode >= 200 && statusCode < 400
    ? "succeeded"
    : statusCode === 404
      ? "not_found"
      : statusCode === 409
        ? "conflicted"
        : "failed";
  return {
    outcome,
    reason_code: outcome === "succeeded" ? null : `http_${statusCode}`,
  };
}

export class OperationAuditRecorder {
  private readonly stagedHttp = new Map<string, StagedHttpAudit>();
  private readonly occurredAtByAuditId = new Map<string, string>();
  private readonly maxRecentRecords: number;
  private failedWrites = 0;
  private lastFailureAt: string | null = null;

  constructor(
    private readonly store: AuditStore,
    private readonly options: AuditRecorderOptions = {
      now: () => new Date().toISOString(),
    },
  ) {
    this.maxRecentRecords = positive(
      options.max_recent_records ?? 10_000,
      "max_recent_records",
    );
  }

  status(): AuditRecorderStatus {
    return {
      healthy: this.lastFailureAt === null,
      failed_writes: this.failedWrites,
      last_failure_at: this.lastFailureAt,
    };
  }

  stageHttp(requestId: string, input: HttpAuthorizationAuditInput): boolean {
    try {
      const occurredAt = this.options.now();
      validateAuditRecord(this.buildRecord({
        ...input,
        request_id: requestId,
        outcome: "succeeded",
        reason_code: null,
        service_category: "http",
      }, occurredAt));
      if (!this.stagedHttp.has(requestId)) {
        this.stagedHttp.set(requestId, {
          input: structuredClone(input),
          occurred_at: occurredAt,
        });
        while (this.stagedHttp.size > this.maxRecentRecords) {
          const oldest = this.stagedHttp.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.stagedHttp.delete(oldest);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async completeHttp(requestId: string, statusCode: number): Promise<boolean> {
    const staged = this.stagedHttp.get(requestId);
    if (staged === undefined) return false;
    this.stagedHttp.delete(requestId);
    if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      return false;
    }
    const result = httpResult(statusCode);
    return this.record(
      {
        ...staged.input,
        request_id: requestId,
        ...result,
        service_category: "http",
      },
      staged.occurred_at,
    );
  }

  async record(input: OperationAuditInput, occurredAt?: string): Promise<boolean> {
    let record: AuditRecord;
    try {
      const id = auditId(input);
      const stableOccurredAt = occurredAt ??
        this.occurredAtByAuditId.get(id) ?? this.options.now();
      this.remember(id, stableOccurredAt);
      record = validateAuditRecord(this.buildRecord(input, stableOccurredAt));
    } catch {
      return false;
    }
    try {
      await this.store.append(record);
      this.lastFailureAt = null;
      return true;
    } catch {
      this.failedWrites += 1;
      this.lastFailureAt = this.options.now();
      return false;
    }
  }

  private buildRecord(input: OperationAuditInput, occurredAt: string): AuditRecord {
    return {
      tenant_id: input.tenant_id,
      audit_id: auditId(input),
      occurred_at: occurredAt,
      request_id: input.request_id,
      trace_id: input.trace_id,
      principal_id: input.principal_id,
      represented_actor: input.represented_actor,
      represented_endpoint_id: input.represented_endpoint_id,
      delegation_id: input.delegation_id,
      operation: input.operation,
      resource_kind: input.resource_kind,
      resource_id: input.resource_id,
      authorization_decision: input.authorization_decision,
      outcome: input.outcome,
      reason_code: input.reason_code,
      service_category: input.service_category,
    };
  }

  private remember(id: string, occurredAt: string): void {
    if (this.occurredAtByAuditId.has(id)) return;
    this.occurredAtByAuditId.set(id, occurredAt);
    while (this.occurredAtByAuditId.size > this.maxRecentRecords) {
      const oldest = this.occurredAtByAuditId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.occurredAtByAuditId.delete(oldest);
    }
  }
}
