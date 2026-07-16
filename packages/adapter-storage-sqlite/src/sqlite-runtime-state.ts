import { isDeepStrictEqual } from "node:util";

import {
  DURABILITY_REQUIRED_CAPABILITIES,
  SUBSCRIPTION_REQUIRED_CAPABILITIES,
  addUtcTimestampSeconds,
  compareUtcTimestamps,
  parseUtcTimestamp,
  type CapabilityManifest,
  type EventRecord,
  type OutboxClaim,
  type OutboxRecord,
  type OutboxStore,
  type RuntimeSubscription,
  type SubscriptionStore,
  type WorkerLease,
  type WorkerLeaseStore,
} from "@work-fabric/exchange-spi";

import type { SqliteSession } from "./sqlite-session.js";

const manifest: CapabilityManifest = {
  profile: "exchange.runtime.v1",
  adapter: "sqlite",
  capabilities: {
    ...Object.fromEntries([
      ...DURABILITY_REQUIRED_CAPABILITIES,
      ...SUBSCRIPTION_REQUIRED_CAPABILITIES,
    ].map((capability) => [capability, true])),
    local_file_durability: true,
    single_process_writer: true,
    clustered_claims: false,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function timestamp(value: string, label: string): void {
  parseUtcTimestamp(value, label);
}

function json<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("SQLite JSON column is invalid");
  return JSON.parse(value) as T;
}

function validateEvent(event: EventRecord): void {
  identity(event.event_id, "event_id");
  identity(event.tenant_id, "event tenant_id");
  identity(event.partition_id, "event partition_id");
  positive(event.partition_position, "event partition_position");
  timestamp(event.occurred_at, "event occurred_at");
}

function outboxFromRow(row: Record<string, unknown>): OutboxRecord {
  const event = json<EventRecord>(row.event);
  validateEvent(event);
  const record: OutboxRecord = {
    outbox_id: String(row.outbox_id),
    tenant_id: String(row.tenant_id),
    partition_id: String(row.partition_id),
    position: Number(row.position),
    event,
    attempt: Number(row.attempt),
    next_attempt_at: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    fencing_token: Number(row.fencing_token),
  };
  identity(record.outbox_id, "outbox_id");
  positive(record.position, "outbox position");
  positive(record.attempt, "outbox attempt");
  nonNegative(record.fencing_token, "outbox fencing_token");
  if (
    event.tenant_id !== record.tenant_id ||
    event.partition_id !== record.partition_id ||
    event.partition_position !== record.position
  ) throw new Error("outbox Event identity mismatch");
  return record;
}

const SUBSCRIPTION_KEYS = [
  "subscription_id", "tenant_id", "owner", "endpoint_id", "filter",
  "destination", "delivery_mode", "state", "max_attempts", "created_at",
  "updated_at",
] as const;

function stringArray(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128) ||
    new Set(value).size !== value.length
  ) throw new TypeError(`${label} must be a unique bounded string array`);
}

function validateSubscription(subscription: RuntimeSubscription): void {
  const raw = subscription as unknown as Record<string, unknown>;
  if (
    typeof raw !== "object" || raw === null ||
    Object.keys(raw).length !== SUBSCRIPTION_KEYS.length ||
    SUBSCRIPTION_KEYS.some((key) => !Object.hasOwn(raw, key))
  ) throw new TypeError("Subscription contains unknown or missing fields");
  identity(subscription.subscription_id, "subscription_id");
  identity(subscription.tenant_id, "tenant_id");
  identity(subscription.endpoint_id, "endpoint_id");
  if (
    typeof subscription.owner !== "object" || subscription.owner === null ||
    Object.keys(subscription.owner).length !== 2
  ) throw new TypeError("owner contains unknown fields");
  identity(subscription.owner.actor_id, "owner.actor_id");
  if (!["human", "agent", "system"].includes(subscription.owner.actor_type)) {
    throw new TypeError("owner.actor_type is invalid");
  }
  const filter = subscription.filter as unknown as Record<string, unknown>;
  const filterKeys = [
    "event_types", "actor_ids", "endpoint_ids", "thread_ids", "handoff_ids",
    "work_reference_uris", "capability_ids", "lifecycle_states",
  ];
  if (
    typeof filter !== "object" || filter === null ||
    Object.keys(filter).length !== filterKeys.length ||
    filterKeys.some((key) => !Object.hasOwn(filter, key))
  ) throw new TypeError("filter contains unknown or missing fields");
  for (const key of filterKeys) stringArray(filter[key], `filter.${key}`);
  if ((filter.event_types as string[]).some(
    (value) => !/^workfabric\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v1$/.test(value)
  )) throw new TypeError("filter.event_types is invalid");
  if ((filter.capability_ids as string[]).some(
    (value) => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value)
  )) throw new TypeError("filter.capability_ids is invalid");
  const lifecycle = new Set([
    "offered", "accepted", "result_returned", "verified", "rework_requested",
    "closed", "declined", "expired", "cancelled", "transferred",
  ]);
  if ((filter.lifecycle_states as string[]).some((value) => !lifecycle.has(value))) {
    throw new TypeError("filter.lifecycle_states is invalid");
  }
  if ((filter.work_reference_uris as string[]).some((value) => {
    try { return new URL(value).protocol.length <= 1; } catch { return true; }
  })) throw new TypeError("filter.work_reference_uris is invalid");
  const destination = subscription.destination as unknown as Record<string, unknown>;
  if (
    typeof destination !== "object" || destination === null ||
    Object.keys(destination).some((key) =>
      !["destination_id", "binding", "configuration"].includes(key)
    )
  ) throw new TypeError("destination is invalid");
  identity(destination.destination_id, "destination.destination_id");
  identity(destination.binding, "destination.binding");
  if (
    typeof destination.configuration !== "object" ||
    destination.configuration === null || Array.isArray(destination.configuration)
  ) throw new TypeError("destination.configuration is invalid");
  if (!["cursor_pull", "sse", "webhook"].includes(subscription.delivery_mode)) {
    throw new TypeError("delivery_mode is invalid");
  }
  if (!["active", "suspended", "closed"].includes(subscription.state)) {
    throw new TypeError("Subscription state is invalid");
  }
  positive(subscription.max_attempts, "max_attempts");
  timestamp(subscription.created_at, "created_at");
  timestamp(subscription.updated_at, "updated_at");
  if (compareUtcTimestamps(subscription.updated_at, subscription.created_at) < 0) {
    throw new TypeError("updated_at must not precede created_at");
  }
}

function sameSubscriptionIdentity(
  left: RuntimeSubscription,
  right: RuntimeSubscription,
): boolean {
  return left.subscription_id === right.subscription_id &&
    left.tenant_id === right.tenant_id &&
    left.owner.actor_id === right.owner.actor_id &&
    left.owner.actor_type === right.owner.actor_type &&
    left.endpoint_id === right.endpoint_id &&
    left.created_at === right.created_at;
}

export class SqliteRuntimeState
  implements OutboxStore, WorkerLeaseStore, SubscriptionStore
{
  readonly manifest = clone(manifest);

  constructor(
    private readonly session: SqliteSession,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  private assertTenant(tenantId: string): void {
    identity(tenantId, "tenantId");
    if (tenantId !== this.tenantId) throw new Error("tenant context mismatch");
  }

  async claim(request: OutboxClaim): Promise<readonly OutboxRecord[]> {
    this.assertTenant(request.tenant_id);
    identity(request.partition_id, "partitionId");
    identity(request.owner, "owner");
    timestamp(request.now, "now");
    positive(request.lease_seconds, "lease_seconds");
    positive(request.limit, "limit");
    return clone(this.session.transaction(() => {
      const rows = this.session.prepare(`
        SELECT * FROM work_fabric_outbox
        WHERE tenant_id=? AND partition_id=? ORDER BY position
      `).all(this.tenantId, request.partition_id)
        .map((row) => outboxFromRow(row as Record<string, unknown>))
        .filter((record) =>
          (record.next_attempt_at === null ||
            compareUtcTimestamps(record.next_attempt_at, request.now) <= 0) &&
          (record.lease_expires_at === null ||
            compareUtcTimestamps(record.lease_expires_at, request.now) <= 0)
        )
        .slice(0, request.limit);
      const expiresAt = addUtcTimestampSeconds(request.now, request.lease_seconds);
      return rows.map((record) => {
        const next = {
          ...record,
          lease_owner: request.owner,
          lease_expires_at: expiresAt,
          fencing_token: record.fencing_token + 1,
        };
        positive(next.fencing_token, "fencing_token");
        this.session.prepare(`
          UPDATE work_fabric_outbox
          SET lease_owner=?,lease_expires_at=?,fencing_token=?
          WHERE tenant_id=? AND outbox_id=? AND fencing_token=?
        `).run(
          next.lease_owner,
          next.lease_expires_at,
          next.fencing_token,
          this.tenantId,
          next.outbox_id,
          record.fencing_token,
        );
        return next;
      });
    }));
  }

  async markPublished(
    outboxId: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    identity(outboxId, "outboxId");
    identity(owner, "owner");
    positive(fencingToken, "fencingToken");
    const result = this.session.prepare(`
      DELETE FROM work_fabric_outbox
      WHERE tenant_id=? AND outbox_id=? AND lease_owner=? AND fencing_token=?
    `).run(this.tenantId, outboxId, owner, fencingToken);
    return Number(result.changes) === 1;
  }

  async recordFailure(
    outboxId: string,
    owner: string,
    fencingToken: number,
    nextAttemptAt: string,
  ): Promise<boolean> {
    identity(outboxId, "outboxId");
    identity(owner, "owner");
    positive(fencingToken, "fencingToken");
    timestamp(nextAttemptAt, "nextAttemptAt");
    const result = this.session.prepare(`
      UPDATE work_fabric_outbox
      SET attempt=attempt+1,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=? AND outbox_id=? AND lease_owner=? AND fencing_token=?
    `).run(nextAttemptAt, this.tenantId, outboxId, owner, fencingToken);
    return Number(result.changes) === 1;
  }

  async listPending(tenantId: string, partitionId: string): Promise<readonly OutboxRecord[]> {
    this.assertTenant(tenantId);
    identity(partitionId, "partitionId");
    return this.session.prepare(`
      SELECT * FROM work_fabric_outbox
      WHERE tenant_id=? AND partition_id=? ORDER BY position
    `).all(this.tenantId, partitionId).map((row) =>
      clone(outboxFromRow(row as Record<string, unknown>))
    );
  }

  async acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null> {
    identity(leaseKey, "leaseKey");
    identity(owner, "owner");
    timestamp(now, "now");
    positive(leaseSeconds, "leaseSeconds");
    return clone(this.session.transaction(() => {
      const current = this.session.prepare(`
        SELECT owner,fencing_token,expires_at FROM work_fabric_worker_leases
        WHERE tenant_id=? AND lease_key=?
      `).get(this.tenantId, leaseKey) as Record<string, unknown> | undefined;
      if (
        current !== undefined && current.owner !== null &&
        compareUtcTimestamps(String(current.expires_at), now) > 0
      ) return null;
      const lease: WorkerLease = {
        lease_key: leaseKey,
        owner,
        fencing_token: Number(current?.fencing_token ?? 0) + 1,
        expires_at: addUtcTimestampSeconds(now, leaseSeconds),
      };
      positive(lease.fencing_token, "fencing_token");
      this.session.prepare(`
        INSERT INTO work_fabric_worker_leases
          (tenant_id,lease_key,owner,fencing_token,expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT (tenant_id,lease_key) DO UPDATE SET
          owner=excluded.owner,
          fencing_token=excluded.fencing_token,
          expires_at=excluded.expires_at
      `).run(
        this.tenantId,
        lease.lease_key,
        lease.owner,
        lease.fencing_token,
        lease.expires_at,
      );
      return lease;
    }));
  }

  async renew(
    leaseKey: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    identity(leaseKey, "leaseKey");
    identity(owner, "owner");
    positive(fencingToken, "fencingToken");
    timestamp(now, "now");
    positive(leaseSeconds, "leaseSeconds");
    return this.session.transaction(() => {
      const row = this.session.prepare(`
        SELECT owner,fencing_token,expires_at FROM work_fabric_worker_leases
        WHERE tenant_id=? AND lease_key=?
      `).get(this.tenantId, leaseKey) as Record<string, unknown> | undefined;
      if (
        row === undefined || row.owner !== owner ||
        Number(row.fencing_token) !== fencingToken ||
        compareUtcTimestamps(String(row.expires_at), now) <= 0
      ) return false;
      this.session.prepare(`
        UPDATE work_fabric_worker_leases SET expires_at=?
        WHERE tenant_id=? AND lease_key=? AND owner=? AND fencing_token=?
      `).run(
        addUtcTimestampSeconds(now, leaseSeconds),
        this.tenantId,
        leaseKey,
        owner,
        fencingToken,
      );
      return true;
    });
  }

  async release(leaseKey: string, owner: string, fencingToken: number): Promise<boolean> {
    identity(leaseKey, "leaseKey");
    identity(owner, "owner");
    positive(fencingToken, "fencingToken");
    const result = this.session.prepare(`
      UPDATE work_fabric_worker_leases SET owner=NULL
      WHERE tenant_id=? AND lease_key=? AND owner=? AND fencing_token=?
    `).run(this.tenantId, leaseKey, owner, fencingToken);
    return Number(result.changes) === 1;
  }

  async getSubscription(subscriptionId: string): Promise<RuntimeSubscription | null> {
    identity(subscriptionId, "subscriptionId");
    const row = this.session.prepare(`
      SELECT payload FROM work_fabric_subscriptions
      WHERE tenant_id=? AND subscription_id=?
    `).get(this.tenantId, subscriptionId) as { payload: string } | undefined;
    return row === undefined ? null : clone(json(row.payload));
  }

  async listActiveSubscriptions(tenantId: string): Promise<readonly RuntimeSubscription[]> {
    this.assertTenant(tenantId);
    return this.session.prepare(`
      SELECT payload FROM work_fabric_subscriptions
      WHERE tenant_id=? AND json_extract(payload, '$.state')='active'
      ORDER BY subscription_id
    `).all(this.tenantId).map((row) =>
      clone(json<RuntimeSubscription>((row as { payload: string }).payload))
    );
  }

  async putSubscription(subscription: RuntimeSubscription): Promise<void> {
    validateSubscription(subscription);
    this.assertTenant(subscription.tenant_id);
    this.session.transaction(() => {
      const existing = this.session.prepare(`
        SELECT payload FROM work_fabric_subscriptions
        WHERE tenant_id=? AND subscription_id=?
      `).get(this.tenantId, subscription.subscription_id) as { payload: string } | undefined;
      if (existing !== undefined) {
        const current = json<RuntimeSubscription>(existing.payload);
        if (!sameSubscriptionIdentity(current, subscription)) {
          throw new Error("Subscription identity is immutable");
        }
        if (isDeepStrictEqual(current, subscription)) return;
        if (current.state === "closed") throw new Error("closed Subscription is terminal");
        if (compareUtcTimestamps(subscription.updated_at, current.updated_at) <= 0) {
          throw new Error("Subscription updated_at must increase");
        }
      }
      this.session.prepare(`
        INSERT INTO work_fabric_subscriptions
          (tenant_id,subscription_id,payload) VALUES (?,?,?)
        ON CONFLICT (tenant_id,subscription_id) DO UPDATE SET payload=excluded.payload
      `).run(
        this.tenantId,
        subscription.subscription_id,
        JSON.stringify(clone(subscription)),
      );
    });
  }
}
