import { describe, expect, it, vi } from "vitest";

import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import { CatalogCapabilityResolver } from "../src/index.js";

const declaration = {
  declaration_id: "feishu.document.create",
  declaration_kind: "capability" as const,
  version: "1.2.0",
  name: "Create document",
  description: "Create one simple document.",
  interaction_modes: ["asynchronous" as const],
  risk: "medium" as const,
  confirmation: "none" as const,
  constraints: {},
  extensions: {},
};

function descriptor(citizenId: string, endpointId: string) {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider" as const,
    version: "1.0.0",
    identity: {
      principal_id: `principal-${citizenId}`,
      actor: {
        actor_id: `actor-${citizenId}`,
        actor_type: "system" as const,
      },
      endpoint_id: endpointId,
    },
    protocol: { versions: ["1"], bindings: ["workfabric+https"] },
    declarations: {
      count: 1,
      digest: canonicalCitizenDigest([declaration]),
    },
    availability: "available" as const,
    extensions: {},
  };
}

describe("CatalogCapabilityResolver", () => {
  it("reads full contracts separately and returns deterministic frozen candidates", async () => {
    const list = vi.fn(async () => ({
      items: [
        descriptor("provider-z", "endpoint-z"),
        descriptor("provider-a", "endpoint-a"),
      ],
    }));
    const getDeclaration = vi.fn(async (citizenId: string) => ({
      citizen_id: citizenId,
      citizen_kind: "capability-provider" as const,
      availability: "available" as const,
      declaration,
      declaration_version: 3,
      fencing_token: 7,
    }));
    const resolver = new CatalogCapabilityResolver({ list, getDeclaration });

    const candidates = await resolver.discover({
      capability_id: "feishu.document.create",
      version_constraint: "^1.0.0",
    });

    expect(list).toHaveBeenCalledWith({
      citizen_kind: "capability-provider",
      declaration_id: "feishu.document.create",
      availability: ["available", "degraded"],
      executable_only: true,
      limit: 100,
    }, {});
    expect(getDeclaration).toHaveBeenCalledTimes(2);
    expect(candidates.map((item) => item.citizen_id)).toEqual([
      "provider-a",
      "provider-z",
    ]);
    expect(candidates[0]).toEqual({
      citizen_id: "provider-a",
      endpoint_id: "endpoint-a",
      capability_id: declaration.declaration_id,
      capability_version: declaration.version,
      contract_digest: canonicalCitizenDigest(declaration),
    });
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
  });

  it("filters incompatible versions and Citizens without an Endpoint identity", async () => {
    const withoutEndpoint = {
      ...descriptor("provider-context-only", "unused"),
      identity: {
        principal_id: "principal-context-only",
      },
    };
    const resolver = new CatalogCapabilityResolver({
      async list() {
        return {
          items: [
            withoutEndpoint,
            descriptor("provider-old", "endpoint-old"),
          ],
        };
      },
      async getDeclaration(citizenId: string) {
        return {
          citizen_id: citizenId,
          citizen_kind: "capability-provider",
          availability: "available",
          declaration: { ...declaration, version: "2.0.0" },
          declaration_version: 1,
          fencing_token: 1,
        };
      },
    });

    await expect(resolver.discover({
      capability_id: "feishu.document.create",
      version_constraint: "^1.0.0",
    })).resolves.toEqual([]);
  });

  it("does not conceal a full-contract authorization or transport failure", async () => {
    const denied = new Error("full contract denied");
    const resolver = new CatalogCapabilityResolver({
      async list() {
        return { items: [descriptor("provider-a", "endpoint-a")] };
      },
      async getDeclaration() {
        throw denied;
      },
    });

    await expect(resolver.discover({
      capability_id: "feishu.document.create",
      version_constraint: "1.2.0",
    })).rejects.toBe(denied);
  });

  it("loads only the exact declaration digest frozen by discovery", async () => {
    const resolver = new CatalogCapabilityResolver({
      async list() {
        return { items: [] };
      },
      async getDeclaration(citizenId: string) {
        return {
          citizen_id: citizenId,
          citizen_kind: "capability-provider",
          availability: "available",
          declaration: {
            ...declaration,
            input_schema: {
              uri: "https://work-fabric.example/schemas/create-input.json",
              digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
            },
          },
          declaration_version: 4,
          fencing_token: 8,
        };
      },
    });
    const boundDeclaration = {
      ...declaration,
      input_schema: {
        uri: "https://work-fabric.example/schemas/create-input.json",
        digest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
      },
    };
    const bound = await resolver.getBoundContract({
      citizen_id: "provider-a",
      endpoint_id: "endpoint-a",
      capability_id: declaration.declaration_id,
      capability_version: declaration.version,
      contract_digest: canonicalCitizenDigest(boundDeclaration),
    });

    expect(bound).toEqual({
      candidate: {
        citizen_id: "provider-a",
        endpoint_id: "endpoint-a",
        capability_id: declaration.declaration_id,
        capability_version: declaration.version,
        contract_digest: canonicalCitizenDigest(boundDeclaration),
      },
      input_schema: boundDeclaration.input_schema,
      confirmation: "none",
      risk: "medium",
    });
    await expect(resolver.getBoundContract({
      citizen_id: "provider-a",
      endpoint_id: "endpoint-a",
      capability_id: declaration.declaration_id,
      capability_version: declaration.version,
      contract_digest:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    })).rejects.toThrow(/binding changed/i);
  });

  it.each(["latest", "^1", "1.2", ""])(
    "rejects unsupported version constraint %j",
    async (versionConstraint) => {
      const resolver = new CatalogCapabilityResolver({
        async list() {
          throw new Error("must not read Catalog");
        },
        async getDeclaration() {
          throw new Error("must not read contract");
        },
      });
      await expect(resolver.discover({
        capability_id: "feishu.document.create",
        version_constraint: versionConstraint,
      })).rejects.toThrow(/version_constraint/i);
    },
  );
});
