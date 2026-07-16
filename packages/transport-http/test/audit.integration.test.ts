import { describe, expect, it } from "vitest";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import { MemoryAuditStore } from "@work-fabric/adapter-operations-memory";
import { OperationAuditRecorder } from "@work-fabric/operations-runtime";
import type { CollaborationQueryService } from "@work-fabric/operations-runtime";
import type { AuditRecord, AuditStore } from "@work-fabric/operations-spi";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal-1",
  tenant_id: "tenant-1",
  actor_claims: [{
    actor_id: "actor-1",
    actor_type: "agent" as const,
    endpoint_ids: ["endpoint-1"],
  }],
  attributes: {},
};
const headers = {
  authorization: "Bearer do-not-record",
  "content-type": "application/json",
  "x-wf-actor-id": "actor-1",
  "x-wf-endpoint-id": "endpoint-1",
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

function fixture(store: AuditStore = new MemoryAuditStore()) {
  const audit = new OperationAuditRecorder(store, {
    now: () => "2026-07-16T04:00:00.000Z",
  });
  const identity = new LocalIdentityProvider([
    { authentication_evidence: { bearer_token: "do-not-record" }, principal },
  ]);
  const authority = new LocalAuthorityPolicy([{
    tenant_id: "tenant-1",
    principal_id: "principal-1",
    actor_id: "actor-1",
    actor_type: "agent" as const,
    endpoint_id: "endpoint-1",
    action: "workfabric.query.timeline.list.v1",
    resource_id: "partition-1",
  }]);
  const collaboration: CollaborationQueryService = {
    async listResponsibilities() { throw new Error("not used"); },
    async listTimeline() {
      return {
        items: [], next_cursor: null,
        freshness: {
          projector_id: "projector-1", partition_id: "partition-1",
          projected_position: 1, journal_position: 1,
          observed_at: "2026-07-16T04:00:00.000Z",
        },
      };
    },
    async listRelationships() { throw new Error("not used"); },
  };
  const application = {
    async handle() {
      return {
        spec_version: "1.0" as const,
        request_message_id: "message-1",
        operation_status: "accepted" as const,
        resource: { resource_type: "handoff", resource_id: "handoff-1" },
        receipt: null,
        error: null,
      };
    },
  };
  const service = createHttpService(
    {
      application,
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity,
      authority,
      collaboration,
      audit,
    },
    normalizeHttpServiceConfig({ default_page_limit: 10 }),
  );
  return { service, store };
}

describe("HTTP operation audit", () => {
  it("records allowed and denied route outcomes without headers or content", async () => {
    const { service, store } = fixture();
    const allowed = await service.dispatch({
      method: "GET",
      url: "/v1/timeline?partition_id=partition-1",
      headers,
    });
    const denied = await service.dispatch({
      method: "GET",
      url: "/v1/timeline?partition_id=partition-2&handoff_id=classified",
      headers,
    });
    expect([allowed.status_code, denied.status_code]).toEqual([200, 403]);

    const records = (await store.list({ tenant_id: "tenant-1", limit: 10 })).items;
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.authorization_decision).sort()).toEqual([
      "allowed", "denied",
    ]);
    expect(records.map((record) => record.outcome).sort()).toEqual([
      "failed", "succeeded",
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("do-not-record");
    expect(serialized).not.toContain("classified");
    await service.close();
  });

  it("records a trusted command outcome while omitting its payload", async () => {
    const { service, store } = fixture();
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/commands",
      headers,
      payload: {
        spec_version: "1.0",
        message_id: "message-1",
        message_type: "workfabric.handoff.accept.v1",
        sent_at: "2026-07-16T04:00:00.000Z",
        tenant_id: "tenant-1",
        exchange_id: "exchange-1",
        actor_id: "actor-1",
        endpoint_id: "endpoint-1",
        idempotency_key: "accept-1",
        payload: { handoff_id: "handoff-1", note: "classified-body" },
      },
    });
    expect(response.status_code).toBe(200);
    const records = (await store.list({ tenant_id: "tenant-1", limit: 10 })).items;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "workfabric.handoff.accept.v1",
      resource_kind: "handoff",
      resource_id: "handoff-1",
      principal_id: "principal-1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(records)).not.toContain("classified-body");
    await service.close();
  });

  it("keeps a committed command response intact and degrades readiness when audit persistence fails", async () => {
    const failingStore: AuditStore = {
      manifest: new MemoryAuditStore().manifest,
      async append(_record: AuditRecord) { throw new Error("credential detail"); },
      async list() { return { items: [], next_cursor: null }; },
      async pruneBefore() { return 0; },
    };
    const { service } = fixture(failingStore);
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/commands",
      headers,
      payload: {
        spec_version: "1.0",
        message_id: "message-2",
        message_type: "workfabric.handoff.accept.v1",
        sent_at: "2026-07-16T04:00:00.000Z",
        tenant_id: "tenant-1",
        exchange_id: "exchange-1",
        actor_id: "actor-1",
        endpoint_id: "endpoint-1",
        idempotency_key: "accept-2",
        payload: { handoff_id: "handoff-1" },
      },
    });
    const readiness = await service.dispatch({ method: "GET", url: "/health/ready" });
    expect(response.status_code).toBe(200);
    expect(readiness.status_code).toBe(503);
    expect(readiness.body).not.toContain("credential detail");
    await service.close();
  });
});
