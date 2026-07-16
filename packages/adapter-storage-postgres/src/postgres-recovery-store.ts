import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { CapabilityManifest } from "@work-fabric/exchange-spi";
import {
  RecoveryStoreError,
  type ClaimRecoveryRequests,
  type CompleteRecoveryRequest,
  type RecoveryRequestClaim,
  type RecoveryRequestRecord,
  type RecoveryRequestStore,
  type RecoveryTarget,
  type SubmitRecoveryRequest,
  type SubmitRecoveryResult,
} from "@work-fabric/operations-spi";
import {
  clone,
  identity,
  json,
  positive,
  run,
  timestamp,
  type SessionFactory,
} from "./postgres-operability-common.js";

const manifest: CapabilityManifest = {
  profile: "workfabric.recovery-request.v1",
  adapter: "postgres",
  capabilities: {
    tenant_isolation: true,
    idempotent_submit: true,
    fenced_claims: true,
    bounded_outcomes: true,
  },
};

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function code(value: unknown, field: string): string {
  const result = identity(value, field, 128);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result) ||
    /(?:bearer|token|secret|password|credential)/i.test(result)
  ) throw new TypeError(`${field} is invalid`);
  return result;
}

function recoveryTarget(input: RecoveryTarget): RecoveryTarget {
  switch (input.kind) {
    case "connector_requeue": return {
      kind: input.kind,
      connector_id: identity(input.connector_id, "connector_id"),
      ingress_id: identity(input.ingress_id, "ingress_id"),
      available_at: timestamp(input.available_at, "available_at"),
    };
    case "delivery_replay": return {
      kind: input.kind,
      subscription_id: identity(input.subscription_id, "subscription_id"),
      partition_id: identity(input.partition_id, "partition_id"),
      event_id: identity(input.event_id, "event_id"),
    };
    case "projection_rebuild": return {
      kind: input.kind,
      projector_id: identity(input.projector_id, "projector_id"),
      partition_id: identity(input.partition_id, "partition_id"),
    };
    case "discrepancy_acknowledge": return {
      kind: input.kind,
      discrepancy_id: identity(input.discrepancy_id, "discrepancy_id"),
    };
    default: throw new TypeError("recovery target kind is invalid");
  }
}

function submit(input: SubmitRecoveryRequest): SubmitRecoveryRequest {
  return {
    tenant_id: identity(input.tenant_id, "tenant_id"),
    recovery_id: identity(input.recovery_id, "recovery_id"),
    idempotency_key: identity(input.idempotency_key, "idempotency_key"),
    requested_by: identity(input.requested_by, "requested_by"),
    requested_at: timestamp(input.requested_at, "requested_at"),
    target: recoveryTarget(input.target),
    expected_version: nonNegative(input.expected_version, "expected_version"),
    reason: code(input.reason, "reason"),
  };
}

function record(input: RecoveryRequestRecord): RecoveryRequestRecord {
  const request = submit(input);
  if (!["pending", "processing", "completed", "failed"].includes(input.state)) {
    throw new TypeError("recovery state is invalid");
  }
  const value: RecoveryRequestRecord = {
    ...request,
    state: input.state,
    version: positive(input.version, "version"),
    attempt: nonNegative(input.attempt, "attempt"),
    outcome_code: input.outcome_code === null ? null : code(input.outcome_code, "outcome_code"),
    completed_at: input.completed_at === null ? null : timestamp(input.completed_at, "completed_at"),
  };
  return value;
}

function intent(input: RecoveryRequestRecord): SubmitRecoveryRequest {
  const value = record(input);
  return {
    tenant_id: value.tenant_id,
    recovery_id: value.recovery_id,
    idempotency_key: value.idempotency_key,
    requested_by: value.requested_by,
    requested_at: value.requested_at,
    target: value.target,
    expected_version: value.expected_version,
    reason: value.reason,
  };
}

function comparable(input: SubmitRecoveryRequest) {
  return {
    tenant_id: input.tenant_id,
    idempotency_key: input.idempotency_key,
    requested_by: input.requested_by,
    target: input.target,
    expected_version: input.expected_version,
    reason: input.reason,
  };
}

function iso(value: unknown, field: string): string {
  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

export class PostgresRecoveryStore implements RecoveryRequestStore {
  readonly manifest = clone(manifest);

  constructor(
    private readonly sessions: SessionFactory,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  async submit(input: SubmitRecoveryRequest): Promise<SubmitRecoveryResult> {
    const request = submit(input);
    if (request.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    return run(this.sessions, this.tenantId, async (client) => {
      for (const lock of [
        `recovery-id:${request.recovery_id}`,
        `recovery-key:${request.idempotency_key}`,
      ].sort()) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
          [this.tenantId, lock],
        );
      }
      const existingResult = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_recovery_requests WHERE tenant_id=$1 AND (idempotency_key=$2 OR recovery_id=$3) ORDER BY recovery_id FOR UPDATE",
        [this.tenantId, request.idempotency_key, request.recovery_id],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = record(json<RecoveryRequestRecord>(existingRow.payload));
        return isDeepStrictEqual(comparable(intent(existing)), comparable(request))
          ? { kind: "replayed", recovery: clone(existing) }
          : { kind: "conflict", recovery_id: existing.recovery_id };
      }
      const created: RecoveryRequestRecord = {
        ...request,
        state: "pending",
        version: 1,
        attempt: 0,
        outcome_code: null,
        completed_at: null,
      };
      await client.query(
        "INSERT INTO work_fabric_recovery_requests (tenant_id,recovery_id,idempotency_key,requested_at,state,version,attempt,payload) VALUES ($1,$2,$3,$4,'pending',1,0,$5::jsonb)",
        [this.tenantId, created.recovery_id, created.idempotency_key, created.requested_at, JSON.stringify(created)],
      );
      return { kind: "accepted", recovery: clone(created) };
    });
  }

  async get(tenantId: string, recoveryId: string): Promise<RecoveryRequestRecord | null> {
    identity(tenantId, "tenantId");
    identity(recoveryId, "recoveryId");
    if (tenantId !== this.tenantId) return null;
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_recovery_requests WHERE tenant_id=$1 AND recovery_id=$2",
        [this.tenantId, recoveryId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const value = record(json<RecoveryRequestRecord>(row.payload));
      if (value.tenant_id !== this.tenantId || value.recovery_id !== recoveryId) {
        throw new Error("recovery request identity mismatch");
      }
      return clone(value);
    });
  }

  async claim(input: ClaimRecoveryRequests): Promise<readonly RecoveryRequestClaim[]> {
    identity(input.tenant_id, "tenant_id");
    identity(input.worker_id, "worker_id");
    timestamp(input.now, "now");
    positive(input.lease_seconds, "lease_seconds");
    positive(input.limit, "limit");
    if (input.lease_seconds > 86_400 || input.limit > 1_000) {
      throw new TypeError("recovery claim bounds are exceeded");
    }
    if (input.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    return run(this.sessions, this.tenantId, async (client) => {
      const selected = await client.query<{ payload: unknown; fencing_token: number | string }>(
        "SELECT payload,fencing_token FROM work_fabric_recovery_requests WHERE tenant_id=$1 AND (state='pending' OR (state='processing' AND lease_expires_at<=$2::timestamptz)) ORDER BY requested_at,recovery_id LIMIT $3 FOR UPDATE SKIP LOCKED",
        [this.tenantId, input.now, input.limit],
      );
      const claims: RecoveryRequestClaim[] = [];
      for (const row of selected.rows) {
        const existing = record(json<RecoveryRequestRecord>(row.payload));
        const fencing = nonNegative(Number(row.fencing_token), "fencing_token") + 1;
        const claimToken = `claim_${randomUUID()}`;
        const leaseExpires = new Date(
          Date.parse(input.now) + input.lease_seconds * 1_000,
        ).toISOString();
        const processing: RecoveryRequestRecord = {
          ...existing,
          state: "processing",
          version: existing.version + 1,
          attempt: existing.attempt + 1,
        };
        await client.query(
          "UPDATE work_fabric_recovery_requests SET state='processing',version=$3,attempt=$4,claim_owner=$5,claim_token=$6,fencing_token=$7,lease_expires_at=$8,payload=$9::jsonb WHERE tenant_id=$1 AND recovery_id=$2",
          [this.tenantId, existing.recovery_id, processing.version, processing.attempt, input.worker_id, claimToken, fencing, leaseExpires, JSON.stringify(processing)],
        );
        claims.push({
          ...clone(processing),
          state: "processing",
          claim_owner: input.worker_id,
          claim_token: claimToken,
          fencing_token: fencing,
          lease_expires_at: leaseExpires,
        });
      }
      return claims;
    });
  }

  complete(input: CompleteRecoveryRequest): Promise<RecoveryRequestRecord> {
    return this.finish(input, "completed");
  }

  fail(input: CompleteRecoveryRequest): Promise<RecoveryRequestRecord> {
    return this.finish(input, "failed");
  }

  private async finish(
    input: CompleteRecoveryRequest,
    state: "completed" | "failed",
  ): Promise<RecoveryRequestRecord> {
    identity(input.tenant_id, "tenant_id");
    identity(input.recovery_id, "recovery_id");
    identity(input.claim_token, "claim_token");
    positive(input.fencing_token, "fencing_token");
    timestamp(input.completed_at, "completed_at");
    const outcome = code(input.outcome_code, "outcome_code");
    if (input.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{
        payload: unknown;
        state: string;
        claim_token: string | null;
        fencing_token: number | string;
        lease_expires_at: unknown;
      }>(
        "SELECT payload,state,claim_token,fencing_token,lease_expires_at FROM work_fabric_recovery_requests WHERE tenant_id=$1 AND recovery_id=$2 FOR UPDATE",
        [this.tenantId, input.recovery_id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new RecoveryStoreError("not_found", "recovery request not found");
      if (row.state !== "processing") throw new RecoveryStoreError("invalid_state", "recovery request is not processing");
      if (
        row.claim_token !== input.claim_token ||
        Number(row.fencing_token) !== input.fencing_token ||
        iso(row.lease_expires_at, "lease_expires_at") < input.completed_at
      ) throw new RecoveryStoreError("claim_lost", "recovery claim is no longer active");
      const existing = record(json<RecoveryRequestRecord>(row.payload));
      const completed: RecoveryRequestRecord = {
        ...existing,
        state,
        version: existing.version + 1,
        outcome_code: outcome,
        completed_at: input.completed_at,
      };
      await client.query(
        "UPDATE work_fabric_recovery_requests SET state=$3,version=$4,outcome_code=$5,completed_at=$6,claim_owner=NULL,claim_token=NULL,lease_expires_at=NULL,payload=$7::jsonb WHERE tenant_id=$1 AND recovery_id=$2",
        [this.tenantId, input.recovery_id, state, completed.version, outcome, input.completed_at, JSON.stringify(completed)],
      );
      return clone(completed);
    });
  }
}
