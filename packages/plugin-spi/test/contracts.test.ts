import { describe, expect, it } from "vitest";

import type {
  PluginContext,
  PluginFactory,
  PluginHealth,
  PluginInstance,
} from "../src/index.js";

describe("Plugin SPI", () => {
  it("defines trusted factory and bounded lifecycle contracts", () => {
    const health: PluginHealth = { state: "healthy", code: "ready" };
    const context: PluginContext = {
      configuration_revision: "sha256:1",
      service: { get() { throw new Error("not configured"); } },
    };
    const instance: PluginInstance = {
      async prepare() {}, async start() {}, async health() { return health; }, async stop() {},
    };
    const factory: PluginFactory = {
      type: "test.channel",
      validate(value) { return value; },
      async create() { return instance; },
    };
    expect(factory.type).toBe("test.channel");
    expect(context.configuration_revision).toBe("sha256:1");
  });
});
