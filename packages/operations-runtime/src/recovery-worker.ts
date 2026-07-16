import type {
  RecoveryKind,
  RecoveryRequestClaim,
  RecoveryRequestStore,
} from "@work-fabric/operations-spi";
import {
  observeSemanticSafely,
  RecoveryStoreError,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";
import type { OperationAuditRecorder } from "./audit-recorder.js";

export interface RecoveryActionPort {
  execute(claim: RecoveryRequestClaim): Promise<{ readonly outcome_code: string }>;
}

export type RecoveryActionPorts = Readonly<Record<RecoveryKind, RecoveryActionPort>>;

export interface RecoveryWorkerOptions {
  now(): string;
  readonly audit?: OperationAuditRecorder;
  readonly telemetry?: SemanticTelemetryObserver;
}

export interface RunRecoveryWorker {
  readonly tenant_id: string;
  readonly worker_id: string;
  readonly lease_seconds: number;
  readonly limit: number;
}

export interface RecoveryWorkerResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
}

export class RecoveryWorker {
  constructor(
    private readonly store: RecoveryRequestStore,
    private readonly actions: RecoveryActionPorts,
    private readonly options: RecoveryWorkerOptions,
  ) {}

  async runOnce(input: RunRecoveryWorker): Promise<RecoveryWorkerResult> {
    const claims = await this.store.claim({
      tenant_id: input.tenant_id,
      worker_id: input.worker_id,
      now: this.options.now(),
      lease_seconds: input.lease_seconds,
      limit: input.limit,
    });
    let completed = 0;
    let failed = 0;
    for (const claim of claims) {
      const startedAt = performance.now();
      try {
        const result = await this.actions[claim.target.kind].execute(
          structuredClone(claim),
        );
        await this.store.complete({
          tenant_id: claim.tenant_id,
          recovery_id: claim.recovery_id,
          claim_token: claim.claim_token,
          fencing_token: claim.fencing_token,
          completed_at: this.options.now(),
          outcome_code: result.outcome_code,
        });
        completed += 1;
        await this.audit(claim, "succeeded", null);
        observeSemanticSafely(this.options.telemetry, {
          operation: "recovery_action",
          outcome: "succeeded",
          category: "recovery",
          duration_ms: Math.max(0, performance.now() - startedAt),
          count: 1,
        });
      } catch (error) {
        failed += 1;
        if (error instanceof RecoveryStoreError && error.code === "claim_lost") {
          observeSemanticSafely(this.options.telemetry, {
            operation: "worker_lease_loss",
            outcome: "conflicted",
            category: "recovery",
            duration_ms: Math.max(0, performance.now() - startedAt),
            count: 1,
          });
        }
        try {
          await this.store.fail({
            tenant_id: claim.tenant_id,
            recovery_id: claim.recovery_id,
            claim_token: claim.claim_token,
            fencing_token: claim.fencing_token,
            completed_at: this.options.now(),
            outcome_code: "recovery_failed",
          });
        } catch {
          // A stale worker must never overwrite the current fenced owner.
        }
        await this.audit(claim, "failed", "recovery_failed");
        observeSemanticSafely(this.options.telemetry, {
          operation: "recovery_action",
          outcome: "failed",
          category: "recovery",
          duration_ms: Math.max(0, performance.now() - startedAt),
          count: 1,
        });
      }
    }
    return { claimed: claims.length, completed, failed };
  }

  private async audit(
    claim: RecoveryRequestClaim,
    outcome: "succeeded" | "failed",
    reasonCode: string | null,
  ): Promise<void> {
    if (this.options.audit === undefined) return;
    await this.options.audit.record({
      tenant_id: claim.tenant_id,
      request_id: claim.recovery_id,
      trace_id: null,
      principal_id: claim.requested_by,
      represented_actor: null,
      represented_endpoint_id: null,
      delegation_id: null,
      operation: `workfabric.recovery.${claim.target.kind}.complete.v1`,
      resource_kind: "recovery",
      resource_id: claim.recovery_id,
      authorization_decision: "allowed",
      outcome,
      reason_code: reasonCode,
      service_category: "recovery",
    });
  }
}
