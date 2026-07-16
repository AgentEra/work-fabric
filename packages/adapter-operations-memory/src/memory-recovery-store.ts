import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

interface ActiveClaim {
  readonly owner: string;
  readonly token: string;
  readonly fencing: number;
  readonly lease_expires_at: string;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

function boundedCode(value: unknown, field: string): string {
  const code = identifier(value, field);
  if (
    code.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(code) ||
    /(?:bearer|token|secret|password|credential)/i.test(code)
  ) throw new TypeError(`${field} is invalid`);
  return code;
}

function timestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} is invalid`);
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function target(input: RecoveryTarget): RecoveryTarget {
  const value = structuredClone(input);
  switch (value.kind) {
    case "connector_requeue": return {
      kind: value.kind,
      connector_id: identifier(value.connector_id, "connector_id"),
      ingress_id: identifier(value.ingress_id, "ingress_id"),
      available_at: timestamp(value.available_at, "available_at"),
    };
    case "delivery_replay": return {
      kind: value.kind,
      subscription_id: identifier(value.subscription_id, "subscription_id"),
      partition_id: identifier(value.partition_id, "partition_id"),
      event_id: identifier(value.event_id, "event_id"),
    };
    case "projection_rebuild": return {
      kind: value.kind,
      projector_id: identifier(value.projector_id, "projector_id"),
      partition_id: identifier(value.partition_id, "partition_id"),
    };
    case "discrepancy_acknowledge": return {
      kind: value.kind,
      discrepancy_id: identifier(value.discrepancy_id, "discrepancy_id"),
    };
    default:
      throw new TypeError("recovery target kind is invalid");
  }
}

function validateSubmit(input: SubmitRecoveryRequest): SubmitRecoveryRequest {
  return {
    tenant_id: identifier(input.tenant_id, "tenant_id"),
    recovery_id: identifier(input.recovery_id, "recovery_id"),
    idempotency_key: identifier(input.idempotency_key, "idempotency_key"),
    requested_by: identifier(input.requested_by, "requested_by"),
    requested_at: timestamp(input.requested_at, "requested_at"),
    target: target(input.target),
    expected_version: nonNegative(input.expected_version, "expected_version"),
    reason: boundedCode(input.reason, "reason"),
  };
}

function intent(record: RecoveryRequestRecord): SubmitRecoveryRequest {
  return {
    tenant_id: record.tenant_id,
    recovery_id: record.recovery_id,
    idempotency_key: record.idempotency_key,
    requested_by: record.requested_by,
    requested_at: record.requested_at,
    target: structuredClone(record.target),
    expected_version: record.expected_version,
    reason: record.reason,
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

function key(tenantId: string, id: string): string {
  return JSON.stringify([tenantId, id]);
}

export class MemoryRecoveryStore implements RecoveryRequestStore {
  readonly manifest = {
    profile: "workfabric.recovery-request.v1",
    adapter: "memory",
    capabilities: {
      tenant_isolation: true,
      idempotent_submit: true,
      fenced_claims: true,
      bounded_outcomes: true,
    },
  } as const;

  private readonly records = new Map<string, RecoveryRequestRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly claims = new Map<string, ActiveClaim>();
  private readonly fencing = new Map<string, number>();
  private readonly claimTokenFactory: () => string;

  constructor(options: { readonly claim_token_factory?: () => string } = {}) {
    this.claimTokenFactory = options.claim_token_factory ?? randomUUID;
  }

  async submit(input: SubmitRecoveryRequest): Promise<SubmitRecoveryResult> {
    const request = validateSubmit(input);
    const idempotencyKey = key(request.tenant_id, request.idempotency_key);
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.records.get(key(request.tenant_id, existingId));
      if (existing === undefined) throw new Error("recovery idempotency index is inconsistent");
      return isDeepStrictEqual(comparable(intent(existing)), comparable(request))
        ? { kind: "replayed", recovery: structuredClone(existing) }
        : { kind: "conflict", recovery_id: existing.recovery_id };
    }
    const storageKey = key(request.tenant_id, request.recovery_id);
    const sameId = this.records.get(storageKey);
    if (sameId !== undefined) {
      return isDeepStrictEqual(comparable(intent(sameId)), comparable(request))
        ? { kind: "replayed", recovery: structuredClone(sameId) }
        : { kind: "conflict", recovery_id: sameId.recovery_id };
    }
    const record: RecoveryRequestRecord = {
      ...request,
      state: "pending",
      version: 1,
      attempt: 0,
      outcome_code: null,
      completed_at: null,
    };
    this.records.set(storageKey, record);
    this.idempotency.set(idempotencyKey, record.recovery_id);
    return { kind: "accepted", recovery: structuredClone(record) };
  }

  async get(tenantId: string, recoveryId: string): Promise<RecoveryRequestRecord | null> {
    identifier(tenantId, "tenantId");
    identifier(recoveryId, "recoveryId");
    const record = this.records.get(key(tenantId, recoveryId));
    return record === undefined ? null : structuredClone(record);
  }

  async claim(input: ClaimRecoveryRequests): Promise<readonly RecoveryRequestClaim[]> {
    identifier(input.tenant_id, "tenant_id");
    identifier(input.worker_id, "worker_id");
    timestamp(input.now, "now");
    positive(input.lease_seconds, "lease_seconds");
    positive(input.limit, "limit");
    if (input.lease_seconds > 86_400 || input.limit > 1_000) {
      throw new TypeError("recovery claim bounds are exceeded");
    }
    const eligible = [...this.records.values()]
      .filter((record) => {
        if (record.tenant_id !== input.tenant_id || record.state === "completed" || record.state === "failed") return false;
        if (record.state === "pending") return true;
        const claim = this.claims.get(key(record.tenant_id, record.recovery_id));
        return claim === undefined || claim.lease_expires_at <= input.now;
      })
      .sort((left, right) =>
        left.requested_at.localeCompare(right.requested_at) ||
        left.recovery_id.localeCompare(right.recovery_id),
      )
      .slice(0, input.limit);
    const result: RecoveryRequestClaim[] = [];
    for (const record of eligible) {
      const storageKey = key(record.tenant_id, record.recovery_id);
      const fencing = (this.fencing.get(storageKey) ?? 0) + 1;
      const leaseExpires = new Date(
        Date.parse(input.now) + input.lease_seconds * 1_000,
      ).toISOString();
      const claim: ActiveClaim = {
        owner: input.worker_id,
        token: `claim_${this.claimTokenFactory()}`,
        fencing,
        lease_expires_at: leaseExpires,
      };
      const processing: RecoveryRequestRecord = {
        ...record,
        state: "processing",
        version: record.version + 1,
        attempt: record.attempt + 1,
      };
      this.records.set(storageKey, processing);
      this.claims.set(storageKey, claim);
      this.fencing.set(storageKey, fencing);
      result.push({
        ...structuredClone(processing),
        state: "processing",
        claim_owner: claim.owner,
        claim_token: claim.token,
        fencing_token: claim.fencing,
        lease_expires_at: claim.lease_expires_at,
      });
    }
    return result;
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
    identifier(input.tenant_id, "tenant_id");
    identifier(input.recovery_id, "recovery_id");
    identifier(input.claim_token, "claim_token");
    positive(input.fencing_token, "fencing_token");
    timestamp(input.completed_at, "completed_at");
    const outcome = boundedCode(input.outcome_code, "outcome_code");
    const storageKey = key(input.tenant_id, input.recovery_id);
    const record = this.records.get(storageKey);
    if (record === undefined) throw new RecoveryStoreError("not_found", "recovery request not found");
    if (record.state !== "processing") {
      throw new RecoveryStoreError("invalid_state", "recovery request is not processing");
    }
    const claim = this.claims.get(storageKey);
    if (
      claim === undefined || claim.token !== input.claim_token ||
      claim.fencing !== input.fencing_token || claim.lease_expires_at < input.completed_at
    ) throw new RecoveryStoreError("claim_lost", "recovery claim is no longer active");
    const completed: RecoveryRequestRecord = {
      ...record,
      state,
      version: record.version + 1,
      outcome_code: outcome,
      completed_at: input.completed_at,
    };
    this.records.set(storageKey, completed);
    this.claims.delete(storageKey);
    return structuredClone(completed);
  }
}
