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

  it("rejects clustered SQLite and unbounded worker settings", () => {
    const cluster = {
      worker_owner_id: "worker-a",
      tenant_ids: ["tenant-local"],
      max_concurrent_turns: 4,
      max_ready_items: 100,
      catalog_page_size: 25,
      turn_item_limit: 100,
      lease_seconds: 30,
      drain_timeout_seconds: 30,
      poll_interval_ms: 1_000,
      max_tenants_per_host: 10,
    };
    expect(() => parseServiceConfig({
      storage_profile: "sqlite-local",
      role: "worker",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
      sqlite: { location: ":memory:", busy_timeout_ms: 5_000 },
      cluster,
    })).toThrow(/single-process/i);
    expect(() => parseServiceConfig({
      storage_profile: "postgres",
      role: "worker",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
      postgres: { connection_string: "postgres://deployment-owned" },
      cluster: { ...cluster, max_concurrent_turns: 0 },
    })).toThrow(/max_concurrent_turns/);
  });
});
