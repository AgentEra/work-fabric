import { describe, expect, it } from "vitest";
import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import {
  ConfiguredDebugParticipantResolver,
  validateDebugPluginConfig,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

function resolver(admission: CollaborationAdmissionService) {
  return new ConfiguredDebugParticipantResolver({
    tenant_id: "tenant-local",
    connector_id: "debug-local",
    external_tenant_id: "debug-fixtures",
    participants: validateDebugPluginConfig(validDebugConfig()).participants,
    admission,
  });
}

const input = {
  participant_ref: "internal-user",
  ingress_id: "ingress-1",
  idempotency_key: "message-1",
};

describe("ConfiguredDebugParticipantResolver", () => {
  it("resolves a static fixture only to its configured identity", async () => {
    const result = await resolver({
      async admit() {
        throw new Error("static mode must not call Admission");
      },
    }).resolve(input);
    expect(result).toEqual({
      kind: "resolved",
      identity: {
        actor_id: "actor-debug-user",
        actor_type: "human",
        endpoint_id: "endpoint-debug-user",
      },
    });
  });

  it("returns a scoped Admission binding and representation grant", async () => {
    const result = await resolver({
      async admit() {
        return {
          decision: {
            kind: "allow",
            reason_code: "internal_member",
            policy_id: "debug-local-admission",
            policy_revision: "revision-1",
            binding: {
              tenant_id: "tenant-local",
              connector_id: "debug-local",
              source_system: "workfabric-debug",
              external_tenant_id: "debug-fixtures",
              external_subject_type: "human",
              external_subject_fingerprint: "fingerprint-1",
              actor_id: "actor-admitted",
              actor_type: "human",
              endpoint_id: "endpoint-admitted",
              created_at: "2026-07-29T09:00:00.000Z",
            },
            decision_id: "decision-1",
          },
          representation_grant: "grant-1",
        };
      },
    }).resolve({ ...input, participant_ref: "admitted-user" });
    expect(result).toEqual({
      kind: "resolved",
      identity: {
        actor_id: "actor-admitted",
        actor_type: "human",
        endpoint_id: "endpoint-admitted",
      },
      representation_grant: "grant-1",
    });
  });

  it("preserves Admission denial without inventing an identity", async () => {
    const result = await resolver({
      async admit() {
        return {
          decision: {
            kind: "deny",
            reason_code: "default_deny",
            policy_id: "debug-local-admission",
            policy_revision: "revision-1",
            decision_id: "decision-1",
          },
        };
      },
    }).resolve({ ...input, participant_ref: "admitted-user" });
    expect(result).toEqual({ kind: "denied", reason_code: "default_deny" });
  });

  it("fails closed on a cross-scope Admission binding", async () => {
    const result = await resolver({
      async admit() {
        return {
          decision: {
            kind: "allow",
            reason_code: "explicit_allow",
            policy_id: "debug-local-admission",
            policy_revision: "revision-1",
            binding: {
              tenant_id: "tenant-other",
              connector_id: "debug-local",
              source_system: "workfabric-debug",
              external_tenant_id: "debug-fixtures",
              external_subject_type: "human",
              external_subject_fingerprint: "fingerprint-1",
              actor_id: "actor-admitted",
              actor_type: "human",
              endpoint_id: "endpoint-admitted",
              created_at: "2026-07-29T09:00:00.000Z",
            },
            decision_id: "decision-1",
          },
          representation_grant: "grant-1",
        };
      },
    }).resolve({ ...input, participant_ref: "admitted-user" });
    expect(result).toEqual({ kind: "denied", reason_code: "scope_mismatch" });
  });

  it("rejects unknown fixture references before Admission", async () => {
    expect(await resolver({
      async admit() {
        throw new Error("unknown fixture must not call Admission");
      },
    }).resolve({ ...input, participant_ref: "missing" })).toEqual({
      kind: "denied",
      reason_code: "participant_unknown",
    });
  });
});
