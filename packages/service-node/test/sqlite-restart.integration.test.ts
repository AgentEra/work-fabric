import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

describe("SQLite Node service composition", () => {
  it("keeps Admission decisions and participant bindings stable across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-admission-service-"));
    const config = parseServiceConfig({
      storage_profile: "sqlite-local",
      role: "api",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      sqlite: { location: join(directory, "work-fabric.db") },
      admission: {
        subject_fingerprint_key: "f".repeat(32),
        grant_active_key_id: "primary",
        grant_keys: { primary: "g".repeat(32) },
        grant_ttl_seconds: 120,
        max_evidence_cache_entries: 10_000,
      },
      identities: [{
        authentication_evidence: { bearer_token: "health-token" },
        principal: {
          principal_id: "principal-local", tenant_id: "tenant-local",
          actor_claims: [{ actor_id: "actor-local", actor_type: "human", endpoint_ids: ["endpoint-local"] }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local", principal_id: "principal-local",
        actor_id: "actor-local", actor_type: "human", endpoint_id: "endpoint-local",
        action: "workfabric.operations.health.read.v1", resource_id: null,
      }],
    });
    const admission = {
      evidence_providers: {},
      policies: {
        "synthetic-participants": {
          policy_id: "synthetic-participants",
          revision: "1",
          tenant_id: "tenant-local",
          connector_id: "synthetic-primary",
          source_system: "synthetic",
          external_tenant_id: "external-local",
          default: "deny" as const,
          allow: { all_internal_members: false, external_subject_ids: ["subject-1"] },
          deny: { external_subject_ids: [] },
          binding: { actor_type: "human" as const, store_ref: "participant-bindings" },
        },
      },
    };
    const request = {
      tenant_id: "tenant-local",
      connector_id: "synthetic-primary",
      source_system: "synthetic",
      external_tenant_id: "external-local",
      external_subject_type: "human" as const,
      external_subject_id: "subject-1",
      ingress_id: "ingress-sqlite-restart",
    };
    try {
      const first = await composeNodeService(config, { admission });
      const firstResult = await first.admission!.admit("synthetic-participants", request);
      await first.close();
      const second = await composeNodeService(config, { admission });
      const secondResult = await second.admission!.admit("synthetic-participants", request);
      expect(secondResult.decision).toEqual(firstResult.decision);
      expect(secondResult.representation_grant).toBeDefined();
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes and reopens the same local profile cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-service-"));
    const config = parseServiceConfig({
      storage_profile: "sqlite-local",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      sqlite: { location: join(directory, "work-fabric.db") },
      identities: [{
        authentication_evidence: { bearer_token: "health-token" },
        principal: {
          principal_id: "principal-local", tenant_id: "tenant-local",
          actor_claims: [{ actor_id: "actor-local", actor_type: "human", endpoint_ids: ["endpoint-local"] }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local", principal_id: "principal-local",
        actor_id: "actor-local", actor_type: "human", endpoint_id: "endpoint-local",
        action: "workfabric.operations.health.read.v1", resource_id: null,
      }],
    });
    try {
      const first = await composeNodeService(config);
      await first.close();
      const second = await composeNodeService(config);
      await expect(second.http.dispatch({ method: "GET", url: "/health/ready" }))
        .resolves.toMatchObject({ status_code: 200 });
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
