import assert from "node:assert/strict";

import {
  CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
  type ConnectorIngressEnvelope,
  type ConnectorIngressStore,
} from "@work-fabric/connector-spi";
import { assertCapabilities } from "@work-fabric/exchange-spi";

export type ConnectorIngressStoreFactory = () => ConnectorIngressStore;

function envelope(
  overrides: Partial<ConnectorIngressEnvelope> = {},
): ConnectorIngressEnvelope {
  return {
    tenant_id: "tenant_profile_01",
    connector_id: "connector_profile_01",
    source_system: "profile-system",
    external_tenant_id: "external_tenant_01",
    external_event_id: "external_event_01",
    dedupe_key: "message:01",
    event_type: "message.received",
    partition_key: "conversation:01",
    occurred_at: "2026-07-15T00:00:00Z",
    received_at: "2026-07-15T00:00:01Z",
    payload: { message_id: "message_01", nested: { value: "original" } },
    trace_context: { correlation_id: "correlation_01" },
    ...overrides,
  };
}

async function rejects(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(message);
}

export async function verifyConnectorIngressProfile(
  factory: ConnectorIngressStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "connector.ingress.v1");
  assertCapabilities(store.manifest, CONNECTOR_INGRESS_REQUIRED_CAPABILITIES);

  const original = envelope();
  const accepted = await store.accept(original);
  assert.equal(accepted.kind, "accepted");
  (original.payload.nested as { value: string }).value = "mutated";
  assert.deepEqual((await store.get({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_profile_01",
    ingress_id: accepted.record.ingress_id,
  }))?.envelope.payload, {
    message_id: "message_01",
    nested: { value: "original" },
  });

  const duplicate = await store.accept(envelope());
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.record.ingress_id, accepted.record.ingress_id);
  await rejects(
    store.accept(envelope({ payload: { message_id: "changed" } })),
    "semantic dedupe-key reuse must reject",
  );
  assert.equal(
    (await store.accept(envelope({ tenant_id: "tenant_other" }))).kind,
    "accepted",
  );
  await rejects(
    store.accept(envelope({
      connector_id: "connector_secret",
      dedupe_key: "secret:01",
      payload: { app_secret: "must-not-be-persisted" },
    })),
    "secret-shaped payload properties must reject",
  );
  await rejects(
    store.accept(envelope({
      connector_id: "connector_oversized",
      dedupe_key: "oversized:01",
      payload: { content: "x".repeat(300_000) },
    })),
    "oversized payload must reject",
  );

  const firstClaim = (await store.claim({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_profile_01",
    worker_id: "worker_01",
    now: "2026-07-15T00:00:02Z",
    lease_seconds: 5,
    limit: 1,
  }))[0];
  assert.ok(firstClaim);
  assert.equal(firstClaim.ingress_id, accepted.record.ingress_id);
  assert.equal(firstClaim.attempt, 1);
  (firstClaim.envelope.payload.nested as { value: string }).value = "claim_mutation";
  assert.notDeepEqual(
    (await store.get({
      tenant_id: "tenant_profile_01",
      connector_id: "connector_profile_01",
      ingress_id: firstClaim.ingress_id,
    }))?.envelope.payload,
    firstClaim.envelope.payload,
  );
  await rejects(
    store.complete({
      tenant_id: firstClaim.envelope.tenant_id,
      connector_id: firstClaim.envelope.connector_id,
      ingress_id: firstClaim.ingress_id,
      claim_token: "stale-token",
      fencing_token: firstClaim.fencing_token,
      now: "2026-07-15T00:00:03Z",
    }),
    "wrong claim token must reject",
  );

  const retry = await store.retry({
    tenant_id: firstClaim.envelope.tenant_id,
    connector_id: firstClaim.envelope.connector_id,
    ingress_id: firstClaim.ingress_id,
    claim_token: firstClaim.claim_token,
    fencing_token: firstClaim.fencing_token,
    now: "2026-07-15T00:00:03Z",
    available_at: "2026-07-15T00:00:10Z",
    error_code: "temporary_failure",
    error_detail: "safe detail",
  });
  assert.equal(retry.state, "retry_wait");
  assert.equal((await store.claim({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_profile_01",
    worker_id: "worker_02",
    now: "2026-07-15T00:00:09Z",
    lease_seconds: 5,
    limit: 1,
  })).length, 0);
  const retryClaim = (await store.claim({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_profile_01",
    worker_id: "worker_02",
    now: "2026-07-15T00:00:10Z",
    lease_seconds: 5,
    limit: 1,
  }))[0];
  assert.ok(retryClaim);
  assert.ok(retryClaim.fencing_token > firstClaim.fencing_token);
  await rejects(
    store.complete({
      tenant_id: firstClaim.envelope.tenant_id,
      connector_id: firstClaim.envelope.connector_id,
      ingress_id: firstClaim.ingress_id,
      claim_token: firstClaim.claim_token,
      fencing_token: firstClaim.fencing_token,
      now: "2026-07-15T00:00:11Z",
    }),
    "previous claim must be fenced",
  );
  assert.equal((await store.complete({
    tenant_id: retryClaim.envelope.tenant_id,
    connector_id: retryClaim.envelope.connector_id,
    ingress_id: retryClaim.ingress_id,
    claim_token: retryClaim.claim_token,
    fencing_token: retryClaim.fencing_token,
    now: "2026-07-15T00:00:11Z",
  })).state, "completed");

  const leaseEnvelope = envelope({
    connector_id: "connector_lease",
    external_event_id: "external_lease",
    dedupe_key: "lease:01",
  });
  await store.accept(leaseEnvelope);
  const leaseClaim = (await store.claim({
    tenant_id: leaseEnvelope.tenant_id,
    connector_id: leaseEnvelope.connector_id,
    worker_id: "worker_crashed",
    now: "2026-07-15T00:01:00Z",
    lease_seconds: 5,
    limit: 1,
  }))[0];
  assert.ok(leaseClaim);
  assert.equal((await store.claim({
    tenant_id: leaseEnvelope.tenant_id,
    connector_id: leaseEnvelope.connector_id,
    worker_id: "worker_recovery",
    now: "2026-07-15T00:01:04Z",
    lease_seconds: 5,
    limit: 1,
  })).length, 0);
  await rejects(
    store.complete({
      tenant_id: leaseClaim.envelope.tenant_id,
      connector_id: leaseClaim.envelope.connector_id,
      ingress_id: leaseClaim.ingress_id,
      claim_token: leaseClaim.claim_token,
      fencing_token: leaseClaim.fencing_token,
      now: "2026-07-15T00:01:06Z",
    }),
    "an expired claim must not commit even before recovery",
  );
  const recovered = (await store.claim({
    tenant_id: leaseEnvelope.tenant_id,
    connector_id: leaseEnvelope.connector_id,
    worker_id: "worker_recovery",
    now: "2026-07-15T00:01:06Z",
    lease_seconds: 5,
    limit: 1,
  }))[0];
  assert.ok(recovered);
  assert.ok(recovered.fencing_token > leaseClaim.fencing_token);

  const deadEnvelope = envelope({
    connector_id: "connector_dead",
    external_event_id: "external_dead",
    dedupe_key: "dead:01",
  });
  await store.accept(deadEnvelope);
  const deadClaim = (await store.claim({
    tenant_id: deadEnvelope.tenant_id,
    connector_id: deadEnvelope.connector_id,
    worker_id: "worker_dead",
    now: "2026-07-15T00:02:00Z",
    lease_seconds: 5,
    limit: 1,
  }))[0];
  assert.ok(deadClaim);
  const dead = await store.deadLetter({
    tenant_id: deadEnvelope.tenant_id,
    connector_id: deadEnvelope.connector_id,
    ingress_id: deadClaim.ingress_id,
    claim_token: deadClaim.claim_token,
    fencing_token: deadClaim.fencing_token,
    now: "2026-07-15T00:02:01Z",
    error_code: "permanent_failure",
  });
  assert.equal(dead.state, "dead_letter");
  assert.equal((await store.claim({
    tenant_id: deadEnvelope.tenant_id,
    connector_id: deadEnvelope.connector_id,
    worker_id: "worker_dead",
    now: "2026-07-15T00:02:02Z",
    lease_seconds: 5,
    limit: 1,
  })).length, 0);
  await store.requeue({
    tenant_id: deadEnvelope.tenant_id,
    connector_id: deadEnvelope.connector_id,
    ingress_id: dead.ingress_id,
    now: "2026-07-15T00:02:03Z",
    available_at: "2026-07-15T00:02:04Z",
    reason: "operator_reviewed",
  });
  assert.equal((await store.claim({
    tenant_id: deadEnvelope.tenant_id,
    connector_id: deadEnvelope.connector_id,
    worker_id: "worker_dead",
    now: "2026-07-15T00:02:04Z",
    lease_seconds: 5,
    limit: 1,
  })).length, 1);

  await store.accept(envelope({
    connector_id: "connector_page",
    external_event_id: "page_01",
    dedupe_key: "page:01",
  }));
  await store.accept(envelope({
    connector_id: "connector_page",
    external_event_id: "page_02",
    dedupe_key: "page:02",
    received_at: "2026-07-15T00:00:02Z",
  }));
  const page1 = await store.list({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_page",
    limit: 1,
  });
  assert.equal(page1.items.length, 1);
  assert.ok(page1.next_cursor);
  const page2 = await store.list({
    tenant_id: "tenant_profile_01",
    connector_id: "connector_page",
    cursor: page1.next_cursor,
    limit: 1,
  });
  assert.equal(page2.items.length, 1);
  assert.notEqual(page1.items[0]?.ingress_id, page2.items[0]?.ingress_id);
  await rejects(
    store.list({
      tenant_id: "tenant_other",
      connector_id: "connector_page",
      cursor: page1.next_cursor,
      limit: 1,
    }),
    "cross-tenant cursor reuse must reject",
  );
}
