import { describe, expect, it } from "vitest";

import {
  ConfigurationAdmissionPolicyProvider,
  validateAdmissionConfiguration,
} from "../src/index.js";

function policy(overrides: Record<string, unknown> = {}) {
  return {
    policy_id: "policy-primary",
    revision: "2026-07-20",
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "feishu",
    external_tenant_id: "external-tenant-1",
    default: "deny",
    allow: { all_internal_members: false, external_subject_ids: ["user-allow"] },
    deny: { external_subject_ids: ["user-deny"] },
    binding: { actor_type: "human", store_ref: "bindings-primary" },
    ...overrides,
  };
}

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    policies: { "policy-primary": policy() },
    evidence_providers: { membership: { type: "test.membership.v1", config: { audience: "internal" } } },
    ...overrides,
  };
}

describe("Admission configuration policy provider", () => {
  it("validates strict policies, descriptors, and returns cloned policies", async () => {
    const section = validateAdmissionConfiguration(configuration(), "admission");
    const provider = new ConfigurationAdmissionPolicyProvider(section);
    const loaded = await provider.load("policy-primary");
    expect(provider.manifest).toEqual({
      profile: "admission.policy-provider.v1", adapter: "configuration",
      capabilities: { immutable_revision: true, source_neutral: true },
    });
    expect(loaded).toEqual(policy());
    expect(loaded).not.toBe(section.policies["policy-primary"]);
    expect(await provider.load("missing")).toBeNull();
  });

  it.each([
    ["unknown policy key", configuration({ policies: { "policy-primary": policy({ unexpected: true }) } })],
    ["unknown evidence descriptor key", configuration({ evidence_providers: { membership: { type: "test.membership.v1", config: {}, extra: true } } })],
    ["duplicate allow IDs", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: false, external_subject_ids: ["duplicate", "duplicate"] } }) } })],
    ["duplicate deny IDs", configuration({ policies: { "policy-primary": policy({ deny: { external_subject_ids: ["duplicate", "duplicate"] } }) } })],
    ["literal wildcard ID", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: false, external_subject_ids: ["*"] } }) } })],
    ["default allow", configuration({ policies: { "policy-primary": policy({ default: "allow" }) } })],
    ["internal wildcard without evidence", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: true, external_subject_ids: [] } }) } })],
    ["non-human wildcard binding", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: true, external_subject_ids: [] }, internal_membership: { evidence_provider_ref: "membership", positive_ttl_seconds: 60, negative_ttl_seconds: 60 }, binding: { actor_type: "agent", store_ref: "bindings-primary" } }) } })],
    ["invalid membership TTL", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: true, external_subject_ids: [] }, internal_membership: { evidence_provider_ref: "membership", positive_ttl_seconds: 0, negative_ttl_seconds: 86_401 } }) } })],
    ["mismatched policy map key", configuration({ policies: { "wrong-key": policy() } })],
    ["too many allow IDs", configuration({ policies: { "policy-primary": policy({ allow: { all_internal_members: false, external_subject_ids: Array.from({ length: 10_001 }, (_, index) => `allow-${index}`) } }) } })],
    ["too many deny IDs", configuration({ policies: { "policy-primary": policy({ deny: { external_subject_ids: Array.from({ length: 10_001 }, (_, index) => `deny-${index}`) } }) } })],
  ])("rejects %s", (_label, value) => {
    expect(() => validateAdmissionConfiguration(value, "admission")).toThrow();
  });
});
