import { describe, expect, it } from "vitest";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

describe("source-neutral Collaboration Admission E2E", () => {
  it("admits and stably binds an exact-allowed synthetic system participant", async () => {
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      role: "api",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "c".repeat(32),
      admission: {
        subject_fingerprint_key: "f".repeat(32),
        grant_active_key_id: "primary",
        grant_keys: { primary: "g".repeat(32) },
        grant_ttl_seconds: 60,
        max_evidence_cache_entries: 100,
      },
      identities: [{
        authentication_evidence: { bearer_token: "unused-local-token" },
        principal: {
          principal_id: "unused-local-principal",
          tenant_id: "tenant-local",
          actor_claims: [{
            actor_id: "unused-local-actor",
            actor_type: "human",
            endpoint_ids: ["unused-local-endpoint"],
          }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local",
        principal_id: "unused-local-principal",
        actor_id: "unused-local-actor",
        actor_type: "human",
        endpoint_id: "unused-local-endpoint",
        action: "workfabric.operations.health.read.v1",
        resource_id: null,
      }],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      admission: {
        evidence_providers: {},
        policies: {
          "synthetic-systems": {
            policy_id: "synthetic-systems",
            revision: "1",
            tenant_id: "tenant-local",
            connector_id: "synthetic-primary",
            source_system: "synthetic",
            external_tenant_id: "synthetic-tenant",
            default: "deny",
            allow: {
              all_internal_members: false,
              external_subject_ids: ["system-one"],
            },
            deny: { external_subject_ids: [] },
            binding: { actor_type: "system", store_ref: "participant-bindings" },
          },
        },
      },
    });
    const request = {
      tenant_id: "tenant-local",
      connector_id: "synthetic-primary",
      source_system: "synthetic",
      external_tenant_id: "synthetic-tenant",
      external_subject_type: "system" as const,
      external_subject_id: "system-one",
      ingress_id: "synthetic-ingress-one",
    };
    try {
      const first = await service.admission!.admit("synthetic-systems", request);
      const duplicate = await service.admission!.admit("synthetic-systems", request);
      expect(first.decision).toMatchObject({
        kind: "allow",
        reason_code: "explicit_allow",
        binding: {
          source_system: "synthetic",
          external_subject_type: "system",
          actor_type: "system",
        },
      });
      expect(duplicate.decision).toEqual(first.decision);
      expect(first.representation_grant?.split(".")).toHaveLength(2);
    } finally {
      await service.close();
    }
  });
});
