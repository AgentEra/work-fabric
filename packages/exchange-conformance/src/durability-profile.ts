import assert from "node:assert/strict";

import {
  addUtcTimestampSeconds,
  assertCapabilities,
  DURABILITY_REQUIRED_CAPABILITIES,
  parseUtcTimestamp,
  type ExchangeAdapter,
  type OutboxClaim,
  type OutboxRecord,
  type OutboxStore,
  type WorkerLease,
  type WorkerLeaseStore,
} from "@work-fabric/exchange-spi";

export type DurabilityConformanceAdapter = ExchangeAdapter &
  OutboxStore &
  WorkerLeaseStore;

export type DurabilityStoreFactory = () => DurabilityConformanceAdapter;

export interface DurabilityProfileFixtures {
  readonly tenant_id: string;
  readonly other_tenant_id: string;
  readonly partition_id: string;
  readonly other_partition_id: string;
  readonly outbox_ids: readonly [string, string, string];
  readonly other_tenant_outbox_id: string;
  readonly other_partition_outbox_id: string;
  readonly now: string;
}

export const DEFAULT_DURABILITY_PROFILE_FIXTURES: DurabilityProfileFixtures = {
  tenant_id: "tenant_01",
  other_tenant_id: "tenant_02",
  partition_id: "partition_01",
  other_partition_id: "partition_02",
  outbox_ids: ["outbox_01", "outbox_02", "outbox_03"],
  other_tenant_outbox_id: "outbox_other_tenant",
  other_partition_outbox_id: "outbox_other_partition",
  now: "2026-07-15T00:00:00.123456789Z",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireIdentity(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  if (typeof value !== "string") return;
  assert.ok(value.trim().length > 0, `${label} must be non-empty`);
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  assert.doesNotThrow(() => parseUtcTimestamp(value, label));
}

function requirePositiveInteger(value: unknown, label: string): asserts value is number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  );
}

const INVALID_POSITIVE_INTEGERS = [
  -1,
  0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
] as const;

const INVALID_UTC_TIMESTAMPS = [
  "2026-07-15T00:00:00.0000000000Z",
  "2026-07-15T00:00:00+00:00",
  "2026-07-15T00:00:00+08:00",
  "2026-07-15 00:00:00Z",
  "2026-02-29T00:00:00Z",
] as const;

const VALID_FRACTIONAL_UTC_TIMESTAMPS = [
  "2026-07-15T00:00:00.1Z",
  "2026-07-15T00:00:00.12Z",
  "2026-07-15T00:00:00.123Z",
  "2026-07-15T00:00:00.1234Z",
  "2026-07-15T00:00:00.12345Z",
  "2026-07-15T00:00:00.123456Z",
  "2026-07-15T00:00:00.1234567Z",
  "2026-07-15T00:00:00.12345678Z",
] as const;

function assertRecordShape(
  record: OutboxRecord,
  request: OutboxClaim,
): void {
  assert.equal(record.tenant_id, request.tenant_id);
  assert.equal(record.partition_id, request.partition_id);
  requireIdentity(record.outbox_id, "outbox_id");
  requirePositiveInteger(record.position, "position");
  requirePositiveInteger(record.attempt, "attempt");
  assert.ok(
    Number.isSafeInteger(record.fencing_token) && record.fencing_token >= 0,
    "fencing_token must be a non-negative safe integer",
  );
  assert.equal(record.event.tenant_id, record.tenant_id);
  assert.equal(record.event.partition_id, record.partition_id);
  assert.equal(record.event.partition_position, record.position);
  requireTimestamp(record.event.occurred_at, "event.occurred_at");
  if (record.next_attempt_at !== null) {
    requireTimestamp(record.next_attempt_at, "next_attempt_at");
  }
  if (record.lease_expires_at !== null) {
    requireTimestamp(record.lease_expires_at, "lease_expires_at");
  }
  if (record.lease_owner === null) {
    assert.equal(record.lease_expires_at, null);
  } else {
    requireIdentity(record.lease_owner, "lease_owner");
    assert.ok(record.lease_expires_at !== null, "leased rows need an expiry");
  }
}

function assertOrderedUnique(records: readonly OutboxRecord[]): void {
  const outboxIds = new Set<string>();
  const positions = new Set<number>();
  let previousPosition = 0;
  for (const record of records) {
    assert.equal(outboxIds.has(record.outbox_id), false, "outbox IDs must be unique");
    assert.equal(positions.has(record.position), false, "positions must be unique");
    assert.ok(record.position > previousPosition, "outbox rows must be position ordered");
    outboxIds.add(record.outbox_id);
    positions.add(record.position);
    previousPosition = record.position;
  }
}

function identity(record: OutboxRecord): readonly [string, string, string, number] {
  return [record.outbox_id, record.tenant_id, record.partition_id, record.position];
}

function assertStableIdentity(
  record: OutboxRecord,
  expected: readonly [string, string, string, number],
): void {
  assert.deepEqual(identity(record), expected, "outbox identity must remain stable");
}

function adjacentUtcNanosecond(timestamp: string, direction: -1 | 1): string {
  const parsed = parseUtcTimestamp(timestamp);
  let nanoseconds = parsed.nanoseconds + direction;
  let secondsOffset = 0;
  if (nanoseconds < 0) {
    nanoseconds = 999_999_999;
    secondsOffset = -1;
  } else if (nanoseconds > 999_999_999) {
    nanoseconds = 0;
    secondsOffset = 1;
  }
  const wholeSecond = new Date(
    Date.parse(timestamp) + secondsOffset * 1_000,
  )
    .toISOString()
    .slice(0, 19);
  return `${wholeSecond}.${String(nanoseconds).padStart(9, "0")}Z`;
}

async function mustReject(operation: Promise<unknown>, reason: string): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(reason);
}

async function mustAccept<T>(operation: Promise<T>, reason: string): Promise<T> {
  try {
    return await operation;
  } catch (error: unknown) {
    assert.fail(`${reason}: ${errorMessage(error)}`);
  }
}

async function verifyCapabilities(store: DurabilityConformanceAdapter): Promise<void> {
  assert.equal(store.manifest.profile, "exchange.durability.v1");
  assertCapabilities(store.manifest, DURABILITY_REQUIRED_CAPABILITIES);
}

async function verifyStrictInputs(
  store: DurabilityConformanceAdapter,
  fixtures: DurabilityProfileFixtures,
): Promise<void> {
  const claim: OutboxClaim = {
    owner: "worker_profile_a",
    now: fixtures.now,
    lease_seconds: 30,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.partition_id,
  };
  await mustReject(
    store.claim({ ...claim, owner: "" }),
    "claim must reject an empty owner",
  );
  await mustReject(
    store.claim({ ...claim, owner: "   " }),
    "claim must reject a whitespace owner",
  );
  await mustReject(
    store.claim({ ...claim, now: "2026-07-15 00:00:00Z" }),
    "claim must reject a non-UTC timestamp",
  );
  for (const timestamp of INVALID_UTC_TIMESTAMPS) {
    await mustReject(
      store.claim({ ...claim, now: timestamp }),
      `claim must reject invalid UTC timestamp ${timestamp}`,
    );
  }
  for (const [index, timestamp] of VALID_FRACTIONAL_UTC_TIMESTAMPS.entries()) {
    const fractionOwner = `worker_fraction_${index}`;
    const fractionLeaseKey = `lease:fraction:${index}`;
    const lease = await store.acquire(
      fractionLeaseKey,
      fractionOwner,
      timestamp,
      30,
    );
    assert.ok(lease !== null, `lease acquire must accept valid UTC fraction ${timestamp}`);
    if (lease !== null) {
      assert.equal(
        await mustAccept(
          store.renew(
            fractionLeaseKey,
            fractionOwner,
            lease.fencing_token,
            timestamp,
            30,
          ),
          `lease renewal must accept valid UTC fraction ${timestamp}`,
        ),
        true,
        `lease renewal must succeed for valid UTC fraction ${timestamp}`,
      );
    }

    // Reuse one real outbox row as a due retry so recordFailure is exercised
    // against a valid owner/token pair rather than an unknown-row fast path.
    const fractionClaim = await store.claim({
      ...claim,
      owner: fractionOwner,
      now: timestamp,
      limit: 1,
    });
    assert.equal(
      fractionClaim.length,
      1,
      `claim must accept valid UTC fraction ${timestamp}`,
    );
    const fractionRecord = fractionClaim[0];
    assert.ok(fractionRecord !== undefined);
    if (fractionRecord === undefined || fractionRecord.lease_owner === null) return;
    assert.equal(
      await mustAccept(
        store.recordFailure(
          fractionRecord.outbox_id,
          fractionRecord.lease_owner,
          fractionRecord.fencing_token,
          timestamp,
        ),
        `failure recording must accept valid UTC fraction ${timestamp}`,
      ),
      true,
      `failure recording must succeed for valid UTC fraction ${timestamp}`,
    );
  }
  for (const value of INVALID_POSITIVE_INTEGERS) {
    await mustReject(
      store.claim({ ...claim, lease_seconds: value }),
      `claim must reject lease_seconds ${String(value)}`,
    );
    await mustReject(
      store.claim({ ...claim, limit: value }),
      `claim must reject limit ${String(value)}`,
    );
  }
  await mustReject(
    store.claim({ ...claim, tenant_id: "" }),
    "claim must reject an empty tenant",
  );
  await mustReject(
    store.claim({ ...claim, tenant_id: "   " }),
    "claim must reject a whitespace tenant",
  );
  await mustReject(
    store.claim({ ...claim, partition_id: "" }),
    "claim must reject an empty partition",
  );
  await mustReject(
    store.claim({ ...claim, partition_id: "   " }),
    "claim must reject a whitespace partition",
  );
  await mustReject(
    store.acquire("", "worker_profile_a", fixtures.now, 30),
    "lease acquire must reject an empty key",
  );
  await mustReject(
    store.acquire("   ", "worker_profile_a", fixtures.now, 30),
    "lease acquire must reject a whitespace key",
  );
  await mustReject(
    store.acquire("lease:profile", "", fixtures.now, 30),
    "lease acquire must reject an empty owner",
  );
  await mustReject(
    store.acquire("lease:profile", "   ", fixtures.now, 30),
    "lease acquire must reject a whitespace owner",
  );
  await mustReject(
    store.acquire("lease:profile", "worker_profile_a", "not-a-time", 30),
    "lease acquire must reject an invalid timestamp",
  );
  for (const timestamp of INVALID_UTC_TIMESTAMPS) {
    await mustReject(
      store.acquire("lease:profile", "worker_profile_a", timestamp, 30),
      `lease acquire must reject invalid UTC timestamp ${timestamp}`,
    );
  }
  for (const value of INVALID_POSITIVE_INTEGERS) {
    await mustReject(
      store.acquire("lease:profile", "worker_profile_a", fixtures.now, value),
      `lease acquire must reject lease seconds ${String(value)}`,
    );
  }
  await mustReject(
    store.listPending("", fixtures.partition_id),
    "listPending must reject an empty tenant",
  );
  await mustReject(
    store.listPending("   ", fixtures.partition_id),
    "listPending must reject a whitespace tenant",
  );
  await mustReject(
    store.listPending(fixtures.tenant_id, ""),
    "listPending must reject an empty partition",
  );
  await mustReject(
    store.listPending(fixtures.tenant_id, "   "),
    "listPending must reject a whitespace partition",
  );
  await mustReject(
    store.markPublished("", "worker_profile_a", 1),
    "publish must reject an empty outbox ID",
  );
  await mustReject(
    store.markPublished("   ", "worker_profile_a", 1),
    "publish must reject a whitespace outbox ID",
  );
  await mustReject(
    store.markPublished("outbox_profile", "", 1),
    "publish must reject an empty owner",
  );
  await mustReject(
    store.markPublished("outbox_profile", "   ", 1),
    "publish must reject a whitespace owner",
  );
  await mustReject(
    store.recordFailure("outbox_profile", "   ", 1, fixtures.now),
    "failure recording must reject a whitespace owner",
  );
  await mustReject(
    store.recordFailure("   ", "worker_profile_a", 1, fixtures.now),
    "failure recording must reject a whitespace outbox ID",
  );
  for (const value of INVALID_POSITIVE_INTEGERS) {
    await mustReject(
      store.markPublished("outbox_profile", "worker_profile_a", value),
      `publish must reject fencing token ${String(value)}`,
    );
    await mustReject(
      store.recordFailure("outbox_profile", "worker_profile_a", value, fixtures.now),
      `failure recording must reject fencing token ${String(value)}`,
    );
    await mustReject(
      store.renew("lease:profile", "worker_profile_a", value, fixtures.now, 30),
      `lease renewal must reject fencing token ${String(value)}`,
    );
    await mustReject(
      store.release("lease:profile", "worker_profile_a", value),
      `lease release must reject fencing token ${String(value)}`,
    );
  }
  for (const timestamp of INVALID_UTC_TIMESTAMPS) {
    await mustReject(
      store.recordFailure("outbox_profile", "worker_profile_a", 1, timestamp),
      `failure recording must reject invalid retry timestamp ${timestamp}`,
    );
    await mustReject(
      store.renew("lease:profile", "worker_profile_a", 1, timestamp, 30),
      `lease renewal must reject invalid UTC timestamp ${timestamp}`,
    );
  }
  for (const value of INVALID_POSITIVE_INTEGERS) {
    await mustReject(
      store.renew("lease:profile", "worker_profile_a", 1, fixtures.now, value),
      `lease renewal must reject lease seconds ${String(value)}`,
    );
  }
  await mustReject(
    store.renew("", "worker_profile_a", 1, fixtures.now, 30),
    "lease renewal must reject an empty key",
  );
  await mustReject(
    store.renew("   ", "worker_profile_a", 1, fixtures.now, 30),
    "lease renewal must reject a whitespace key",
  );
  await mustReject(
    store.renew("lease:profile", "   ", 1, fixtures.now, 30),
    "lease renewal must reject a whitespace owner",
  );
  await mustReject(
    store.renew("lease:profile", "worker_profile_a", 0, fixtures.now, 30),
    "lease renewal must reject a non-positive fencing token",
  );
  await mustReject(
    store.release("", "worker_profile_a", 1),
    "lease release must reject an empty key",
  );
  await mustReject(
    store.release("   ", "worker_profile_a", 1),
    "lease release must reject a whitespace key",
  );
  await mustReject(
    store.release("lease:profile", "   ", 1),
    "lease release must reject a whitespace owner",
  );
}

async function verifyWorkerLeases(
  store: DurabilityConformanceAdapter,
  fixtures: DurabilityProfileFixtures,
): Promise<void> {
  const key = `worker:${fixtures.tenant_id}:${fixtures.partition_id}`;
  const first = await store.acquire(key, "worker_profile_a", fixtures.now, 30);
  assert.ok(first !== null, "first worker must acquire the lease");
  if (first === null) return;
  assert.equal(first.lease_key, key);
  assert.equal(first.owner, "worker_profile_a");
  requirePositiveInteger(first.fencing_token, "fencing_token");
  requireTimestamp(first.expires_at, "expires_at");
  assert.equal(
    first.expires_at,
    addUtcTimestampSeconds(fixtures.now, 30),
    "lease expiry must be exact",
  );

  // Returned leases must be detached snapshots. Mutating one must not shorten
  // the persisted lease before the owner renews it.
  const firstOwner = first.owner;
  const firstFencingToken = first.fencing_token;
  (first as { expires_at: string }).expires_at = fixtures.now;

  assert.equal(
    await store.acquire(key, "worker_profile_b", fixtures.now, 30),
    null,
    "an unexpired lease must not be stolen",
  );
  assert.equal(
    await store.acquire(key, firstOwner, fixtures.now, 30),
    null,
    "the current owner cannot re-acquire an unexpired lease",
  );
  assert.equal(
    await store.renew(key, "worker_profile_b", first.fencing_token, fixtures.now, 30),
    false,
    "a different owner cannot renew",
  );
  assert.equal(
    await store.renew(key, first.owner, first.fencing_token + 1, fixtures.now, 30),
    false,
    "a stale fencing token cannot renew",
  );
  assert.equal(
    await store.renew(key, firstOwner, firstFencingToken, fixtures.now, 60),
    true,
    "the current owner can renew with its fencing token",
  );
  assert.equal(
    await store.release(key, "worker_profile_b", firstFencingToken),
    false,
    "a different owner cannot release",
  );
  assert.equal(
    await store.release(key, firstOwner, firstFencingToken + 1),
    false,
    "the current owner cannot release with a stale token",
  );

  const renewedExpiry = addUtcTimestampSeconds(fixtures.now, 60);
  assert.equal(
    await store.acquire(
      key,
      "worker_profile_b",
      addUtcTimestampSeconds(fixtures.now, 59),
      30,
    ),
    null,
    "a renewed lease remains held before its exact expiry",
  );
  const replacement = await store.acquire(key, "worker_profile_b", renewedExpiry, 30);
  assert.ok(replacement !== null, "an expired lease is recoverable at its exact expiry");
  if (replacement === null) return;
  assert.equal(replacement.lease_key, key);
  assert.equal(replacement.owner, "worker_profile_b");
  requirePositiveInteger(replacement.fencing_token, "replacement fencing_token");
  assert.ok(replacement.fencing_token > firstFencingToken);
  requireTimestamp(replacement.expires_at, "replacement expires_at");
  assert.equal(
    replacement.expires_at,
    addUtcTimestampSeconds(renewedExpiry, 30),
    "replacement lease expiry must be exact",
  );
  assert.equal(
    await store.renew(key, firstOwner, firstFencingToken, renewedExpiry, 30),
    false,
    "the fenced owner cannot renew after takeover",
  );
  assert.equal(
    await store.release(key, firstOwner, firstFencingToken),
    false,
    "the fenced owner cannot release after takeover",
  );
  assert.equal(
    await store.release(key, replacement.owner, replacement.fencing_token),
    true,
    "the replacement owner can release",
  );
  assert.equal(
    await store.release(key, replacement.owner, replacement.fencing_token),
    false,
    "release is compare-and-set and idempotently false after removal",
  );
}

async function verifyExpiredRecovery(
  store: DurabilityConformanceAdapter,
  fixtures: DurabilityProfileFixtures,
): Promise<void> {
  const key = `worker:recovery:${fixtures.tenant_id}:${fixtures.partition_id}`;
  const first = await store.acquire(key, "worker_profile_a", fixtures.now, 10);
  assert.ok(first !== null);
  if (first === null) return;
  assert.equal(first.lease_key, key);
  assert.equal(first.owner, "worker_profile_a");
  const expiredAt = addUtcTimestampSeconds(fixtures.now, 10);
  requirePositiveInteger(first.fencing_token, "recovery fencing_token");
  requireTimestamp(first.expires_at, "recovery expires_at");
  assert.equal(first.expires_at, expiredAt, "recovery lease expiry must be exact");
  const recovered = await store.acquire(key, "worker_profile_b", expiredAt, 10);
  assert.ok(recovered !== null, "an expired owner lease must be recoverable");
  if (recovered === null) return;
  assert.equal(recovered.lease_key, key);
  assert.equal(recovered.owner, "worker_profile_b");
  requirePositiveInteger(recovered.fencing_token, "recovered fencing_token");
  assert.ok(recovered.fencing_token > first.fencing_token);
  requireTimestamp(recovered.expires_at, "recovered expires_at");
  assert.equal(
    recovered.expires_at,
    addUtcTimestampSeconds(expiredAt, 10),
    "recovered lease expiry must be exact",
  );
  assert.equal(
    await store.renew(key, first.owner, first.fencing_token, expiredAt, 10),
    false,
    "the expired owner cannot renew after recovery",
  );
  assert.equal(
    await store.release(key, first.owner, first.fencing_token),
    false,
    "the expired owner cannot release after recovery",
  );
}

async function verifyOutbox(
  store: DurabilityConformanceAdapter,
  fixtures: DurabilityProfileFixtures,
): Promise<void> {
  const initial = await store.listPending(
    fixtures.tenant_id,
    fixtures.partition_id,
  );
  assert.deepEqual(
    initial.map((record) => record.outbox_id),
    [...fixtures.outbox_ids],
    "pending rows must be ordered by partition position",
  );
  assertOrderedUnique(initial);
  const initialIdentity = new Map(
    initial.map((record) => [record.outbox_id, identity(record)]),
  );
  const initialEvents = new Map(
    initial.map((record) => [record.outbox_id, structuredClone(record.event)]),
  );
  for (const record of initial) {
    assertRecordShape(record, {
      owner: "not-used",
      now: fixtures.now,
      lease_seconds: 30,
      limit: 3,
      tenant_id: fixtures.tenant_id,
      partition_id: fixtures.partition_id,
    });
  }

  // Outbox rows and their embedded events are immutable snapshots at the SPI
  // boundary. A caller must not be able to mutate adapter state by changing a
  // returned object.
  const firstInitial = initial[0];
  assert.ok(firstInitial !== undefined);
  if (firstInitial === undefined) return;
  const firstInitialSnapshot = structuredClone(firstInitial);
  const mutableInitial = firstInitial as unknown as {
    tenant_id: string;
    event: {
      partition_position: number;
      domain_data: { position: number };
      protocol_data: { position: number };
    };
  };
  mutableInitial.tenant_id = fixtures.other_tenant_id;
  mutableInitial.event.partition_position = 999;
  mutableInitial.event.domain_data.position = 999;
  mutableInitial.event.protocol_data.position = 999;
  assert.deepEqual(
    (await store.listPending(fixtures.tenant_id, fixtures.partition_id)).find(
      (record) => record.outbox_id === firstInitialSnapshot.outbox_id,
    ),
    firstInitialSnapshot,
    "listPending must return deep-cloned outbox records",
  );
  const otherTenantPending = await store.listPending(
    fixtures.other_tenant_id,
    fixtures.partition_id,
  );
  assert.deepEqual(
    otherTenantPending.map((record) => record.tenant_id),
    otherTenantPending.map(() => fixtures.other_tenant_id),
    "pending rows must be tenant isolated",
  );
  assert.deepEqual(
    otherTenantPending.map((record) => record.outbox_id),
    [fixtures.other_tenant_outbox_id],
  );
  assert.ok(otherTenantPending.length > 0, "profile requires an other-tenant fixture row");
  for (const record of otherTenantPending) {
    assert.equal(record.partition_id, fixtures.partition_id);
    assert.equal(record.event.tenant_id, fixtures.other_tenant_id);
    assert.equal(record.event.partition_id, fixtures.partition_id);
    assertRecordShape(record, {
      owner: "not-used",
      now: fixtures.now,
      lease_seconds: 30,
      limit: otherTenantPending.length,
      tenant_id: fixtures.other_tenant_id,
      partition_id: fixtures.partition_id,
    });
  }
  const otherPartitionPending = await store.listPending(
    fixtures.tenant_id,
    fixtures.other_partition_id,
  );
  assert.deepEqual(
    otherPartitionPending.map((record) => record.outbox_id),
    [fixtures.other_partition_outbox_id],
  );
  for (const record of otherPartitionPending) {
    assert.equal(record.tenant_id, fixtures.tenant_id);
    assert.equal(record.partition_id, fixtures.other_partition_id);
    assert.equal(record.event.tenant_id, fixtures.tenant_id);
    assert.equal(record.event.partition_id, fixtures.other_partition_id);
    assertRecordShape(record, {
      owner: "not-used",
      now: fixtures.now,
      lease_seconds: 30,
      limit: otherPartitionPending.length,
      tenant_id: fixtures.tenant_id,
      partition_id: fixtures.other_partition_id,
    });
  }
  const otherPartitionEvents = new Map(
    otherPartitionPending.map((record) => [record.outbox_id, structuredClone(record.event)]),
  );

  const claim = {
    owner: "worker_profile_a",
    now: fixtures.now,
    lease_seconds: 10,
    limit: 2,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.partition_id,
  } satisfies OutboxClaim;
  const firstClaim = await store.claim(claim);
  assert.equal(firstClaim.length, 2);
  assert.deepEqual(
    firstClaim.map((record) => record.outbox_id),
    [...fixtures.outbox_ids].slice(0, 2),
  );
  for (const record of firstClaim) {
    assertRecordShape(record, claim);
    requirePositiveInteger(record.fencing_token, "claim fencing_token");
    assert.equal(record.lease_owner, claim.owner);
    assert.equal(record.lease_expires_at, addUtcTimestampSeconds(claim.now, claim.lease_seconds));
    const expected = initialIdentity.get(record.outbox_id);
    assert.ok(expected !== undefined, "claim must return a known pending row");
    if (expected !== undefined) assertStableIdentity(record, expected);
    const expectedEvent = initialEvents.get(record.outbox_id);
    assert.ok(expectedEvent !== undefined, "claim must return a known event");
    if (expectedEvent !== undefined) assert.deepEqual(record.event, expectedEvent);
  }
  assertOrderedUnique(firstClaim);
  const first = firstClaim[0];
  const second = firstClaim[1];
  assert.ok(first !== undefined && second !== undefined);
  if (first === undefined || second === undefined) return;

  const firstId = first.outbox_id;
  const firstOwner = first.lease_owner;
  const firstToken = first.fencing_token;
  assert.ok(firstOwner !== null);
  const firstEventSnapshot = initialEvents.get(first.outbox_id);
  const secondEventSnapshot = initialEvents.get(second.outbox_id);
  assert.ok(firstEventSnapshot !== undefined);
  assert.ok(secondEventSnapshot !== undefined);
  if (firstEventSnapshot === undefined || secondEventSnapshot === undefined) return;
  const mutableFirst = first as unknown as {
    event: {
      event_id: string;
      domain_data: { position: number };
      protocol_data: { position: number };
    };
  };
  mutableFirst.event.event_id = "tampered";
  mutableFirst.event.domain_data.position = 999;
  mutableFirst.event.protocol_data.position = 999;
  assert.deepEqual(
    (
      await store.listPending(fixtures.tenant_id, fixtures.partition_id)
    ).find((record) => record.outbox_id === first.outbox_id)?.event,
    firstEventSnapshot,
    "claim must return deep-cloned outbox records",
  );

  const otherClaim = await store.claim({ ...claim, owner: "worker_profile_b", limit: 10 });
  assert.deepEqual(
    otherClaim.map((record) => record.outbox_id),
    [fixtures.outbox_ids[2]],
    "a claim must not return rows leased by another owner",
  );
  assert.deepEqual(
    await store.claim(claim),
    [],
    "the same owner cannot re-claim unexpired rows",
  );
  const third = otherClaim[0];
  assert.ok(third !== undefined);
  if (third === undefined) return;
  assert.equal(await store.markPublished(third.outbox_id, "worker_profile_b", third.fencing_token), true);
  assert.equal(await store.markPublished(third.outbox_id, "worker_profile_b", third.fencing_token), false);

  assert.equal(
    await store.markPublished(firstId, "worker_profile_wrong", firstToken),
    false,
    "publish must require the matching owner",
  );
  assert.equal(
    await store.markPublished(firstId, firstOwner ?? "", firstToken + 1),
    false,
    "publish must require the matching fencing token",
  );
  assert.equal(
    await store.markPublished(firstId, firstOwner ?? "", firstToken),
    true,
  );
  assert.equal(
    await store.markPublished(firstId, firstOwner ?? "", firstToken),
    false,
    "publishing a removed row must be idempotently false",
  );

  // A new owner may take an expired outbox lease, but the old owner remains
  // fenced and cannot publish the recovered row.
  const retryAt = addUtcTimestampSeconds(claim.now, 20);
  const staleClaim = await store.claim({
    owner: "worker_stale_a",
    now: claim.now,
    lease_seconds: 10,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.other_partition_id,
  });
  assert.deepEqual(
    staleClaim.map((record) => record.outbox_id),
    [fixtures.other_partition_outbox_id],
  );
  const stale = staleClaim[0];
  assert.ok(stale !== undefined);
  if (stale === undefined) return;
  const staleClaimRequest = {
    owner: "worker_stale_a",
    now: claim.now,
    lease_seconds: 10,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.other_partition_id,
  } satisfies OutboxClaim;
  assertRecordShape(stale, staleClaimRequest);
  requirePositiveInteger(stale.fencing_token, "stale fencing_token");
  assert.equal(stale.lease_owner, staleClaimRequest.owner);
  assert.equal(
    stale.lease_expires_at,
    addUtcTimestampSeconds(staleClaimRequest.now, staleClaimRequest.lease_seconds),
  );
  const staleIdentity = identity(stale);
  const staleEventSnapshot = otherPartitionEvents.get(stale.outbox_id);
  assert.ok(staleEventSnapshot !== undefined);
  if (staleEventSnapshot === undefined) return;
  const staleEvent = staleEventSnapshot;
  assert.deepEqual(stale.event, staleEvent, "stale claim event must match its original snapshot");
  const recovered = await store.claim({
    owner: "worker_stale_b",
    now: addUtcTimestampSeconds(claim.now, 10),
    lease_seconds: 10,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.other_partition_id,
  });
  assert.equal(recovered.length, 1);
  const recoveredRow = recovered[0];
  assert.ok(recoveredRow !== undefined);
  if (recoveredRow === undefined) return;
  const recoveredNow = addUtcTimestampSeconds(claim.now, 10);
  const recoveredClaimRequest = {
    owner: "worker_stale_b",
    now: recoveredNow,
    lease_seconds: 10,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.other_partition_id,
  } satisfies OutboxClaim;
  assertRecordShape(recoveredRow, recoveredClaimRequest);
  assertStableIdentity(recoveredRow, staleIdentity);
  assert.deepEqual(recoveredRow.event, staleEvent);
  requirePositiveInteger(recoveredRow.fencing_token, "recovered outbox fencing_token");
  assert.ok(recoveredRow.fencing_token > stale.fencing_token);
  assert.equal(recoveredRow.lease_owner, recoveredClaimRequest.owner);
  assert.equal(
    recoveredRow.lease_expires_at,
    addUtcTimestampSeconds(recoveredNow, recoveredClaimRequest.lease_seconds),
  );
  assert.equal(
    await store.recordFailure(
      stale.outbox_id,
      staleClaimRequest.owner,
      stale.fencing_token,
      retryAt,
    ),
    false,
    "an expired owner must be fenced from recording failure",
  );
  assert.equal(
    await store.markPublished(stale.outbox_id, "worker_stale_a", stale.fencing_token),
    false,
    "an expired owner must be fenced from publishing",
  );
  assert.equal(
    await store.recordFailure(
      recoveredRow.outbox_id,
      recoveredClaimRequest.owner,
      recoveredRow.fencing_token,
      retryAt,
    ),
    true,
  );
  assert.equal(
    await store.recordFailure(
      recoveredRow.outbox_id,
      recoveredClaimRequest.owner,
      recoveredRow.fencing_token,
      retryAt,
    ),
    false,
    "recordFailure must be idempotently false after the first settlement",
  );

  const retryBefore = adjacentUtcNanosecond(retryAt, -1);
  const retryAfter = adjacentUtcNanosecond(retryAt, 1);
  assert.deepEqual(
    await store.claim({
      ...recoveredClaimRequest,
      owner: "worker_stale_c",
      now: retryBefore,
    }),
    [],
    "a retry must not be claimable one nanosecond early",
  );
  const recoveredRetry = await store.claim({
    ...recoveredClaimRequest,
    owner: "worker_stale_c",
    now: retryAfter,
  });
  assert.equal(recoveredRetry.length, 1);
  const recoveredRetryRow = recoveredRetry[0];
  assert.ok(recoveredRetryRow !== undefined);
  if (recoveredRetryRow === undefined) return;
  const recoveredRetryRequest = {
    ...recoveredClaimRequest,
    owner: "worker_stale_c",
    now: retryAfter,
  } satisfies OutboxClaim;
  assertRecordShape(recoveredRetryRow, recoveredRetryRequest);
  assertStableIdentity(recoveredRetryRow, staleIdentity);
  assert.deepEqual(recoveredRetryRow.event, staleEvent);
  requirePositiveInteger(recoveredRetryRow.fencing_token, "retry fencing_token");
  assert.equal(recoveredRetryRow.attempt, stale.attempt + 1);
  assert.equal(recoveredRetryRow.next_attempt_at, retryAt);
  assert.equal(
    await store.markPublished(
      recoveredRetryRow.outbox_id,
      recoveredRetryRequest.owner,
      recoveredRetryRow.fencing_token,
    ),
    true,
  );

  assert.equal(
    await store.recordFailure(second.outbox_id, "worker_profile_wrong", second.fencing_token, retryAt),
    false,
    "failure recording must require the matching owner",
  );
  assert.equal(
    await store.recordFailure(second.outbox_id, second.lease_owner ?? "", second.fencing_token + 1, retryAt),
    false,
    "failure recording must require the matching fencing token",
  );
  assert.equal(
    await store.recordFailure(second.outbox_id, second.lease_owner ?? "", second.fencing_token, retryAt),
    true,
  );
  assert.equal(
    await store.recordFailure(second.outbox_id, second.lease_owner ?? "", second.fencing_token, retryAt),
    false,
    "recordFailure must be idempotently false for the same owner/token/schedule",
  );
  requireTimestamp(retryAt, "retryAt");
  assert.deepEqual(
    (await store.listPending(fixtures.tenant_id, fixtures.partition_id)).find(
      (record) => record.outbox_id === second.outbox_id,
    ),
    expectRecord(second, retryAt),
  );

  assert.deepEqual(
    await store.claim({ ...claim, owner: "worker_profile_c", now: fixtures.now, limit: 10 }),
    [],
    "a retry scheduled in the future must not be claimable",
  );
  const retryClaim = await store.claim({
    ...claim,
    owner: "worker_profile_c",
    now: retryAt,
    limit: 1,
  });
  assert.equal(retryClaim.length, 1);
  const retry = retryClaim[0];
  assert.ok(retry !== undefined);
  if (retry !== undefined) {
    const retryRequest = {
      ...claim,
      owner: "worker_profile_c",
      now: retryAt,
      limit: 1,
    } satisfies OutboxClaim;
    assertRecordShape(retry, retryRequest);
    assertStableIdentity(retry, identity(second));
    assert.deepEqual(retry.event, secondEventSnapshot);
    requirePositiveInteger(retry.fencing_token, "retry fencing_token");
    assert.equal(retry.outbox_id, second.outbox_id);
    assert.equal(retry.tenant_id, second.tenant_id);
    assert.equal(retry.partition_id, second.partition_id);
    assert.equal(retry.position, second.position);
    assert.equal(retry.attempt, second.attempt + 1);
    assert.ok(retry.fencing_token > second.fencing_token);
    assert.equal(retry.next_attempt_at, retryAt);
    assert.equal(
      await store.markPublished(retry.outbox_id, retry.lease_owner ?? "", retry.fencing_token),
      true,
    );
  }
  assert.deepEqual(
    await store.listPending(fixtures.tenant_id, fixtures.partition_id),
    [],
    "published rows must leave the pending set",
  );

}

function expectRecord(record: OutboxRecord, retryAt: string): OutboxRecord {
  return {
    ...record,
    attempt: record.attempt + 1,
    next_attempt_at: retryAt,
    lease_owner: null,
    lease_expires_at: null,
  };
}

export async function verifyDurabilityProfile(
  factory: DurabilityStoreFactory,
  fixtures: DurabilityProfileFixtures = DEFAULT_DURABILITY_PROFILE_FIXTURES,
): Promise<void> {
  const scenarios: readonly [string, (store: DurabilityConformanceAdapter) => Promise<void>][] = [
    ["required capabilities", (store) => verifyCapabilities(store)],
    ["strict input validation", (store) => verifyStrictInputs(store, fixtures)],
    ["worker lease acquisition, fencing and release", (store) => verifyWorkerLeases(store, fixtures)],
    ["expired worker lease recovery", (store) => verifyExpiredRecovery(store, fixtures)],
    ["outbox ordering, tenant isolation, retries and publish idempotency", (store) => verifyOutbox(store, fixtures)],
  ];
  for (const [name, verify] of scenarios) {
    try {
      await verify(factory());
    } catch (error: unknown) {
      throw new Error(`Durability profile scenario "${name}" failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}
