import { describe, expect, it } from "vitest";

import type { ConfigurationProvider } from "@work-fabric/configuration-spi";

import { ConfigurationViewProvider } from "../src/index.js";

function provider(value: unknown, revision = "sha256:bundle"): ConfigurationProvider {
  return {
    async load() {
      return { revision, value };
    },
  };
}

const application = {
  api_version: "workfabric.config/v1",
  service: { runtime_id: "daily-assistant" },
  plugins: { instances: {} },
};

describe("ConfigurationViewProvider", () => {
  it("selects and clones one application without exposing sibling secrets", async () => {
    const source = {
      api_version: "workfabric.config-bundle/v1",
      applications: {
        "daily-assistant": application,
        "feishu-provider": {
          api_version: "workfabric.config/v1",
          service: { secret: "must-not-be-materialized" },
          plugins: { instances: {} },
        },
      },
    };
    const selected = await new ConfigurationViewProvider({
      provider: provider(source),
      application_id: "daily-assistant",
    }).load();

    expect(selected).toEqual({
      revision: "sha256:bundle#daily-assistant",
      value: application,
    });
    expect(selected.value).not.toBe(application);
    expect(JSON.stringify(selected)).not.toContain("must-not-be-materialized");
  });

  it("keeps a standalone v1 document backward compatible", async () => {
    const selected = await new ConfigurationViewProvider({
      provider: provider(application, "standalone"),
      application_id: "daily-assistant",
    }).load();

    expect(selected).toEqual({ revision: "standalone", value: application });
  });

  it.each([
    {
      label: "missing application",
      value: {
        api_version: "workfabric.config-bundle/v1",
        applications: { "work-fabric": application },
      },
      application_id: "daily-assistant",
    },
    {
      label: "unknown root field",
      value: {
        api_version: "workfabric.config-bundle/v1",
        applications: { "daily-assistant": application },
        secret: "x",
      },
      application_id: "daily-assistant",
    },
    {
      label: "invalid application identifier",
      value: {
        api_version: "workfabric.config-bundle/v1",
        applications: { "daily-assistant": application },
      },
      application_id: "../daily-assistant",
    },
    {
      label: "malformed selected application",
      value: {
        api_version: "workfabric.config-bundle/v1",
        applications: { "daily-assistant": [] },
      },
      application_id: "daily-assistant",
    },
  ])("fails closed for $label", async ({ value, application_id }) => {
    await expect(Promise.resolve().then(() =>
      new ConfigurationViewProvider({
        provider: provider(value),
        application_id,
      }).load()
    )).rejects.toThrow();
  });
});
