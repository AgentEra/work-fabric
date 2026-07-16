import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/index.js";

const identity = {
  authentication_evidence: { bearer_token: "configured-test-token" },
  principal: {
    principal_id: "principal-local",
    tenant_id: "tenant-local",
    actor_claims: [{
      actor_id: "actor-local",
      actor_type: "human" as const,
      endpoint_ids: ["endpoint-local"],
    }],
    attributes: {},
  },
};

const rule = {
  tenant_id: "tenant-local",
  principal_id: "principal-local",
  actor_id: "actor-local",
  actor_type: "human" as const,
  endpoint_id: "endpoint-local",
  action: "workfabric.operations.health.read.v1",
  resource_id: null,
};

describe("Node service configuration", () => {
  it("requires explicit development mode, identity and default-deny rules", () => {
    expect(() => parseServiceConfig({
      storage_profile: "memory-demo",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [],
      authority_rules: [],
    })).toThrow(/development|identity|authority/i);
  });

  it("normalizes a bounded memory profile without adding credentials", () => {
    const config = parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
    });
    expect(config).toMatchObject({
      storage_profile: "memory-demo",
      role: "all",
      listen: { host: "127.0.0.1", port: 8787 },
    });
    expect(JSON.stringify(config)).not.toContain("default-token");
  });

  it("requires a SQLite location and refuses unsupported production defaults", () => {
    expect(() => parseServiceConfig({
      storage_profile: "sqlite-local",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
    })).toThrow(/sqlite/i);
    expect(() => parseServiceConfig({
      storage_profile: "postgres",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
    })).toThrow(/connection/i);
  });
});
