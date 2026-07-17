import { describe, expect, it } from "vitest";

import type {
  ConfigurationDocument,
  ConfigurationProvider,
} from "../src/index.js";

describe("Configuration Provider contracts", () => {
  it("exposes only a source revision and source-neutral value", async () => {
    const document: ConfigurationDocument = {
      revision: "sha256:abc",
      value: { api_version: "workfabric.config/v1" },
    };
    const provider: ConfigurationProvider = { async load() { return document; } };

    await expect(provider.load()).resolves.toEqual(document);
    expect(Object.keys(document)).toEqual(["revision", "value"]);
  });
});
