import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  ConfigurationService,
  type ConfigurationSectionValidator,
} from "../src/index.js";

function validator(type: string): ConfigurationSectionValidator {
  return {
    type,
    validate(value) {
      if (typeof value !== "object" || value === null) {
        throw new ConfigurationError("invalid_plugin_config", `plugins.instances.${type}.config`);
      }
      return structuredClone(value);
    },
  };
}

describe("ConfigurationService", () => {
  it("loads once and publishes a deeply immutable source-neutral snapshot", async () => {
    let loads = 0;
    const service = new ConfigurationService({
      provider: {
        async load() {
          loads += 1;
          return {
            revision: "db:42",
            value: {
              api_version: "workfabric.config/v1",
              service: { tenant_id: "tenant-1" },
              plugins: { instances: {} },
            },
          };
        },
      },
      clock: { now: () => "2026-07-17T01:02:03.000Z" },
      validate_service: (value) => structuredClone(value),
      plugin_validators: [],
    });

    const first = await service.load();
    const second = await service.load();
    expect(first).toBe(second);
    expect(loads).toBe(1);
    expect(first.revision).toBe("db:42");
    expect(first.loaded_at).toBe("2026-07-17T01:02:03.000Z");
    expect(() => {
      (first.value.service as { tenant_id: string }).tenant_id = "changed";
    }).toThrow();
  });

  it("validates enabled plugins and leaves disabled unknown types inert", async () => {
    const service = new ConfigurationService({
      provider: { async load() { return {
        revision: "file:1",
        value: {
          api_version: "workfabric.config/v1",
          service: {},
          plugins: { instances: {
            enabled: { type: "known", enabled: true, config: { ok: true } },
            staged: { type: "not-installed", enabled: false, config: "ignored" },
          } },
        },
      }; } },
      clock: { now: () => "2026-07-17T01:02:03.000Z" },
      validate_service: (value) => value,
      plugin_validators: [validator("known")],
    });

    const snapshot = await service.load();
    expect(snapshot.value.plugins.instances.staged!.enabled).toBe(false);
    expect(snapshot.value.plugins.instances.enabled!.config).toEqual({ ok: true });
  });

  it("rejects an unknown enabled plugin without activating a snapshot", async () => {
    const service = new ConfigurationService({
      provider: { async load() { return {
        revision: "file:2",
        value: {
          api_version: "workfabric.config/v1",
          service: {},
          plugins: { instances: { bad: { type: "missing", enabled: true, config: {} } } },
        },
      }; } },
      clock: { now: () => "2026-07-17T01:02:03.000Z" },
      validate_service: (value) => value,
      plugin_validators: [],
    });

    await expect(service.load()).rejects.toMatchObject({
      code: "unknown_plugin_type",
      path: "plugins.instances.bad.type",
    });
    expect(service.current()).toBeNull();
  });

  it("rejects unsupported root versions", async () => {
    const service = new ConfigurationService({
      provider: { async load() { return { revision: "1", value: {
        api_version: "workfabric.config/v2", service: {}, plugins: { instances: {} },
      } }; } },
      clock: { now: () => "2026-07-17T01:02:03.000Z" },
      validate_service: (value) => value,
      plugin_validators: [],
    });

    await expect(service.load()).rejects.toMatchObject({ code: "unsupported_api_version" });
  });

  it("rejects unknown configuration envelope and plugin wrapper keys", async () => {
    const create = (value: unknown) => new ConfigurationService({
      provider: { async load() { return { revision: "strict:1", value }; } },
      clock: { now: () => "2026-07-17T01:02:03.000Z" },
      validate_service: (candidate) => candidate,
      plugin_validators: [validator("known")],
    });
    await expect(create({ api_version: "workfabric.config/v1", service: {}, plugins: { instances: {} }, typo: true }).load()).rejects.toMatchObject({ code: "unknown_key", path: "$.typo" });
    await expect(create({ api_version: "workfabric.config/v1", service: {}, plugins: { instances: { one: { type: "known", enabled: true, config: {}, typo: true } } } }).load()).rejects.toMatchObject({ code: "unknown_key", path: "plugins.instances.one.typo" });
  });
});
