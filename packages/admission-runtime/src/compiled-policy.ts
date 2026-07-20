import type { AdmissionPolicy } from "@work-fabric/admission-spi";

export interface CompiledAdmissionPolicy {
  readonly policy: AdmissionPolicy;
  readonly exact_allow: ReadonlySet<string>;
  readonly exact_deny: ReadonlySet<string>;
}

export function compileAdmissionPolicy(policy: AdmissionPolicy): CompiledAdmissionPolicy {
  return Object.freeze({
    policy: structuredClone(policy),
    exact_allow: new Set(policy.allow.external_subject_ids),
    exact_deny: new Set(policy.deny.external_subject_ids),
  });
}
