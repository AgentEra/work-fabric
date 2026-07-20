import { describe, expect, it, vi } from "vitest";

import type { AdmissionPolicy } from "@work-fabric/admission-spi";
import { compileAdmissionPolicy } from "../src/index.js";

function policy(): AdmissionPolicy {
  return {
    policy_id: "policy-primary",
    revision: "revision-1",
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "source-1",
    external_tenant_id: "external-tenant-1",
    default: "deny",
    allow: { all_internal_members: false, external_subject_ids: ["allow-1"] },
    deny: { external_subject_ids: ["deny-1"] },
    binding: { actor_type: "human", store_ref: "bindings" },
  };
}

describe("compileAdmissionPolicy", () => {
  it("clones the immutable policy snapshot and compiles exact IDs into sets", () => {
    const source = policy();
    const compiled = compileAdmissionPolicy(source);

    expect(Object.isFrozen(compiled)).toBe(true);
    expect(compiled.policy).toEqual(source);
    expect(compiled.policy).not.toBe(source);
    expect(compiled.exact_allow).toBeInstanceOf(Set);
    expect(compiled.exact_deny).toBeInstanceOf(Set);
    expect(compiled.exact_allow.has("allow-1")).toBe(true);
    expect(compiled.exact_deny.has("deny-1")).toBe(true);

    (source.allow.external_subject_ids as string[])[0] = "caller-mutated";
    expect(compiled.policy.allow.external_subject_ids).toEqual(["allow-1"]);
    expect(compiled.exact_allow.has("allow-1")).toBe(true);
  });

  it("uses Set.has for exact membership checks", () => {
    const compiled = compileAdmissionPolicy(policy());
    const has = vi.spyOn(Set.prototype, "has");

    expect(compiled.exact_allow.has("allow-1")).toBe(true);
    expect(compiled.exact_deny.has("deny-1")).toBe(true);
    expect(has).toHaveBeenCalledTimes(2);
  });
});
