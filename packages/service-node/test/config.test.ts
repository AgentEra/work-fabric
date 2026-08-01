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
  const base = {
    storage_profile: "memory-demo",
    development_mode: true,
    tenant_id: "tenant-local",
    exchange_id: "exchange-local",
    cursor_secret: "x".repeat(32),
    identities: [identity],
    authority_rules: [rule],
  } as const;

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

  it("validates bounded Admission secrets and runtime limits", () => {
    const config = parseServiceConfig({
      ...base,
      admission: {
        subject_fingerprint_key: "指".repeat(11),
        grant_active_key_id: "primary",
        grant_keys: { primary: "授".repeat(11), previous: "p".repeat(32) },
        grant_ttl_seconds: 120,
        max_evidence_cache_entries: 10_000,
      },
    });
    expect(config.admission).toMatchObject({
      grant_active_key_id: "primary",
      grant_ttl_seconds: 120,
      max_evidence_cache_entries: 10_000,
    });
    expect(new TextEncoder().encode(config.admission!.subject_fingerprint_key)).toHaveLength(33);

    for (const admission of [
      { subject_fingerprint_key: "x".repeat(31), grant_active_key_id: "primary", grant_keys: { primary: "y".repeat(32) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 10_000 },
      { subject_fingerprint_key: "x".repeat(32), grant_active_key_id: "missing", grant_keys: { primary: "y".repeat(32) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 10_000 },
      { subject_fingerprint_key: "x".repeat(32), grant_active_key_id: "primary", grant_keys: { primary: "y".repeat(31) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 10_000 },
      { subject_fingerprint_key: "x".repeat(32), grant_active_key_id: "primary", grant_keys: { primary: "y".repeat(32) }, grant_ttl_seconds: 301, max_evidence_cache_entries: 10_000 },
      { subject_fingerprint_key: "x".repeat(32), grant_active_key_id: "primary", grant_keys: { primary: "y".repeat(32) }, grant_ttl_seconds: 120, max_evidence_cache_entries: 100_001 },
    ]) {
      expect(() => parseServiceConfig({ ...base, admission })).toThrow(/service\.admission/);
    }
  });

  it("fails closed on inherited, accessor and prototype Admission key maps", () => {
    let invoked = false;
    const accessor = Object.defineProperty({
      grant_active_key_id: "primary",
      grant_keys: { primary: "y".repeat(32) },
      grant_ttl_seconds: 120,
      max_evidence_cache_entries: 10_000,
    }, "subject_fingerprint_key", {
      enumerable: true,
      get() { invoked = true; return "x".repeat(32); },
    });
    expect(() => parseServiceConfig({ ...base, admission: accessor })).toThrow(/service\.admission\.subject_fingerprint_key/);
    expect(invoked).toBe(false);

    const inherited = Object.create({ primary: "y".repeat(32) }) as Record<string, unknown>;
    expect(() => parseServiceConfig({
      ...base,
      admission: {
        subject_fingerprint_key: "x".repeat(32),
        grant_active_key_id: "primary",
        grant_keys: inherited,
        grant_ttl_seconds: 120,
        max_evidence_cache_entries: 10_000,
      },
    })).toThrow(/service\.admission\.grant_keys/);

    for (const keyId of ["bad.key", ".", "__proto__", "prototype", "constructor"]) {
      const grantKeys = Object.create(null) as Record<string, string>;
      Object.defineProperty(grantKeys, keyId, {
        enumerable: true,
        configurable: true,
        value: "y".repeat(32),
      });
      expect(() => parseServiceConfig({
        ...base,
        admission: {
          subject_fingerprint_key: "x".repeat(32),
          grant_active_key_id: keyId,
          grant_keys: grantKeys,
          grant_ttl_seconds: 120,
          max_evidence_cache_entries: 10_000,
        },
      })).toThrow(/service\.admission\.(grant_keys|grant_active_key_id)/);
    }
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

  it("accepts only a closed bounded discovery configuration without credentials", () => {
    const discovery = {
      enabled: true,
      tenant_view_id: "default-view",
      record_ttl_seconds: 60,
      default_page_limit: 20,
      max_page_limit: 100,
      max_records_per_origin: 10_000,
      sync_page_size: 100,
      query_max_hops: 2,
      query_max_fanout: 4,
      query_max_bytes: 32_768,
    };
    const config = parseServiceConfig({ ...base, discovery });
    expect(config.discovery).toEqual(discovery);
    expect(Object.isFrozen(config.discovery)).toBe(true);
    expect(JSON.stringify(config.discovery)).not.toMatch(/private|secret|credential|token/i);

    for (const invalid of [
      { ...discovery, unknown: true },
      { ...discovery, tenant_view_id: "" },
      { ...discovery, record_ttl_seconds: 301 },
      { ...discovery, default_page_limit: 101, max_page_limit: 100 },
      { ...discovery, query_max_hops: 9 },
      { ...discovery, query_max_fanout: 33 },
      { ...discovery, query_max_bytes: 65_537 },
      { ...discovery, private_key: "must-not-be-configurable" },
    ]) expect(() => parseServiceConfig({ ...base, discovery: invalid })).toThrow(/discovery/i);
  });

  it("rejects enabled discovery on a worker-only role", () => {
    expect(() => parseServiceConfig({
      ...base,
      storage_profile: "postgres",
      development_mode: false,
      role: "worker",
      postgres: { connection_string: "postgres://deployment-owned" },
      cluster: {
        worker_owner_id: "worker-a", tenant_ids: ["tenant-local"], max_concurrent_turns: 4,
        max_ready_items: 100, catalog_page_size: 25, turn_item_limit: 100, lease_seconds: 30,
        drain_timeout_seconds: 30, poll_interval_ms: 1_000, max_tenants_per_host: 10,
      },
      discovery: {
        enabled: true, tenant_view_id: "default-view", record_ttl_seconds: 60,
        default_page_limit: 20, max_page_limit: 100, max_records_per_origin: 10_000,
        sync_page_size: 100, query_max_hops: 2, query_max_fanout: 4, query_max_bytes: 32_768,
      },
    })).toThrow(/discovery.*worker/i);
  });
});
