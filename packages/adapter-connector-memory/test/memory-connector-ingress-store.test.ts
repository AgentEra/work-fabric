import { describe, it } from "vitest";

import { verifyConnectorIngressProfile } from "@work-fabric/exchange-conformance";

import { MemoryConnectorIngressStore } from "../src/index.js";

describe("Memory Connector ingress store", () => {
  it("satisfies the generic Connector ingress profile", async () => {
    await verifyConnectorIngressProfile(
      () => new MemoryConnectorIngressStore(),
    );
  });
});
