import { describe, expect, it } from "vitest";

import type { JsonObject } from "@work-fabric/exchange-spi";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

function fixture(outcome: "accepted" | "conflict" | "temporarily_unavailable" = "accepted") {
  const calls: Array<{ envelope: unknown; evidence: JsonObject }> = [];
  const application = {
    async handle(envelope: unknown, evidence: JsonObject) {
      calls.push({ envelope: structuredClone(envelope), evidence: structuredClone(evidence) });
      if (outcome === "accepted") {
        return {
          spec_version: "1.0" as const,
          request_message_id: "message_01",
          operation_status: "accepted" as const,
          resource: { resource_type: "handoff", resource_id: "handoff_01", resource_version: 1 },
          receipt: null,
          error: null,
        };
      }
      return {
        spec_version: "1.0" as const,
        request_message_id: "message_01",
        operation_status: outcome,
        resource: null,
        receipt: null,
        error: { code: outcome === "conflict" ? "version_conflict" : "temporarily_unavailable" },
      };
    },
  };
  return {
    calls,
    service: createHttpService(
      { application, authenticator: new BearerAuthenticationEvidenceMapper() },
      normalizeHttpServiceConfig({ body_limit_bytes: 512 }),
    ),
  };
}

const envelope = {
  spec_version: "1.0",
  message_id: "message_01",
  message_type: "workfabric.handoff.accept.v1",
  sent_at: "2026-07-15T00:00:00Z",
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  idempotency_key: "accept-01",
  expected_version: 1,
  payload: { handoff_id: "handoff_01" },
};

describe("POST /v1/commands", () => {
  it("passes the canonical body and Bearer evidence to ExchangeApplication", async () => {
    const { service, calls } = fixture();
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/commands",
      headers: { authorization: "Bearer known", "content-type": "application/json" },
      payload: envelope,
    });

    expect(response.status_code).toBe(200);
    expect(response.json()).toMatchObject({ operation_status: "accepted" });
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(calls).toEqual([{ envelope, evidence: { bearer_token: "known" } }]);
    await service.close();
  });

  it("lets the Application produce the normal unauthenticated result", async () => {
    const { service, calls } = fixture();
    await service.dispatch({
      method: "POST", url: "/v1/commands",
      headers: { "content-type": "application/json" }, payload: envelope,
    });
    expect(calls[0]?.evidence).toEqual({});
    await service.close();
  });

  it.each([
    ["conflict", 409],
    ["temporarily_unavailable", 503],
  ] as const)("maps %s to HTTP %i", async (outcome, status) => {
    const { service } = fixture(outcome);
    const response = await service.dispatch({
      method: "POST", url: "/v1/commands",
      headers: { authorization: "Bearer known", "content-type": "application/json" },
      payload: envelope,
    });
    expect(response.status_code).toBe(status);
    expect(response.json()).toMatchObject({ operation_status: outcome });
    await service.close();
  });

  it("rejects unsupported media type before Application", async () => {
    const { service, calls } = fixture();
    const response = await service.dispatch({
      method: "POST", url: "/v1/commands",
      headers: { "content-type": "text/plain" }, payload: JSON.stringify(envelope),
    });
    expect(response.status_code).toBe(415);
    expect(calls).toHaveLength(0);
    await service.close();
  });

  it("rejects excessive bodies before Application", async () => {
    const { service, calls } = fixture();
    const response = await service.dispatch({
      method: "POST", url: "/v1/commands",
      headers: { "content-type": "application/json" },
      payload: { ...envelope, payload: { handoff_id: "x".repeat(1_000) } },
    });
    expect(response.status_code).toBe(413);
    expect(calls).toHaveLength(0);
    await service.close();
  });
});
