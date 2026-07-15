import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
  addUtcTimestampSeconds,
  compareUtcTimestamps,
  parseUtcTimestamp,
  type CapabilityManifest,
  type EventRecord,
  type OutboxClaim,
  type OutboxRecord,
  type OutboxStore,
  type WorkerLease,
  type WorkerLeaseStore,
} from "@work-fabric/exchange-spi";

import {
  type DurabilityConformanceAdapter,
  verifyDurabilityProfile,
} from "../src/index.js";

const NOW = "2026-07-15T00:00:00.000Z";

function manifest(capabilities: Readonly<Record<string, boolean>>): CapabilityManifest {
  return {
    profile: "exchange.durability.v1",
    adapter: "conformance-memory",
    capabilities,
  };
}

function event(
  eventId: string,
  tenantId: string,
  partitionId: string,
  position: number,
): EventRecord {
  return {
    event_id: eventId,
    event_type: "workfabric.conformance.test.v1",
    schema_version: "1.0",
    tenant_id: tenantId,
    exchange_id: "exchange_01",
    partition_id: partitionId,
    partition_position: position,
    stream_id: `stream_${eventId}`,
    stream_version: 1,
    commit_id: `commit_${eventId}`,
    commit_ordinal: 0,
    request_message_id: `message_${eventId}`,
    idempotency_key: `key_${eventId}`,
    thread_id: "thread_01",
    handoff_id: `handoff_${eventId}`,
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    visibility: "public",
    visible_actor_ids: [],
    visible_endpoint_ids: [],
    occurred_at: NOW,
    domain_data: { position },
    protocol_data: { position },
  };
}

function outbox(
  outboxId: string,
  tenantId: string,
  partitionId: string,
  position: number,
): OutboxRecord {
  return {
    outbox_id: outboxId,
    tenant_id: tenantId,
    partition_id: partitionId,
    position,
    event: event(`event_${outboxId}`, tenantId, partitionId, position),
    attempt: 1,
    next_attempt_at: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validCapabilities(): Readonly<Record<string, boolean>> {
  return {
    tenant_isolation: true,
    partition_ordering: true,
    outbox_claim_leases: true,
    outbox_publish_fencing: true,
    outbox_failure_fencing: true,
    outbox_retry_schedule: true,
    outbox_failure_idempotency: true,
    outbox_publish_idempotency: true,
    immutable_reads: true,
    deep_clone: true,
    worker_lease_acquisition: true,
    worker_lease_renewal: true,
    worker_lease_release: true,
    worker_lease_fencing: true,
    worker_lease_recovery: true,
  };
}

class MemoryDurabilityAdapter implements DurabilityConformanceAdapter {
  readonly manifest = manifest(validCapabilities());
  private readonly outboxes = new Map<string, OutboxRecord>();
  private readonly leases = new Map<string, WorkerLease>();
  private readonly leaseCounters = new Map<string, number>();

  constructor() {
    for (const record of [
      outbox("outbox_01", "tenant_01", "partition_01", 1),
      outbox("outbox_02", "tenant_01", "partition_01", 2),
      outbox("outbox_03", "tenant_01", "partition_01", 3),
      outbox("outbox_other_partition", "tenant_01", "partition_02", 1),
      outbox("outbox_other_tenant", "tenant_02", "partition_01", 1),
    ]) {
      this.outboxes.set(record.outbox_id, record);
    }
  }

  async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    validateClaim(request);
    const candidates = [...this.outboxes.values()]
      .filter(
        (record) =>
          record.tenant_id === request.tenant_id &&
          record.partition_id === request.partition_id &&
          (record.next_attempt_at === null ||
            compareUtcTimestamps(record.next_attempt_at, request.now) <= 0) &&
          (record.lease_expires_at === null ||
            compareUtcTimestamps(record.lease_expires_at, request.now) <= 0),
      )
      .sort((left, right) => left.position - right.position)
      .slice(0, request.limit);
    const leasedUntil = addUtcTimestampSeconds(request.now, request.lease_seconds);
    return candidates.map((record) => {
      const next = {
        ...record,
        lease_owner: request.owner,
        lease_expires_at: leasedUntil,
        fencing_token: record.fencing_token + 1,
      };
      this.outboxes.set(record.outbox_id, next);
      return clone(next);
    });
  }

  async markPublished(
    outboxId: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    validateIdentity(outboxId, "outboxId");
    validateIdentity(owner, "owner");
    validateToken(fencingToken);
    const record = this.outboxes.get(outboxId);
    if (
      record === undefined ||
      record.lease_owner !== owner ||
      record.fencing_token !== fencingToken
    ) {
      return false;
    }
    this.outboxes.delete(outboxId);
    return true;
  }

  async recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean> {
    validateIdentity(outboxId, "outboxId");
    validateIdentity(owner, "owner");
    validateToken(fencingToken);
    validateTimestamp(nextAttemptAt, "nextAttemptAt");
    const record = this.outboxes.get(outboxId);
    if (
      record === undefined ||
      record.lease_owner !== owner ||
      record.fencing_token !== fencingToken
    ) {
      return false;
    }
    this.outboxes.set(outboxId, {
      ...record,
      attempt: record.attempt + 1,
      next_attempt_at: nextAttemptAt,
      lease_owner: null,
      lease_expires_at: null,
    });
    return true;
  }

  async listPending(
    tenantId: string,
    partitionId: string,
  ): Promise<readonly OutboxRecord[]> {
    validateIdentity(tenantId, "tenantId");
    validateIdentity(partitionId, "partitionId");
    return [...this.outboxes.values()]
      .filter(
        (record) =>
          record.tenant_id === tenantId && record.partition_id === partitionId,
      )
      .sort((left, right) => left.position - right.position)
      .map(clone);
  }

  async acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null> {
    validateIdentity(leaseKey, "leaseKey");
    validateIdentity(owner, "owner");
    validateTimestamp(now, "now");
    validateSeconds(leaseSeconds);
    const current = this.leases.get(leaseKey);
    if (
      current !== undefined &&
      compareUtcTimestamps(current.expires_at, now) > 0
    ) {
      return null;
    }
    const lease: WorkerLease = {
      lease_key: leaseKey,
      owner,
      fencing_token: (this.leaseCounters.get(leaseKey) ?? current?.fencing_token ?? 0) + 1,
      expires_at: addUtcTimestampSeconds(now, leaseSeconds),
    };
    this.leases.set(leaseKey, lease);
    this.leaseCounters.set(leaseKey, lease.fencing_token);
    return clone(lease);
  }

  async renew(
    leaseKey: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    validateIdentity(leaseKey, "leaseKey");
    validateIdentity(owner, "owner");
    validateToken(fencingToken);
    validateTimestamp(now, "now");
    validateSeconds(leaseSeconds);
    const current = this.leases.get(leaseKey);
    if (
      current === undefined ||
      current.owner !== owner ||
      current.fencing_token !== fencingToken ||
      compareUtcTimestamps(current.expires_at, now) <= 0
    ) {
      return false;
    }
    this.leases.set(leaseKey, {
      ...current,
      expires_at: addUtcTimestampSeconds(now, leaseSeconds),
    });
    return true;
  }

  async release(
    leaseKey: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    validateIdentity(leaseKey, "leaseKey");
    validateIdentity(owner, "owner");
    validateToken(fencingToken);
    const current = this.leases.get(leaseKey);
    if (
      current === undefined ||
      current.owner !== owner ||
      current.fencing_token !== fencingToken
    ) {
      return false;
    }
    this.leases.delete(leaseKey);
    return true;
  }
}

function validateIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is string {
  parseUtcTimestamp(value, label);
}

function validateSeconds(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError("seconds must be a positive safe integer");
  }
}

function validateToken(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError("fencing token must be a positive safe integer");
  }
}

function validateClaim(request: OutboxClaim): void {
  validateIdentity(request.owner, "owner");
  validateTimestamp(request.now, "now");
  validateSeconds(request.lease_seconds);
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new RangeError("limit must be a positive safe integer");
  }
  validateIdentity(request.tenant_id, "tenantId");
  validateIdentity(request.partition_id, "partitionId");
}

class IgnoresOwnerAndFencing extends MemoryDurabilityAdapter {
  override async markPublished(
    outboxId: string,
    _owner: string,
    _fencingToken: number,
  ): Promise<boolean> {
    return super.markPublished(outboxId, "owner_a", 1);
  }
}

class ReturnsExpiredLease extends MemoryDurabilityAdapter {
  override async acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null> {
    const lease = await super.acquire(leaseKey, owner, now, leaseSeconds);
    return lease === null ? null : { ...lease, expires_at: now };
  }
}

class ClaimsAnotherTenant extends MemoryDurabilityAdapter {
  override async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    const result = await super.claim({ ...request, tenant_id: "tenant_01" });
    return result.map((record) => ({ ...record, tenant_id: "tenant_02" }));
  }
}

class MarksWithoutMatchingLease extends MemoryDurabilityAdapter {
  override async markPublished(): Promise<boolean> {
    return true;
  }
}

class AllowsStaleFailure extends MemoryDurabilityAdapter {
  override async recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean> {
    const result = await super.recordFailure(
      outboxId,
      owner,
      fencingToken,
      nextAttemptAt,
    );
    return owner === "worker_stale_a" ? true : result;
  }
}

class RepeatsFailureSuccess extends MemoryDurabilityAdapter {
  private readonly failed = new Set<string>();

  override async recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean> {
    const result = await super.recordFailure(
      outboxId,
      owner,
      fencingToken,
      nextAttemptAt,
    );
    const key = `${outboxId}:${owner}:${fencingToken}:${nextAttemptAt}`;
    if (result) this.failed.add(key);
    return result || this.failed.has(key);
  }
}

class MutatesRetryRow extends MemoryDurabilityAdapter {
  override async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    const result = await super.claim(request);
    if (request.owner !== "worker_profile_c") return result;
    return result.map((record) => ({
      ...record,
      outbox_id: "tampered-outbox",
      attempt: 999,
      fencing_token: Number.POSITIVE_INFINITY,
      event: {
        ...record.event,
        domain_data: { ...record.event.domain_data, position: "tampered" },
        protocol_data: { ...record.event.protocol_data, position: "tampered" },
      },
    }));
  }
}

class SharesJsonBodies extends MemoryDurabilityAdapter {
  private shared: OutboxRecord | undefined;

  override async listPending(
    tenantId: string,
    partitionId: string,
  ): Promise<readonly OutboxRecord[]> {
    const result = await super.listPending(tenantId, partitionId);
    const first = result[0];
    if (this.shared === undefined && first !== undefined) this.shared = first;
    if (this.shared === undefined || first === undefined) return result;
    return result.map((record) =>
      record.outbox_id === this.shared?.outbox_id ? this.shared : record,
    );
  }
}

class AllowsStaleRelease extends MemoryDurabilityAdapter {
  override async release(
    leaseKey: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    const result = await super.release(leaseKey, owner, fencingToken);
    return owner === "worker_profile_a" && result === false ? true : result;
  }
}

class ReclaimsUnexpired extends MemoryDurabilityAdapter {
  private previousClaim: readonly OutboxRecord[] = [];

  override async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    const result = await super.claim(request);
    if (
      request.owner === "worker_profile_a" &&
      result.length === 0 &&
      this.previousClaim.length > 0
    ) {
      return this.previousClaim;
    }
    this.previousClaim = result;
    return result;
  }
}

class MutatesClaimEvent extends MemoryDurabilityAdapter {
  override async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    const result = await super.claim(request);
    if (request.owner !== "worker_profile_a") return result;
    return result.map((record) => ({
      ...record,
      event: {
        ...record.event,
        domain_data: { ...record.event.domain_data, position: 777 },
        protocol_data: { ...record.event.protocol_data, position: 777 },
      },
    }));
  }
}

class MutatesEventTimestamp extends MemoryDurabilityAdapter {
  override async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    const result = await super.claim(request);
    return result.map((record) => ({
      ...record,
      event: { ...record.event, occurred_at: "2026-02-29T00:00:00Z" },
    }));
  }
}

class ReturnsWrongRecoveryIdentity extends MemoryDurabilityAdapter {
  override async acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null> {
    const lease = await super.acquire(leaseKey, owner, now, leaseSeconds);
    if (lease === null || !leaseKey.startsWith("worker:recovery:")) return lease;
    return { ...lease, lease_key: "wrong-key", owner: "wrong-owner" };
  }
}

const profile = (factory: () => DurabilityConformanceAdapter) =>
  verifyDurabilityProfile(factory);

describe("durability profile", () => {
  it("accepts a durable outbox and worker lease adapter", async () => {
    await expect(profile(() => new MemoryDurabilityAdapter())).resolves.toBeUndefined();
  });

  it.each([
    ["owner/fencing", () => new IgnoresOwnerAndFencing()],
    ["expired lease", () => new ReturnsExpiredLease()],
    ["tenant isolation", () => new ClaimsAnotherTenant()],
    ["matching lease", () => new MarksWithoutMatchingLease()],
    ["stale failure fencing", () => new AllowsStaleFailure()],
    ["failure idempotency", () => new RepeatsFailureSuccess()],
    ["retry row integrity", () => new MutatesRetryRow()],
    ["nested JSON clone", () => new SharesJsonBodies()],
    ["stale release fencing", () => new AllowsStaleRelease()],
    ["same-owner claim fencing", () => new ReclaimsUnexpired()],
    ["claim event snapshot", () => new MutatesClaimEvent()],
    ["event timestamp validation", () => new MutatesEventTimestamp()],
    ["recovery lease identity", () => new ReturnsWrongRecoveryIdentity()],
  ])("rejects an adapter that violates %s", async (_name, factory) => {
    await expect(profile(factory)).rejects.toThrow();
  });
});
