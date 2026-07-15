import { describe, it } from "vitest";

import {
  verifyEndpointDirectoryProfile,
  verifyEndpointInboxProfile,
} from "@work-fabric/exchange-conformance";

import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "../src/index.js";

describe("Memory Endpoint stores", () => {
  it("satisfies the Endpoint Directory profile", async () => {
    await verifyEndpointDirectoryProfile(
      () => new MemoryEndpointDirectoryStore(),
    );
  });

  it("satisfies the Endpoint inbox profile", async () => {
    await verifyEndpointInboxProfile(() => new MemoryEndpointInboxStore());
  });
});
