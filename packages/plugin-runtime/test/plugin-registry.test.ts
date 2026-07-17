import { describe, expect, it } from "vitest";

import { PluginRegistry } from "../src/index.js";

const factory = (type: string) => ({
  type,
  validate(value: unknown) { return value; },
  async create() { throw new Error("not used"); },
});

describe("PluginRegistry", () => {
  it("rejects duplicate trusted factory types", () => {
    const registry = new PluginRegistry();
    registry.register(factory("channel.test"));
    expect(() => registry.register(factory("channel.test"))).toThrowError(/duplicate_plugin_factory/);
  });

  it("returns registered factories without loading paths from configuration", () => {
    const registry = new PluginRegistry([factory("channel.test")]);
    expect(registry.get("channel.test")?.type).toBe("channel.test");
    expect(registry.get("./untrusted.js")).toBeUndefined();
  });
});
