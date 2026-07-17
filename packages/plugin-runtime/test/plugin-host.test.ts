import { describe, expect, it } from "vitest";

import {
  PluginHost,
  PluginRegistry,
  type PluginHostConfiguration,
} from "../src/index.js";
import type { PluginFactory, PluginInstance } from "@work-fabric/plugin-spi";

function setup(failAt?: string) {
  const calls: string[] = [];
  const factory: PluginFactory = {
    type: "channel.test",
    validate(value) { return value; },
    async create(_context, config) {
      calls.push(`create:${config.instance_id}`);
      const lifecycle = (name: string) => async () => {
        calls.push(`${name}:${config.instance_id}`);
        if (`${name}:${config.instance_id}` === failAt) throw new Error("boom");
      };
      return {
        prepare: lifecycle("prepare"),
        start: lifecycle("start"),
        stop: lifecycle("stop"),
        async health() { return { state: "healthy", code: "ready" }; },
      } satisfies PluginInstance;
    },
  };
  const configuration: PluginHostConfiguration = {
    z: { type: "channel.test", enabled: true, config: { name: "z" } },
    disabled: { type: "future.missing", enabled: false, config: {} },
    a: { type: "channel.test", enabled: true, config: { name: "a" } },
  };
  const host = new PluginHost({
    registry: new PluginRegistry([factory]),
    context: {
      configuration_revision: "1",
      service: { get() { throw new Error("not configured"); } },
    },
    configuration,
  });
  return { calls, host };
}

describe("PluginHost", () => {
  it("creates, prepares, and starts enabled instances in stable order", async () => {
    const { calls, host } = setup();
    await host.prepare();
    await host.start();
    expect(calls).toEqual([
      "create:a", "create:z", "prepare:a", "prepare:z", "start:a", "start:z",
    ]);
    expect((await host.health()).map((item) => item.instance_id)).toEqual(["a", "z"]);
  });

  it("rolls back prepared instances in reverse order", async () => {
    const { calls, host } = setup("prepare:z");
    await expect(host.prepare()).rejects.toThrow("boom");
    expect(calls).toEqual([
      "create:a", "create:z", "prepare:a", "prepare:z", "stop:z", "stop:a",
    ]);
  });

  it("rolls back all created instances when creation fails", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry([{
      type: "channel.test", validate: (value) => value,
      async create(_context, config) {
        calls.push(`create:${config.instance_id}`);
        if (config.instance_id === "z") throw new Error("create failed");
        return { async prepare() {}, async start() {}, async health() { return { state: "healthy" as const }; }, async stop() { calls.push("stop:a"); } };
      },
    }]);
    const host = new PluginHost({
      registry,
      context: { configuration_revision: "1", service: { get() { throw new Error("not configured"); } } },
      configuration: {
        a: { type: "channel.test", enabled: true, config: {} },
        z: { type: "channel.test", enabled: true, config: {} },
      },
    });
    await expect(host.prepare()).rejects.toThrow("create failed");
    expect(calls).toEqual(["create:a", "create:z", "stop:a"]);
  });

  it("stops started instances in reverse order and remains idempotent", async () => {
    const { calls, host } = setup();
    await host.prepare();
    await host.start();
    await host.stop();
    await host.stop();
    expect(calls.slice(-2)).toEqual(["stop:z", "stop:a"]);
  });

  it("rejects unknown enabled types before creating any instance", async () => {
    const { host } = setup();
    const invalid = new PluginHost({
      registry: new PluginRegistry(),
      context: { configuration_revision: "1", service: { get() { throw new Error("not configured"); } } },
      configuration: { x: { type: "missing", enabled: true, config: {} } },
    });
    await expect(invalid.prepare()).rejects.toThrowError(/unknown_plugin_type/);
    await host.stop();
  });
});
