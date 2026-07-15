import { describe, expect, it } from "vitest";

import { assertCapabilities, DURABILITY_REQUIRED_CAPABILITIES, PROJECTION_REQUIRED_CAPABILITIES, SUBSCRIPTION_REQUIRED_CAPABILITIES } from "@work-fabric/exchange-spi";
import { PostgresRuntimeState } from "@work-fabric/adapter-storage-postgres";

describe("PostgreSQL runtime adapter contract", () => {
  it("advertises durability, projection and subscription capability boundaries", () => {
    const state = new PostgresRuntimeState(() => ({
      tenant_id: "tenant_01",
      withTransaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    }));
    assertCapabilities(state.manifest, DURABILITY_REQUIRED_CAPABILITIES);
    assertCapabilities(state.manifest, PROJECTION_REQUIRED_CAPABILITIES);
    assertCapabilities(state.manifest, SUBSCRIPTION_REQUIRED_CAPABILITIES);
    expect(state.manifest.adapter).toBe("postgres");
  });
});
