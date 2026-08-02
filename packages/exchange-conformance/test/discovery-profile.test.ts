import { describe, it } from "vitest";

import { MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";

import { verifyDiscoveryStoreProfile } from "../src/discovery-profile.js";

describe("Discovery store profile", () => {
  it("accepts the bounded Memory implementation", async () => {
    await verifyDiscoveryStoreProfile(() => new MemoryDiscoveryStore({
      max_records_per_origin: 8,
      tombstone_retention_seconds: 300,
    }));
  });
});
