import { describe, expect, it } from "vitest";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import type { HealthProbe } from "../src/index.js";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "admin",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_admin",
      actor_type: "human" as const,
      endpoint_ids: ["endpoint_admin"],
    },
  ],
  attributes: {},
};

const headers = {
  authorization: "Bearer admin",
  "x-wf-actor-id": "actor_admin",
  "x-wf-endpoint-id": "endpoint_admin",
};

function fixture(probes: readonly HealthProbe[] = [], shutdownTimeoutMs = 40) {
  return createHttpService(
    {
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity: new LocalIdentityProvider([
        { authentication_evidence: { bearer_token: "admin" }, principal },
      ]),
      authority: new LocalAuthorityPolicy([
        {
          tenant_id: "tenant_01",
          principal_id: "admin",
          actor_id: "actor_admin",
          actor_type: "human",
          endpoint_id: "endpoint_admin",
          action: "workfabric.operations.health.read.v1",
          resource_id: null,
        },
      ]),
      health_probes: probes,
    },
    normalizeHttpServiceConfig({
      health_probe_timeout_ms: 15,
      shutdown_timeout_ms: shutdownTimeoutMs,
    }),
  );
}

describe("health routes and host lifecycle", () => {
  it("exposes bounded liveness, readiness, and protected dependency detail", async () => {
    const service = fixture([
      { dependency_id: "journal", async check() { return "healthy"; } },
    ]);
    const live = await service.dispatch({ method: "GET", url: "/health/live" });
    const ready = await service.dispatch({ method: "GET", url: "/health/ready" });
    const detail = await service.dispatch({ method: "GET", url: "/v1/admin/health", headers });
    expect(live.status_code).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(ready.status_code).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
    expect(detail.status_code).toBe(200);
    expect(detail.json()).toMatchObject({
      status: "ready",
      dependencies: [{ dependency_id: "journal", status: "healthy" }],
    });
    await service.close();
  });

  it("normalizes failing, throwing, and slow probes without exposing errors", async () => {
    const service = fixture([
      { dependency_id: "failed", async check() { return "unhealthy"; } },
      { dependency_id: "throwing", async check() { throw new Error("secret DSN"); } },
      {
        dependency_id: "slow",
        async check() {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "healthy";
        },
      },
    ]);
    const ready = await service.dispatch({ method: "GET", url: "/health/ready" });
    const detail = await service.dispatch({ method: "GET", url: "/v1/admin/health", headers });
    expect(ready.status_code).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(detail.status_code).toBe(503);
    expect(detail.json()).toMatchObject({
      status: "not_ready",
      dependencies: [
        { dependency_id: "failed", status: "unhealthy" },
        { dependency_id: "throwing", status: "unhealthy" },
        { dependency_id: "slow", status: "unhealthy" },
      ],
    });
    expect(detail.body).not.toContain("secret DSN");
    await service.close();
  });

  it("becomes not-ready at shutdown, closes idempotently, and refuses new connections", async () => {
    const service = fixture();
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const closing = service.close();
    const ready = await service.dispatch({ method: "GET", url: "/health/ready" });
    expect(ready.status_code).toBe(503);
    await expect(fetch(`${origin}/health/live`)).rejects.toThrow();
    await expect(Promise.all([closing, service.close()])).resolves.toBeDefined();
  });

  it("enforces the shutdown deadline for an in-flight request", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const service = createHttpService(
      {
        application: {
          async handle() {
            entered();
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            throw new Error("late");
          },
        },
        authenticator: new BearerAuthenticationEvidenceMapper(),
      },
      normalizeHttpServiceConfig({ shutdown_timeout_ms: 25 }),
    );
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: "message_slow" }),
    }).catch(() => null);
    await started;
    const before = Date.now();
    await service.close();
    expect(Date.now() - before).toBeLessThan(300);
    await request;
  });
});
