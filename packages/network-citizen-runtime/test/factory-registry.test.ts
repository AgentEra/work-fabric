import { describe, expect, it } from "vitest";

import type {
  NetworkCitizenFactory,
  NetworkCitizenRuntime,
} from "@work-fabric/network-citizen-spi";

import { NetworkCitizenFactoryRegistry } from "../src/index.js";

function factory(
  type: string,
  citizenKind: NetworkCitizenFactory["citizen_kind"],
): NetworkCitizenFactory {
  return {
    type,
    citizen_kind: citizenKind,
    validate(value) {
      return value;
    },
    async create() {
      return {} as NetworkCitizenRuntime;
    },
  };
}

describe("NetworkCitizenFactoryRegistry", () => {
  it("resolves a registered factory only for its declared Citizen kind", () => {
    const registry = new NetworkCitizenFactoryRegistry();
    const value = factory(
      "capability-provider.feishu",
      "capability-provider",
    );
    registry.register(value);

    expect(
      registry.resolve("capability-provider.feishu", "capability-provider"),
    ).toBe(value);
    expect(() =>
      registry.resolve("capability-provider.feishu", "channel"),
    ).toThrow(/kind/);
  });

  it("rejects duplicate and missing stable factory types", () => {
    const registry = new NetworkCitizenFactoryRegistry();
    registry.register(
      factory("capability-provider.feishu", "capability-provider"),
    );

    expect(() =>
      registry.register(
        factory("capability-provider.feishu", "capability-provider"),
      ),
    ).toThrow(/already registered/);
    expect(() =>
      registry.resolve("capability-provider.missing", "capability-provider"),
    ).toThrow(/not registered/);
  });
});
