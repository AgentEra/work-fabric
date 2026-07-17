import { describe, it } from "vitest";
import { verifyChannelRouteStoreProfile } from "@work-fabric/exchange-conformance";
import { MemoryChannelRouteStore } from "../src/index.js";

describe("MemoryChannelRouteStore", () => {
  it("passes the shared profile", async () => {
    await verifyChannelRouteStoreProfile(() => new MemoryChannelRouteStore());
  });
});
