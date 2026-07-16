import { describe, expect, it } from "vitest";

import { LocalAuthorityPolicy, LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { RecoveryService } from "@work-fabric/operations-runtime";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal-1", tenant_id: "tenant-1",
  actor_claims: [{ actor_id: "actor-1", actor_type: "agent" as const, endpoint_ids: ["endpoint-1"] }],
  attributes: {},
};
const headers = {
  authorization: "Bearer known", "content-type": "application/json",
  "x-wf-actor-id": "actor-1", "x-wf-endpoint-id": "endpoint-1",
};

function fixture(allow = true) {
  const store = new MemoryRecoveryStore();
  const recovery = new RecoveryService(store, { now: () => "2026-07-16T06:00:00.000Z" });
  const grants = allow ? [{
    tenant_id: "tenant-1", principal_id: "principal-1", actor_id: "actor-1",
    actor_type: "agent" as const, endpoint_id: "endpoint-1",
    action: "workfabric.operations.recovery.connector-requeue.request.v1",
    resource_id: "connector-1",
  }] : [];
  const service = createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity: new LocalIdentityProvider([{ authentication_evidence: { bearer_token: "known" }, principal }]),
    authority: new LocalAuthorityPolicy(grants),
    recovery,
  }, normalizeHttpServiceConfig({}));
  return { service, store };
}

const body = {
  idempotency_key: "recovery-key-1",
  target: {
    kind: "connector_requeue",
    connector_id: "connector-1",
    ingress_id: "ingress-1",
    available_at: "2026-07-16T06:01:00.000Z",
  },
  expected_version: 2,
  reason: "operator_requested",
};

describe("recovery routes", () => {
  it("accepts and replays an authorized explicit request without executing work", async () => {
    const { service, store } = fixture();
    const accepted = await service.dispatch({ method: "POST", url: "/v1/operations/recoveries", headers, payload: body });
    const replayed = await service.dispatch({ method: "POST", url: "/v1/operations/recoveries", headers, payload: structuredClone(body) });
    expect([accepted.status_code, replayed.status_code]).toEqual([202, 200]);
    expect(accepted.json()).toMatchObject({ kind: "accepted", recovery: { state: "pending" } });
    expect(replayed.json()).toMatchObject({ kind: "replayed" });
    const recoveryId = (accepted.json() as { recovery: { recovery_id: string } }).recovery.recovery_id;
    await expect(store.get("tenant-1", recoveryId)).resolves.toMatchObject({ state: "pending" });
    await service.close();
  });

  it("denies before persistence and rejects content-bearing extras", async () => {
    const deniedFixture = fixture(false);
    const denied = await deniedFixture.service.dispatch({
      method: "POST", url: "/v1/operations/recoveries", headers, payload: body,
    });
    expect(denied.status_code).toBe(403);
    expect(await deniedFixture.store.claim({
      tenant_id: "tenant-1", worker_id: "worker-1",
      now: "2026-07-16T06:00:00.000Z", lease_seconds: 30, limit: 10,
    })).toEqual([]);
    await deniedFixture.service.close();

    const allowed = fixture();
    const unsafe = await allowed.service.dispatch({
      method: "POST", url: "/v1/operations/recoveries", headers,
      payload: { ...body, access_token: "must-not-enter-recovery" },
    });
    expect(unsafe.status_code).toBe(400);
    await allowed.service.close();
  });
});
