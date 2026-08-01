import { describe, expect, it } from "vitest";

import {
  assertNetworkCitizenKind,
  canonicalCitizenDigest,
  validateCitizenDeclaration,
  validateCitizenDeclarations,
  validateNetworkCitizenDescriptor,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function descriptor() {
  return {
    citizen_id: "feishu-document-actions",
    citizen_kind: "capability-provider",
    version: "1.0.0",
    identity: {
      principal_id: "principal-feishu-provider",
      actor: {
        actor_id: "actor-feishu-provider",
        actor_type: "system",
      },
      endpoint_id: "endpoint-feishu-provider",
    },
    protocol: {
      versions: ["1"],
      bindings: ["workfabric+https"],
    },
    declarations: {
      count: 1,
      digest,
    },
    availability: "available",
    extensions: {},
  };
}

function declaration() {
  return {
    declaration_id: "feishu.document.create",
    declaration_kind: "capability",
    version: "1.0.0",
    name: "Create a Feishu document",
    description: "Creates one bounded simple Feishu document.",
    input_schema: {
      uri: "urn:work-fabric:schema:capability:feishu.document.create:input:1",
      digest,
    },
    output_schema: {
      uri: "urn:work-fabric:schema:capability:feishu.document.create:output:1",
      digest: `sha256:${"b".repeat(64)}`,
    },
    interaction_modes: ["asynchronous"],
    risk: "medium",
    confirmation: "none",
    constraints: {
      max_content_bytes: 65_536,
    },
    extensions: {},
  };
}

describe("Network Citizen SPI contracts", () => {
  it("accepts only the six normative citizen kinds", () => {
    expect(assertNetworkCitizenKind("decision-body")).toBe("decision-body");
    expect(assertNetworkCitizenKind("capability-provider")).toBe(
      "capability-provider",
    );
    expect(assertNetworkCitizenKind("channel")).toBe("channel");
    expect(assertNetworkCitizenKind("context-provider")).toBe(
      "context-provider",
    );
    expect(assertNetworkCitizenKind("governance-provider")).toBe(
      "governance-provider",
    );
    expect(assertNetworkCitizenKind("observer")).toBe("observer");
    expect(() => assertNetworkCitizenKind("database")).toThrow(/citizen_kind/);
  });

  it("returns an immutable descriptor without accepting deployment bindings", () => {
    const value = validateNetworkCitizenDescriptor(descriptor());

    expect(value).toEqual(descriptor());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.protocol.bindings)).toBe(true);

    expect(() =>
      validateNetworkCitizenDescriptor({
        ...descriptor(),
        protocol: {
          versions: ["1"],
          bindings: ["https://private.internal/runtime"],
        },
      }),
    ).toThrow(/binding/);
  });

  it("rejects unknown descriptor fields and malformed identity combinations", () => {
    expect(() =>
      validateNetworkCitizenDescriptor({
        ...descriptor(),
        credential_ref: "secret",
      }),
    ).toThrow(/unknown field/);

    expect(() =>
      validateNetworkCitizenDescriptor({
        ...descriptor(),
        identity: {
          principal_id: "principal-feishu-provider",
          endpoint_id: "endpoint-without-actor",
        },
      }),
    ).toThrow(/endpoint_id/);
  });

  it("validates an exact declaration and immutable schema digests", () => {
    const value = validateCitizenDeclaration(declaration());

    expect(value).toEqual(declaration());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.constraints)).toBe(true);

    expect(() =>
      validateCitizenDeclaration({
        ...declaration(),
        input_schema: {
          uri: "urn:work-fabric:schema:input",
          digest: "sha256:not-a-digest",
        },
      }),
    ).toThrow(/digest/);
  });

  it("rejects duplicate declarations and unsafe JSON values", () => {
    expect(() =>
      validateCitizenDeclarations([declaration(), declaration()]),
    ).toThrow(/unique/);

    const constraints = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(constraints, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() =>
      validateCitizenDeclaration({
        ...declaration(),
        constraints,
      }),
    ).toThrow(/accessor/);
  });

  it("computes a stable digest independent of object insertion order", () => {
    expect(
      canonicalCitizenDigest({
        b: 2,
        a: {
          z: true,
          y: "value",
        },
      }),
    ).toBe(
      canonicalCitizenDigest({
        a: {
          y: "value",
          z: true,
        },
        b: 2,
      }),
    );
    expect(canonicalCitizenDigest({ value: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
