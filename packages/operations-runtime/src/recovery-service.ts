import { createHash } from "node:crypto";

import type {
  RecoveryRequestStore,
  RecoveryTarget,
  SubmitRecoveryResult,
} from "@work-fabric/operations-spi";
import type { OperationAuditRecorder } from "./audit-recorder.js";

export interface RecoveryRequestInput {
  readonly request_id: string;
  readonly trace_id: string | null;
  readonly idempotency_key: string;
  readonly target: RecoveryTarget;
  readonly expected_version: number;
  readonly reason: string;
}

export interface RecoveryServiceOptions {
  now(): string;
  readonly audit?: OperationAuditRecorder;
}

function recoveryId(tenantId: string, idempotencyKey: string): string {
  return `recovery_${createHash("sha256")
    .update(JSON.stringify([tenantId, idempotencyKey]))
    .digest("base64url")}`;
}

export class RecoveryService {
  constructor(
    private readonly store: RecoveryRequestStore,
    private readonly options: RecoveryServiceOptions,
  ) {}

  async request(
    tenantId: string,
    principalId: string,
    input: RecoveryRequestInput,
  ): Promise<SubmitRecoveryResult> {
    const id = recoveryId(tenantId, input.idempotency_key);
    const result = await this.store.submit({
      tenant_id: tenantId,
      recovery_id: id,
      idempotency_key: input.idempotency_key,
      requested_by: principalId,
      requested_at: this.options.now(),
      target: structuredClone(input.target),
      expected_version: input.expected_version,
      reason: input.reason,
    });
    if (this.options.audit !== undefined) {
      await this.options.audit.record({
        tenant_id: tenantId,
        request_id: input.request_id,
        trace_id: input.trace_id,
        principal_id: principalId,
        represented_actor: null,
        represented_endpoint_id: null,
        delegation_id: null,
        operation: `workfabric.recovery.${input.target.kind}.request.v1`,
        resource_kind: "recovery",
        resource_id: result.kind === "conflict" ? result.recovery_id : result.recovery.recovery_id,
        authorization_decision: "allowed",
        outcome: result.kind === "conflict" ? "conflicted" : "succeeded",
        reason_code: result.kind === "conflict" ? "recovery_conflict" : null,
        service_category: "recovery",
      });
    }
    return structuredClone(result);
  }

  get(tenantId: string, recoveryId: string) {
    return this.store.get(tenantId, recoveryId);
  }
}
