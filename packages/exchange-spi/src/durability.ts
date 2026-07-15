import type { EventRecord } from "./events.js";

/** Capabilities required to safely consume durable Outbox rows. */
export const OUTBOX_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "partition_ordering",
  "outbox_claim_leases",
  "outbox_publish_fencing",
  "outbox_failure_fencing",
  "outbox_retry_schedule",
  "outbox_failure_idempotency",
  "outbox_publish_idempotency",
  "immutable_reads",
  "deep_clone",
] as const;

/** Capabilities required to coordinate crash-recoverable workers. */
export const WORKER_LEASE_REQUIRED_CAPABILITIES = [
  "worker_lease_acquisition",
  "worker_lease_renewal",
  "worker_lease_release",
  "worker_lease_fencing",
  "worker_lease_recovery",
] as const;

/** Complete capability set for the technology-neutral durability profile. */
export const DURABILITY_REQUIRED_CAPABILITIES = [
  ...OUTBOX_REQUIRED_CAPABILITIES,
  ...WORKER_LEASE_REQUIRED_CAPABILITIES,
] as const;

export interface OutboxRecord {
  readonly outbox_id: string;
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly position: number;
  readonly event: EventRecord;
  readonly attempt: number;
  readonly next_attempt_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly fencing_token: number;
}

export interface OutboxClaim {
  readonly owner: string;
  readonly now: string;
  readonly lease_seconds: number;
  readonly limit: number;
  readonly tenant_id: string;
  readonly partition_id: string;
}

export interface OutboxStore {
  claim(request: OutboxClaim): Promise<readonly OutboxRecord[]>;
  markPublished(
    outboxId: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean>;
  recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean>;
  listPending(
    tenantId: string,
    partitionId: string,
  ): Promise<readonly OutboxRecord[]>;
}

export interface WorkerLease {
  readonly lease_key: string;
  readonly owner: string;
  readonly fencing_token: number;
  readonly expires_at: string;
}

export interface WorkerLeaseStore {
  acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null>;
  renew(
    leaseKey: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  release(leaseKey: string, owner: string, fencingToken: number): Promise<boolean>;
}
