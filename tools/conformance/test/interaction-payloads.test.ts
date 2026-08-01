import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  loadSchemaRegistry,
  type SchemaRegistryError,
  type SchemaRegistryValidator,
} from "../src/schema-registry.js";

interface NamedFixture {
  readonly name: string;
  readonly instance: unknown;
}

interface InteractionPayloadRegistry {
  readonly spec_version: string;
  readonly mappings: Readonly<Record<string, string>>;
}

interface HandoffLifecycle {
  readonly transitions: readonly {
    readonly interaction: string;
  }[];
}

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

const validOffer = fixture("valid handoff offer");
const validStatusUpdate = fixture("valid status update");
const validResultSubmission = fixture("valid result submission");

const validPayloads: Readonly<Record<string, unknown>> = {
  "workfabric.handoff.offer.v1": validOffer,
  "workfabric.handoff.resolve_target.v1": {
    handoff_id: "handoff_01",
    resolved_target: { endpoint_id: "endpoint_agent" },
    evidence: [],
  },
  "workfabric.handoff.report_target_unavailable.v1": {
    handoff_id: "handoff_01",
    reason_code: "no_eligible_target",
    reason: [
      {
        kind: "text",
        media_type: "text/plain",
        text: "No eligible endpoint is currently available",
      },
    ],
    evidence: [],
  },
  "workfabric.handoff.claim.v1": {
    handoff_id: "handoff_01",
    claim_id: "claim_01",
  },
  "workfabric.handoff.renew_claim.v1": {
    handoff_id: "handoff_01",
    claim_id: "claim_01",
    fencing_token: 1,
    heartbeat_sequence: 1,
  },
  "workfabric.handoff.release_claim.v1": {
    handoff_id: "handoff_01",
    claim_id: "claim_01",
    fencing_token: 1,
    heartbeat_sequence: 1,
  },
  "workfabric.handoff.expire_claim.v1": {
    handoff_id: "handoff_01",
    claim_id: "claim_01",
    fencing_token: 1,
  },
  "workfabric.handoff.accept.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.decline.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.expire.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.cancel.v1": {
    handoff_id: "handoff_01",
    reason: [{ kind: "text", media_type: "text/plain", text: "Cancelled" }],
  },
  "workfabric.handoff.report_status.v1": {
    handoff_id: "handoff_01",
    status: validStatusUpdate,
  },
  "workfabric.handoff.return_result.v1": {
    handoff_id: "handoff_01",
    result: validResultSubmission,
  },
  "workfabric.handoff.verify.v1": {
    handoff_id: "handoff_01",
    satisfied_criterion_ids: ["tests-pass"],
    summary: [{ kind: "text", media_type: "text/plain", text: "Verified" }],
    evidence: [],
  },
  "workfabric.handoff.close.v1": { handoff_id: "handoff_01" },
  "workfabric.handoff.request_rework.v1": {
    handoff_id: "handoff_01",
    criterion_ids: ["tests-pass"],
    reason: [{ kind: "text", media_type: "text/plain", text: "Fix tests" }],
  },
  "workfabric.handoff.transfer.v1": {
    parent_handoff_id: "handoff_01",
    child_offer: validOffer,
  },
};

const lifecycle = JSON.parse(
  await readFile("protocol/spec/handoff-lifecycle.json", "utf8"),
) as HandoffLifecycle;
const publicMessageTypes = [
  ...new Set(
    lifecycle.transitions
      .filter(({ interaction }) => interaction !== "handoff.child_accepted")
      .map(({ interaction }) => `workfabric.${interaction}.v1`),
  ),
].sort();

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;
let payloadRegistry: InteractionPayloadRegistry;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
  payloadRegistry = JSON.parse(
    await readFile("protocol/spec/interaction-payloads.json", "utf8"),
  ) as InteractionPayloadRegistry;
});

function validatorFor(messageType: string): SchemaRegistryValidator {
  const schemaId = payloadRegistry.mappings[messageType];
  if (schemaId === undefined) {
    throw new Error(`Unmapped message type: ${messageType}`);
  }
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  return validator;
}

function errors(
  messageType: string,
  value: unknown,
): readonly SchemaRegistryError[] | null {
  const validator = validatorFor(messageType);
  validator(value);
  return validator.errors ?? null;
}

describe("Handoff interaction payload registry", () => {
  it("maps every public Handoff interaction to a registered payload schema", () => {
    expect(payloadRegistry.spec_version).toBe("1.0");
    expect(Object.keys(payloadRegistry.mappings).sort()).toEqual(
      publicMessageTypes,
    );
    expect(Object.keys(validPayloads).sort()).toEqual(publicMessageTypes);

    for (const messageType of publicMessageTypes) {
      expect(() => validatorFor(messageType)).not.toThrow();
    }
  });

  it.each(Object.entries(validPayloads))(
    "validates the minimal payload for %s",
    (messageType, payload) => {
      expect(errors(messageType, payload)).toBeNull();
    },
  );

  it("keeps the internal child-accepted transition out of the public registry", () => {
    expect(payloadRegistry.mappings["workfabric.handoff.child_accepted.v1"]).toBe(
      undefined,
    );
  });

  it("rejects an unmapped message type", () => {
    expect(() => validatorFor("workfabric.handoff.unknown.v1")).toThrow(
      "Unmapped message type: workfabric.handoff.unknown.v1",
    );
  });
});
