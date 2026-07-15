import { describe, expect, it, vi } from "vitest";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import type {
  AckResult,
  EventDeliveryDocument,
  PullResult,
} from "@work-fabric/exchange-runtime";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal_01",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_01",
      actor_type: "agent" as const,
      endpoint_ids: ["endpoint_01"],
    },
  ],
  attributes: {},
};

const headers = {
  authorization: "Bearer known",
  "content-type": "application/json",
  "x-wf-actor-id": "actor_01",
  "x-wf-endpoint-id": "endpoint_01",
};

const deliveryDocument: EventDeliveryDocument = {
  delivery_id: "delivery_01",
  subscription_id: "subscription_01",
  attempt: 1,
  events: [
    {
      specversion: "1.0",
      id: "event_01",
      source: "urn:work-fabric:exchange:test",
      type: "workfabric.handoff.accepted.v1",
      subject: "handoff_01",
      time: "2026-07-15T08:00:00.000Z",
      datacontenttype: "application/json",
      dataschema: "urn:work-fabric:schema:v1:protocol-event",
      wftenant: "tenant_01",
      wfexchange: "exchange_01",
      wfthread: "thread_01",
      wfhandoff: "handoff_01",
      wfactor: "actor_01",
      wfendpoint: "endpoint_01",
      wfsequence: 1,
      wfvisibility: "participants",
      data: { resource_version: 1 },
    },
  ],
  next_cursor: "cursor_01",
  delivered_at: "2026-07-15T08:00:00.000Z",
  visibility_expires_at: "2026-07-15T08:00:30.000Z",
};

function fixture(options: {
  readonly pull?: PullResult;
  readonly ack?: AckResult;
  readonly allowPull?: boolean;
  readonly allowAck?: boolean;
} = {}) {
  const pull = vi.fn(async (): Promise<PullResult> =>
    options.pull ?? { kind: "delivery", delivery: deliveryDocument },
  );
  const acknowledge = vi.fn(async (): Promise<AckResult> =>
    options.ack ?? { kind: "acknowledged", cursor: "cursor_01" },
  );
  const rules = [];
  if (options.allowPull !== false) {
    rules.push({
      tenant_id: "tenant_01",
      principal_id: "principal_01",
      actor_id: "actor_01",
      actor_type: "agent" as const,
      endpoint_id: "endpoint_01",
      action: "workfabric.subscription.pull.v1",
      resource_id: "subscription_01",
    });
  }
  if (options.allowAck !== false) {
    rules.push({
      tenant_id: "tenant_01",
      principal_id: "principal_01",
      actor_id: "actor_01",
      actor_type: "agent" as const,
      endpoint_id: "endpoint_01",
      action: "workfabric.subscription.ack.v1",
      resource_id: "subscription_01",
    });
  }
  const service = createHttpService(
    {
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity: new LocalIdentityProvider([
        {
          authentication_evidence: { bearer_token: "known" },
          principal,
        },
      ]),
      authority: new LocalAuthorityPolicy(rules),
      delivery: { pull, pullSse: pull, acknowledge },
    },
    normalizeHttpServiceConfig({ default_page_limit: 2, max_page_limit: 5 }),
  );
  return { service, pull, acknowledge };
}

function ackPayload(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery_01",
    subscription_id: "subscription_01",
    outcome: "acknowledged",
    acknowledged_at: "2026-07-15T08:00:10.000Z",
    cursor: "cursor_01",
    ...overrides,
  };
}

describe("durable Pull and Ack routes", () => {
  it("authorizes and returns delivery or idle results without changing their body", async () => {
    const first = fixture();
    const delivered = await first.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/pull",
      headers,
      payload: { partition_id: "partition_01", cursor: null, limit: 2 },
    });
    expect(delivered.status_code).toBe(200);
    expect(delivered.json()).toEqual({ kind: "delivery", delivery: deliveryDocument });
    expect(first.pull).toHaveBeenCalledWith(
      "subscription_01",
      "partition_01",
      null,
      2,
    );
    await first.service.close();

    const second = fixture({ pull: { kind: "idle", cursor: "cursor_idle" } });
    const idle = await second.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/pull",
      headers,
      payload: { partition_id: "partition_01" },
    });
    expect(idle.status_code).toBe(200);
    expect(idle.json()).toEqual({ kind: "idle", cursor: "cursor_idle" });
    expect(second.pull).toHaveBeenCalledWith(
      "subscription_01",
      "partition_01",
      null,
      2,
    );
    await second.service.close();
  });

  it("maps Pull errors to bounded Problem Details", async () => {
    for (const [result, status] of [
      [{ kind: "error", code: "invalid_argument", message: "private" }, 400],
      [{ kind: "error", code: "cursor_expired", message: "private" }, 410],
      [{ kind: "error", code: "precondition_failed", message: "private" }, 412],
    ] as const) {
      const { service } = fixture({ pull: result });
      const response = await service.dispatch({
        method: "POST",
        url: "/v1/subscriptions/subscription_01/pull",
        headers,
        payload: { partition_id: "partition_wrong", cursor: "cursor_bad", limit: 1 },
      });
      expect(response.status_code).toBe(status);
      expect(response.json()).toMatchObject({ code: result.code, status });
      expect(response.body).not.toContain("private");
      await service.close();
    }
  });

  it("rejects unauthenticated, unauthorized, and malformed Pull before Runtime", async () => {
    const denied = fixture({ allowPull: false });
    const unauthorized = await denied.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/pull",
      headers,
      payload: { partition_id: "partition_01" },
    });
    expect(unauthorized.status_code).toBe(403);
    expect(denied.pull).not.toHaveBeenCalled();
    await denied.service.close();

    const invalid = fixture();
    const malformed = await invalid.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/pull",
      headers,
      payload: { partition_id: "partition_01", limit: 0 },
    });
    const unauthenticated = await invalid.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/pull",
      headers: { ...headers, authorization: "Bearer unknown" },
      payload: { partition_id: "partition_01" },
    });
    expect(malformed.status_code).toBe(400);
    expect(unauthenticated.status_code).toBe(401);
    expect(invalid.pull).not.toHaveBeenCalled();
    await invalid.service.close();
  });

  it("passes a canonical matching Ack and maps every Ack outcome", async () => {
    for (const outcome of ["acknowledged", "retry", "rejected"] as const) {
      const { service, acknowledge } = fixture({
        ack: { kind: outcome, cursor: `cursor_${outcome}` },
      });
      const payload = ackPayload({ outcome });
      const response = await service.dispatch({
        method: "POST",
        url: "/v1/subscriptions/subscription_01/ack",
        headers,
        payload,
      });
      expect(response.status_code).toBe(200);
      expect(response.json()).toEqual({ kind: outcome, cursor: `cursor_${outcome}` });
      expect(acknowledge).toHaveBeenCalledWith(payload);
      await service.close();
    }
  });

  it("rejects path/body mismatch and maps Ack errors without calling Runtime early", async () => {
    const mismatch = fixture();
    const response = await mismatch.service.dispatch({
      method: "POST",
      url: "/v1/subscriptions/subscription_01/ack",
      headers,
      payload: ackPayload({ subscription_id: "subscription_other" }),
    });
    expect(response.status_code).toBe(412);
    expect(mismatch.acknowledge).not.toHaveBeenCalled();
    await mismatch.service.close();

    for (const [result, status] of [
      [{ kind: "error", code: "invalid_argument", message: "private" }, 400],
      [{ kind: "error", code: "not_found", message: "private" }, 404],
      [{ kind: "error", code: "precondition_failed", message: "private" }, 412],
      [{ kind: "error", code: "cursor_expired", message: "private" }, 410],
    ] as const) {
      const { service } = fixture({ ack: result });
      const mapped = await service.dispatch({
        method: "POST",
        url: "/v1/subscriptions/subscription_01/ack",
        headers,
        payload: ackPayload(),
      });
      expect(mapped.status_code).toBe(status);
      expect(mapped.json()).toMatchObject({ code: result.code, status });
      expect(mapped.body).not.toContain("private");
      await service.close();
    }
  });
});
