import { describe, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";

import { verifyConnectorIngressProfile } from "../src/index.js";

describe("Connector ingress conformance profile", () => {
  it("accepts the reference Memory implementation", async () => {
    await verifyConnectorIngressProfile(
      () => new MemoryConnectorIngressStore(),
    );
  });
});
