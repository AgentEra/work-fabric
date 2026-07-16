import { describe, expect, it } from "vitest";

import { MemoryClusterAdapter } from "@work-fabric/adapter-cluster-memory";
import {
  DEFAULT_WAKEUP_TRANSPORT_FIXTURES,
  verifyWakeupTransportProfile,
} from "../src/index.js";

describe("wakeup transport conformance profile", () => {
  it("verifies a standalone metadata wakeup transport", async () => {
    await expect(verifyWakeupTransportProfile(
      () => new MemoryClusterAdapter(),
    )).resolves.toBeUndefined();
  });

  it("uses metadata-only fixtures", () => {
    expect(JSON.stringify(DEFAULT_WAKEUP_TRANSPORT_FIXTURES)).not.toMatch(
      /password|secret|credential|content|result|artifact|evidence/i,
    );
  });
});
