import assert from "node:assert/strict";

import {
  addUtcTimestampSeconds,
  assertCapabilities,
  compareUtcTimestamps,
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
  readonly now: string;
}

export const DEFAULT_DURABILITY_PROFILE_FIXTURES: DurabilityProfileFixtures = {
  tenant_id: "tenant_01",
  other_tenant_id: "tenant_02",
  partition_id: "partition_01",
  other_partition_id: "partition_02",
  outbox_ids: ["outbox_01", "outbox_02", "outbox_03"],
  now: "2026-07-15T00:00:00.000Z",
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

async function mustReject(operation: Promise<unknown>, reason: string): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(reason);
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
    store.claim({ ...claim, now: "2026-07-15 00:00:00Z" }),
    "claim must reject a non-UTC timestamp",
  );
  await mustReject(
    store.claim({ ...claim, lease_seconds: 0 }),
    "claim must reject a non-positive lease",
  );
  await mustReject(
    store.claim({ ...claim, limit: 0 }),
    "claim must reject a non-positive limit",
  );
  await mustReject(
    store.claim({ ...claim, tenant_id: "" }),
    "claim must reject an empty tenant",
  );
  await mustReject(
    store.claim({ ...claim, partition_id: "" }),
    "claim must reject an empty partition",
  );
  await mustReject(
    store.acquire("", "worker_profile_a", fixtures.now, 30),
    "lease acquire must reject an empty key",
  );
  await mustReject(
    store.acquire("lease:profile", "", fixtures.now, 30),
    "lease acquire must reject an empty owner",
  );
  await mustReject(
    store.acquire("lease:profile", "worker_profile_a", "not-a-time", 30),
    "lease acquire must reject an invalid timestamp",
  );
  await mustReject(
    store.acquire("lease:profile", "worker_profile_a", fixtures.now, 0),
    "lease acquire must reject a non-positive duration",
  );
  await mustReject(
    store.listPending("", fixtures.partition_id),
    "listPending must reject an empty tenant",
  );
  await mustReject(
    store.listPending(fixtures.tenant_id, ""),
    "listPending must reject an empty partition",
  );
  await mustReject(
    store.markPublished("", "worker_profile_a", 1),
    "publish must reject an empty outbox ID",
  );
  await mustReject(
    store.markPublished("outbox_profile", "", 1),
    "publish must reject an empty owner",
  );
  await mustReject(
    store.markPublished("outbox_profile", "worker_profile_a", 0),
    "publish must reject a non-positive fencing token",
  );
  await mustReject(
    store.recordFailure("outbox_profile", "worker_profile_a", 1, "not-a-time"),
    "failure recording must reject an invalid retry timestamp",
  );
  await mustReject(
    store.renew("", "worker_profile_a", 1, fixtures.now, 30),
    "lease renewal must reject an empty key",
  );
  await mustReject(
    store.renew("lease:profile", "worker_profile_a", 0, fixtures.now, 30),
    "lease renewal must reject a non-positive fencing token",
  );
  await mustReject(
    store.release("", "worker_profile_a", 1),
    "lease release must reject an empty key",
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
  assert.ok(compareUtcTimestamps(first.expires_at, fixtures.now) > 0);

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
    await store.release(key, "worker_profile_b", first.fencing_token),
    false,
    "a different owner cannot release",
  );
  assert.equal(
    await store.release(key, firstOwner, firstFencingToken),
    true,
    "the current owner can release",
  );
  assert.equal(
    await store.release(key, firstOwner, firstFencingToken),
    false,
    "release is compare-and-set and idempotently false after removal",
  );

  const replacement = await store.acquire(key, "worker_profile_b", fixtures.now, 30);
  assert.ok(replacement !== null);
  if (replacement !== null) {
    assert.ok(replacement.fencing_token > firstFencingToken);
  }
}

async function verifyExpiredRecovery(
  store: DurabilityConformanceAdapter,
  fixtures: DurabilityProfileFixtures,
): Promise<void> {
  const key = `worker:recovery:${fixtures.tenant_id}:${fixtures.partition_id}`;
  const first = await store.acquire(key, "worker_profile_a", fixtures.now, 10);
  assert.ok(first !== null);
  if (first === null) return;
  const expiredAt = addUtcTimestampSeconds(fixtures.now, 10);
  const recovered = await store.acquire(key, "worker_profile_b", expiredAt, 10);
  assert.ok(recovered !== null, "an expired owner lease must be recoverable");
  if (recovered === null) return;
  assert.ok(recovered.fencing_token > first.fencing_token);
  assert.ok(compareUtcTimestamps(recovered.expires_at, expiredAt) > 0);
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
    event: { partition_position: number };
  };
  mutableInitial.tenant_id = fixtures.other_tenant_id;
  mutableInitial.event.partition_position = 999;
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
  assert.ok(otherTenantPending.length > 0, "profile requires an other-tenant fixture row");
  assert.deepEqual(
    (await store.listPending(fixtures.tenant_id, fixtures.other_partition_id)).map(
      (record) => record.outbox_id,
    ),
    ["outbox_other_partition"],
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
  const firstClaimSnapshot = structuredClone(first);
  (first as unknown as { event: { event_id: string } }).event.event_id = "tampered";
  assert.equal(
    (
      await store.listPending(fixtures.tenant_id, fixtures.partition_id)
    ).find((record) => record.outbox_id === firstClaimSnapshot.outbox_id)?.event
      .event_id,
    firstClaimSnapshot.event.event_id,
    "claim must return deep-cloned outbox records",
  );

  const otherClaim = await store.claim({ ...claim, owner: "worker_profile_b", limit: 10 });
  assert.deepEqual(
    otherClaim.map((record) => record.outbox_id),
    [fixtures.outbox_ids[2]],
    "a claim must not return rows leased by another owner",
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
  const staleClaim = await store.claim({
    owner: "worker_stale_a",
    now: claim.now,
    lease_seconds: 10,
    limit: 1,
    tenant_id: fixtures.tenant_id,
    partition_id: fixtures.other_partition_id,
  });
  assert.deepEqual(staleClaim.map((record) => record.outbox_id), ["outbox_other_partition"]);
  const stale = staleClaim[0];
  assert.ok(stale !== undefined);
  if (stale === undefined) return;
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
  assert.ok(recoveredRow.fencing_token > stale.fencing_token);
  assert.equal(
    await store.markPublished(stale.outbox_id, "worker_stale_a", stale.fencing_token),
    false,
    "an expired owner must be fenced from publishing",
  );
  assert.equal(
    await store.markPublished(
      recoveredRow.outbox_id,
      "worker_stale_b",
      recoveredRow.fencing_token,
    ),
    true,
  );

  const retryAt = addUtcTimestampSeconds(claim.now, 20);
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
    assert.equal(retry.outbox_id, second.outbox_id);
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
