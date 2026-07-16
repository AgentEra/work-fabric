import { describe, expect, it } from "vitest";

import type { SemanticObservation } from "@work-fabric/operations-spi";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "@work-fabric/transport-http";

describe("semantic instrumentation hooks", () => {
  it("observes HTTP outcomes without changing the response", async () => {
    const observed: SemanticObservation[] = [];
    const service = createHttpService({
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      telemetry: { observe(value) { observed.push(value); } },
    }, normalizeHttpServiceConfig({}));

    const response = await service.dispatch({ method: "GET", url: "/health/live" });

    expect(response.status_code).toBe(200);
    expect(observed).toMatchObject([{
      operation: "http_request",
      outcome: "succeeded",
      category: "http",
      count: 1,
    }]);
    expect(observed[0]?.correlation_id).toMatch(/^req-/);
    await service.close();
  });

  it("isolates a throwing exporter from request processing", async () => {
    const service = createHttpService({
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      telemetry: { observe() { throw new Error("exporter unavailable"); } },
    }, normalizeHttpServiceConfig({}));

    await expect(service.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await service.close();
  });
});
