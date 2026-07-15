import { describe, expect, it } from "vitest";

import {
  assertCapabilities,
  type CapabilityManifest,
} from "../src/index.js";

const manifest: CapabilityManifest = {
  profile: "exchange.persistence.v1",
  adapter: "memory",
  capabilities: {
    atomic_multi_stream_append: true,
    partitioned_journal: true,
    immutable_events: true,
  },
};

describe("CapabilityManifest", () => {
  it("accepts an adapter that satisfies every required capability", () => {
    expect(() =>
      assertCapabilities(manifest, [
        "atomic_multi_stream_append",
        "partitioned_journal",
      ]),
    ).not.toThrow();
  });

  it("rejects a missing or false required capability", () => {
    expect(() =>
      assertCapabilities(manifest, ["tenant_isolation"]),
    ).toThrow("Missing required capability: tenant_isolation");
  });
});
