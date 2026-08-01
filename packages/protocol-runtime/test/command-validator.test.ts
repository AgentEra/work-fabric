import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "../src/index.js";

interface NamedFixture {
  readonly name: string;
  readonly instance: unknown;
}

interface InteractionPayloadRegistry {
  readonly spec_version: string;
  readonly mappings: Readonly<Record<string, string>>;
}

const schemaRoot = "protocol/schemas/v1";
const interactionRegistryPath = "protocol/spec/interaction-payloads.json";

const fixtures = JSON.parse(
  await readFile(
    "protocol/conformance/fixtures/positive/core-schemas.json",
    "utf8",
  ),
) as readonly NamedFixture[];

function fixture(name: string): unknown {
  const found = fixtures.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(found.instance);
}

function envelope(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    spec_version: "1.0",
    message_id: "message_01",
    message_type: "workfabric.handoff.offer.v1",
    sent_at: "2026-07-14T01:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    idempotency_key: "offer-01",
    payload: fixture("valid handoff offer"),
    ...overrides,
  };
}

function expectInvalid(result: ReturnType<WfppCommandValidator["validate"]>) {
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("Expected validation to fail");
  return result.errors;
}

describe("shared WFPP command validation", () => {
  let schemas: WfppSchemaValidator;
  let commands: WfppCommandValidator;

  beforeAll(async () => {
    schemas = await loadWfppSchemaValidator(schemaRoot);
    commands = await loadWfppCommandValidator(
      schemas,
      interactionRegistryPath,
    );
  });

  it("accepts a valid Envelope and its matching mapped Payload", () => {
    expect(commands.validate(envelope())).toEqual({ valid: true });
    expect(commands.payloadSchemaId("workfabric.handoff.offer.v1")).toBe(
      "urn:work-fabric:schema:v1:handoff-offer",
    );
  });

  it.each([
    [
      "workfabric.handoff.claim.v1",
      {
        handoff_id: "handoff_01",
        claim_id: "claim_client_01",
        requested_lease_seconds: 60,
      },
    ],
    [
      "workfabric.handoff.renew_claim.v1",
      {
        handoff_id: "handoff_01",
        claim_id: "claim_client_01",
        fencing_token: 1,
        heartbeat_sequence: 1,
      },
    ],
    [
      "workfabric.handoff.release_claim.v1",
      {
        handoff_id: "handoff_01",
        claim_id: "claim_client_01",
        fencing_token: 1,
        heartbeat_sequence: 2,
      },
    ],
    [
      "workfabric.handoff.expire_claim.v1",
      {
        handoff_id: "handoff_01",
        claim_id: "claim_client_01",
        fencing_token: 1,
      },
    ],
    [
      "workfabric.handoff.accept.v1",
      {
        handoff_id: "handoff_01",
        claim_id: "claim_client_01",
        fencing_token: 1,
      },
    ],
  ] as const)("accepts the Claim interaction %s", (messageType, payload) => {
    expect(commands.validate(envelope({
      message_type: messageType,
      expected_version: 1,
      payload,
    }))).toEqual({ valid: true });
  });

  it("rejects an invalid Envelope before looking up its Payload mapping", () => {
    const errors = expectInvalid(
      commands.validate({
        message_type: "workfabric.handoff.child_accepted.v1",
        payload: null,
      }),
    );

    expect(errors.some(({ description }) => /unsupported/i.test(description))).toBe(
      false,
    );
    expect(errors.some(({ description }) => /required/i.test(description))).toBe(
      true,
    );
  });

  it("classifies an unknown client message type as unsupported", () => {
    const errors = expectInvalid(
      commands.validate(
        envelope({ message_type: "workfabric.handoff.unknown.v1" }),
      ),
    );

    expect(errors).toEqual([
      {
        field: "/message_type",
        description:
          "unsupported_version: unsupported message_type workfabric.handoff.unknown.v1",
      },
    ]);
    expect(commands.payloadSchemaId("workfabric.handoff.unknown.v1")).toBeNull();
  });

  it("reports normalized mapped Payload field violations", () => {
    const errors = expectInvalid(
      commands.validate(
        envelope({
          payload: {
            target: { actor_id: "actor_01" },
          },
        }),
      ),
    );

    expect(errors).toContainEqual({
      field: "/payload",
      description: "must have required property 'work_reference'",
    });
  });

  it("keeps the internal child-accepted interaction out of client mappings", () => {
    expect(
      commands.payloadSchemaId("workfabric.handoff.child_accepted.v1"),
    ).toBeNull();
    const errors = expectInvalid(
      commands.validate(
        envelope({ message_type: "workfabric.handoff.child_accepted.v1" }),
      ),
    );
    expect(errors[0]?.field).toBe("/message_type");
  });

  it("resolves every interaction mapping to a registered Schema", async () => {
    const mapping = JSON.parse(
      await readFile(interactionRegistryPath, "utf8"),
    ) as InteractionPayloadRegistry;

    expect(mapping.spec_version).toBe("1.0");
    for (const [messageType, schemaId] of Object.entries(mapping.mappings)) {
      expect(commands.payloadSchemaId(messageType)).toBe(schemaId);
      const result = schemas.validate(schemaId, null);
      if (!result.valid) {
        expect(result.errors).not.toContainEqual({
          field: "$schema",
          description: `Unknown schema: ${schemaId}`,
        });
      }
    }
  });
});
