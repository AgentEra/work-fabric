import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

describe("SQLite Node service composition", () => {
  it("closes and reopens the same local profile cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-service-"));
    const config = parseServiceConfig({
      storage_profile: "sqlite-local",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      sqlite: { location: join(directory, "work-fabric.db") },
      identities: [{
        authentication_evidence: { bearer_token: "health-token" },
        principal: {
          principal_id: "principal-local", tenant_id: "tenant-local",
          actor_claims: [{ actor_id: "actor-local", actor_type: "human", endpoint_ids: ["endpoint-local"] }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local", principal_id: "principal-local",
        actor_id: "actor-local", actor_type: "human", endpoint_id: "endpoint-local",
        action: "workfabric.operations.health.read.v1", resource_id: null,
      }],
    });
    try {
      const first = await composeNodeService(config);
      await first.close();
      const second = await composeNodeService(config);
      await expect(second.http.dispatch({ method: "GET", url: "/health/ready" }))
        .resolves.toMatchObject({ status_code: 200 });
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
