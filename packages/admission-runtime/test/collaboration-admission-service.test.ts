import { describe, expect, it } from "vitest";

import type {
  AdmissionDecisionRecord,
  AdmissionDecisionStore,
  AdmissionPolicy,
  AdmissionPolicyProvider,
  AdmissionRequest,
  ExternalSubjectEvidence,
  ExternalSubjectEvidenceProvider,
  ParticipantBinding,
  ParticipantBindingStore,
  RepresentationGrantIssuer,
} from "@work-fabric/admission-spi";
import { DefaultCollaborationAdmissionService } from "../src/index.js";

const manifest = (profile: string) => ({ profile, adapter: "test", capabilities: {} });

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "source-1",
    external_tenant_id: "external-tenant-1",
    external_subject_type: "human",
    external_subject_id: "subject-1",
    ingress_id: "ingress-1",
    ...overrides,
  };
}

function policy(overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy {
  return {
    policy_id: "policy-1",
    revision: "revision-1",
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "source-1",
    external_tenant_id: "external-tenant-1",
    default: "deny",
    allow: { all_internal_members: true, external_subject_ids: [] },
    deny: { external_subject_ids: [] },
    internal_membership: {
      evidence_provider_ref: "directory",
      positive_ttl_seconds: 10,
      negative_ttl_seconds: 2,
    },
    binding: { actor_type: "human", store_ref: "bindings" },
    ...overrides,
  };
}

function policyWithoutMembership(): AdmissionPolicy {
  const { internal_membership: _membership, ...value } = policy({
    allow: { all_internal_members: false, external_subject_ids: [] },
  });
  return value;
}

const internalEvidence: ExternalSubjectEvidence = {
  membership: "internal",
  active: true,
  observed_at: "2026-07-20T00:00:00.000Z",
  provider_revision: "directory-revision-1",
};

class TestPolicyProvider implements AdmissionPolicyProvider {
  readonly manifest = manifest("admission.policy-provider.v1");
  readonly calls: string[] = [];
  constructor(readonly values: ReadonlyMap<string, AdmissionPolicy | null>, readonly failure?: Error) {}
  async load(policyId: string): Promise<AdmissionPolicy | null> {
    this.calls.push(policyId);
    if (this.failure !== undefined) throw this.failure;
    return this.values.get(policyId) ?? null;
  }
}

class TestEvidenceProvider implements ExternalSubjectEvidenceProvider {
  readonly manifest = manifest("admission.evidence-provider.v1");
  readonly provider_ref = "directory";
  readonly calls: AdmissionRequest[] = [];
  constructor(
    public value: ExternalSubjectEvidence = internalEvidence,
    readonly failure?: Error,
    readonly onResolve?: () => void,
  ) {}
  async resolve(value: AdmissionRequest): Promise<ExternalSubjectEvidence> {
    this.calls.push(structuredClone(value));
    if (this.failure !== undefined) throw this.failure;
    this.onResolve?.();
    return structuredClone(this.value);
  }
}

class TestBindingStore implements ParticipantBindingStore {
  readonly manifest = manifest("admission.binding-store.v1");
  readonly calls: Array<Parameters<ParticipantBindingStore["getOrCreate"]>[0]> = [];
  constructor(readonly failure?: Error) {}
  async getOrCreate(input: Parameters<ParticipantBindingStore["getOrCreate"]>[0]): Promise<ParticipantBinding> {
    this.calls.push(structuredClone(input));
    if (this.failure !== undefined) throw this.failure;
    return {
      tenant_id: input.request.tenant_id,
      connector_id: input.request.connector_id,
      source_system: input.request.source_system,
      external_tenant_id: input.request.external_tenant_id,
      external_subject_type: input.request.external_subject_type,
      external_subject_fingerprint: input.external_subject_fingerprint,
      actor_id: input.actor_id,
      actor_type: "human",
      endpoint_id: input.endpoint_id,
      created_at: input.created_at,
    };
  }
}

class TestDecisionStore implements AdmissionDecisionStore {
  readonly manifest = manifest("admission.decision-store.v1");
  readonly records = new Map<string, AdmissionDecisionRecord>();
  readonly findCalls: Array<Parameters<AdmissionDecisionStore["findByIngress"]>[0]> = [];
  readonly recordCalls: AdmissionDecisionRecord[] = [];
  readonly events: string[];
  findFailure?: Error;
  recordFailure?: Error;
  canonical?: AdmissionDecisionRecord;
  constructor(events: string[] = []) { this.events = events; }
  async findByIngress(input: Parameters<AdmissionDecisionStore["findByIngress"]>[0]): Promise<AdmissionDecisionRecord | null> {
    this.findCalls.push(structuredClone(input));
    if (this.findFailure !== undefined) throw this.findFailure;
    return structuredClone(this.records.get(this.key(input)) ?? null);
  }
  async record(input: AdmissionDecisionRecord): Promise<AdmissionDecisionRecord> {
    this.events.push("record");
    this.recordCalls.push(structuredClone(input));
    if (this.recordFailure !== undefined) throw this.recordFailure;
    const result = structuredClone(this.canonical ?? input);
    this.records.set(this.key({ ...result.scope, ingress_id: result.ingress_id }), result);
    return structuredClone(result);
  }
  private key(input: { tenant_id: string; connector_id: string; source_system: string; external_tenant_id: string; ingress_id: string }): string {
    return [input.tenant_id, input.connector_id, input.source_system, input.external_tenant_id, input.ingress_id].join("\0");
  }
}

class TestGrantIssuer implements RepresentationGrantIssuer {
  readonly calls: Array<Parameters<RepresentationGrantIssuer["issue"]>[0]> = [];
  readonly events: string[];
  constructor(events: string[] = [], public failure: Error | undefined = undefined) { this.events = events; }
  async issue(input: Parameters<RepresentationGrantIssuer["issue"]>[0]): Promise<string> {
    this.events.push("grant");
    this.calls.push(structuredClone(input));
    if (this.failure !== undefined) throw this.failure;
    return `grant:${input.decision.decision_id}:${this.calls.length}`;
  }
}

class MutableClock {
  constructor(public value = "2026-07-20T00:00:00.000Z") {}
  now(): string { return this.value; }
}

function fixture(options: {
  policies?: TestPolicyProvider;
  evidence?: TestEvidenceProvider;
  evidenceProviders?: ReadonlyMap<string, ExternalSubjectEvidenceProvider>;
  bindings?: TestBindingStore;
  bindingStores?: ReadonlyMap<string, ParticipantBindingStore>;
  decisions?: TestDecisionStore;
  grants?: TestGrantIssuer;
  clock?: MutableClock;
} = {}) {
  const policies = options.policies ?? new TestPolicyProvider(new Map([["policy-1", policy()]]));
  const evidence = options.evidence ?? new TestEvidenceProvider();
  const bindings = options.bindings ?? new TestBindingStore();
  const decisions = options.decisions ?? new TestDecisionStore();
  const grants = options.grants ?? new TestGrantIssuer();
  const clock = options.clock ?? new MutableClock();
  const fingerprints: AdmissionRequest[] = [];
  let decisionSequence = 0;
  const service = new DefaultCollaborationAdmissionService({
    policies,
    evidence_providers: options.evidenceProviders ?? new Map([["directory", evidence]]),
    binding_stores: options.bindingStores ?? new Map([["bindings", bindings]]),
    decisions,
    fingerprinter: {
      fingerprint(value) {
        fingerprints.push(structuredClone(value));
        return `fingerprint:${value.external_subject_id}`;
      },
    },
    grants,
    clock,
    ids: {
      decisionId: () => `decision-${++decisionSequence}`,
      actorId: (fingerprint) => `actor:${fingerprint}`,
      endpointId: (fingerprint) => `endpoint:${fingerprint}`,
    },
    grant_ttl_seconds: 60,
    retry_after_seconds: 17,
    max_evidence_cache_entries: 2,
  });
  return { service, policies, evidence, bindings, decisions, grants, clock, fingerprints };
}

describe("DefaultCollaborationAdmissionService decision matrix", () => {
  interface DecisionScenario {
    readonly label: string;
    readonly policy: AdmissionPolicy;
    readonly request?: AdmissionRequest;
    readonly evidence?: ExternalSubjectEvidence;
    readonly expectedKind: "allow" | "deny";
    readonly reason: string;
    readonly evidenceCalls: number;
    readonly bindingCalls: number;
  }

  it.each([
    {
      label: "deny beats explicit allow",
      policy: policy({ allow: { all_internal_members: true, external_subject_ids: ["subject-1"] }, deny: { external_subject_ids: ["subject-1"] } }),
      expectedKind: "deny",
      reason: "explicit_deny",
      evidenceCalls: 0,
      bindingCalls: 0,
    },
    {
      label: "deny beats internal member",
      policy: policy({ deny: { external_subject_ids: ["subject-1"] } }),
      expectedKind: "deny",
      reason: "explicit_deny",
      evidenceCalls: 0,
      bindingCalls: 0,
    },
    {
      label: "explicit allow skips directory",
      policy: policy({ allow: { all_internal_members: true, external_subject_ids: ["subject-1"] } }),
      expectedKind: "allow",
      reason: "explicit_allow",
      evidenceCalls: 0,
      bindingCalls: 1,
    },
    {
      label: "active internal human is allowed",
      policy: policy(),
      expectedKind: "allow",
      reason: "internal_member",
      evidenceCalls: 1,
      bindingCalls: 1,
    },
    {
      label: "inactive internal human is denied",
      policy: policy(),
      evidence: { ...internalEvidence, active: false },
      expectedKind: "deny",
      reason: "inactive_subject",
      evidenceCalls: 1,
      bindingCalls: 0,
    },
    {
      label: "external human is denied",
      policy: policy(),
      evidence: { ...internalEvidence, membership: "external" },
      expectedKind: "deny",
      reason: "not_internal_member",
      evidenceCalls: 1,
      bindingCalls: 0,
    },
    {
      label: "unknown human is denied",
      policy: policy(),
      evidence: { ...internalEvidence, membership: "unknown", active: null },
      expectedKind: "deny",
      reason: "not_internal_member",
      evidenceCalls: 1,
      bindingCalls: 0,
    },
    {
      label: "internal agent still requires exact allow",
      policy: policy(),
      request: request({ external_subject_type: "agent" }),
      expectedKind: "deny",
      reason: "default_deny",
      evidenceCalls: 0,
      bindingCalls: 0,
    },
    {
      label: "no match is default deny",
      policy: policyWithoutMembership(),
      expectedKind: "deny",
      reason: "default_deny",
      evidenceCalls: 0,
      bindingCalls: 0,
    },
  ] satisfies readonly DecisionScenario[])("$label", async (scenario) => {
    const policies = new TestPolicyProvider(new Map([["policy-1", scenario.policy]]));
    const evidence = new TestEvidenceProvider(scenario.evidence ?? internalEvidence);
    const env = fixture({ policies, evidence });

    const result = await env.service.admit("policy-1", scenario.request ?? request());

    expect(result.decision.kind).toBe(scenario.expectedKind);
    expect("reason_code" in result.decision ? result.decision.reason_code : undefined).toBe(scenario.reason);
    expect(evidence.calls).toHaveLength(scenario.evidenceCalls);
    expect(env.bindings.calls).toHaveLength(scenario.bindingCalls);
    expect(env.decisions.recordCalls).toHaveLength(1);
    expect(env.grants.calls).toHaveLength(scenario.expectedKind === "allow" ? 1 : 0);
  });

  it("scope mismatch reuses the canonical ingress deny without evidence or binding lookup", async () => {
    const env = fixture();
    const mismatched = request({ tenant_id: "tenant-other" });

    const first = await env.service.admit("policy-1", mismatched);
    const second = await env.service.admit("policy-1", mismatched);

    expect(first.decision).toMatchObject({ kind: "deny", reason_code: "scope_mismatch" });
    expect(second.decision).toEqual(first.decision);
    expect(env.fingerprints).toEqual([mismatched, mismatched]);
    expect(env.decisions.findCalls).toHaveLength(2);
    expect(env.decisions.recordCalls).toHaveLength(1);
    expect(env.decisions.recordCalls[0]).toMatchObject({
      scope: {
        tenant_id: "tenant-other",
        connector_id: "connector-1",
        source_system: "source-1",
        external_tenant_id: "external-tenant-1",
      },
      ingress_id: "ingress-1",
      external_subject_fingerprint: "fingerprint:subject-1",
      decision: { kind: "deny", reason_code: "scope_mismatch" },
    });
    expect(env.evidence.calls).toHaveLength(0);
    expect(env.bindings.calls).toHaveLength(0);
  });

  it("directory outage is retryable and is not recorded", async () => {
    const env = fixture({ evidence: new TestEvidenceProvider(internalEvidence, new Error("secret directory detail")) });
    await expect(env.service.admit("policy-1", request())).resolves.toEqual({
      decision: { kind: "temporarily_unavailable", reason_code: "evidence_unavailable", retry_after_seconds: 17 },
    });
    expect(env.decisions.recordCalls).toHaveLength(0);
    expect(env.bindings.calls).toHaveLength(0);
  });

  it("binding outage is retryable and is not recorded", async () => {
    const env = fixture({ bindings: new TestBindingStore(new Error("secret binding detail")) });
    await expect(env.service.admit("policy-1", request())).resolves.toEqual({
      decision: { kind: "temporarily_unavailable", reason_code: "store_unavailable", retry_after_seconds: 17 },
    });
    expect(env.decisions.recordCalls).toHaveLength(0);
  });

  it("decision-store outage is retryable and prevents grant issuance", async () => {
    const decisions = new TestDecisionStore();
    decisions.recordFailure = new Error("secret decision detail");
    const env = fixture({ decisions });
    await expect(env.service.admit("policy-1", request())).resolves.toEqual({
      decision: { kind: "temporarily_unavailable", reason_code: "store_unavailable", retry_after_seconds: 17 },
    });
    expect(env.grants.calls).toHaveLength(0);
  });
});

describe("DefaultCollaborationAdmissionService orchestration", () => {
  it.each([
    ["missing policy", new TestPolicyProvider(new Map()), "policy_unavailable"],
    ["policy adapter exception", new TestPolicyProvider(new Map(), new Error("secret policy detail")), "policy_unavailable"],
    ["mismatched returned policy ID", new TestPolicyProvider(new Map([["policy-1", policy({ policy_id: "policy-other" })]])), "policy_unavailable"],
  ] as const)("fails closed for %s", async (_label, policies, reason) => {
    const env = fixture({ policies });
    const result = await env.service.admit("policy-1", request());
    expect(result).toEqual({ decision: { kind: "temporarily_unavailable", reason_code: reason, retry_after_seconds: 17 } });
    expect(env.fingerprints).toHaveLength(0);
  });

  it("fails closed when the selected evidence provider or binding store is missing", async () => {
    const noEvidence = fixture({ evidenceProviders: new Map() });
    await expect(noEvidence.service.admit("policy-1", request())).resolves.toMatchObject({
      decision: { kind: "temporarily_unavailable", reason_code: "evidence_unavailable" },
    });
    const noBinding = fixture({ bindingStores: new Map() });
    await expect(noBinding.service.admit("policy-1", request())).resolves.toMatchObject({
      decision: { kind: "temporarily_unavailable", reason_code: "store_unavailable" },
    });
  });

  it("preserves invalid caller input as TypeError", async () => {
    const env = fixture();
    await expect(env.service.admit("policy-1", request({ external_subject_id: "*" }))).rejects.toBeInstanceOf(TypeError);
    expect(env.policies.calls).toHaveLength(0);
  });

  it("loads and compiles each immutable policy snapshot once for the service lifetime", async () => {
    const policies = new TestPolicyProvider(new Map([
      ["policy-1", policy()],
      ["policy-2", policy({ policy_id: "policy-2", revision: "revision-2" })],
    ]));
    const env = fixture({ policies });
    await env.service.admit("policy-1", request({ ingress_id: "ingress-1" }));
    await env.service.admit("policy-1", request({ ingress_id: "ingress-2" }));
    await env.service.admit("policy-2", request({ ingress_id: "ingress-3" }));
    await env.service.admit("policy-2", request({ ingress_id: "ingress-4" }));
    expect(policies.calls).toEqual(["policy-1", "policy-2"]);
  });

  it("does not substitute compiled policies whose ID/revision tuples contain NUL", async () => {
    const firstPolicy = policy({
      policy_id: "a\0b",
      revision: "c",
      deny: { external_subject_ids: ["subject-1"] },
    });
    const secondPolicy = policy({
      policy_id: "a",
      revision: "b\0c",
      allow: { all_internal_members: false, external_subject_ids: ["subject-1"] },
      deny: { external_subject_ids: [] },
    });
    const policies = new TestPolicyProvider(new Map([
      [firstPolicy.policy_id, firstPolicy],
      [secondPolicy.policy_id, secondPolicy],
    ]));
    const env = fixture({ policies });

    const first = await env.service.admit(firstPolicy.policy_id, request({ ingress_id: "ingress-first" }));
    const second = await env.service.admit(secondPolicy.policy_id, request({ ingress_id: "ingress-second" }));

    expect(first.decision).toMatchObject({ kind: "deny", policy_id: firstPolicy.policy_id });
    expect(second.decision).toMatchObject({ kind: "allow", policy_id: secondPolicy.policy_id });
  });

  it("keeps the first compiled process snapshot isolated from provider mutation", async () => {
    const source = policy({ deny: { external_subject_ids: ["subject-1"] } });
    const policies = new TestPolicyProvider(new Map([["policy-1", source]]));
    const env = fixture({ policies });
    const first = await env.service.admit("policy-1", request({ ingress_id: "ingress-1" }));
    (source.deny.external_subject_ids as string[]).splice(0);
    const second = await env.service.admit("policy-1", request({ ingress_id: "ingress-2" }));
    expect(first.decision).toMatchObject({ kind: "deny", reason_code: "explicit_deny" });
    expect(second.decision).toMatchObject({ kind: "deny", reason_code: "explicit_deny" });
    expect(policies.calls).toHaveLength(1);
  });

  it.each([
    ["invalid", { ...internalEvidence, observed_at: "not-a-date" }],
    ["future", { ...internalEvidence, observed_at: "2026-07-20T00:00:00.001Z" }],
    ["stale", { ...internalEvidence, observed_at: "2026-07-19T23:59:49.999Z" }],
  ])("rejects %s directory evidence without caching it", async (_label, value) => {
    const evidence = new TestEvidenceProvider(value);
    const env = fixture({ evidence });
    const first = await env.service.admit("policy-1", request({ ingress_id: "ingress-1" }));
    const second = await env.service.admit("policy-1", request({ ingress_id: "ingress-2" }));
    expect(first.decision).toMatchObject({ kind: "temporarily_unavailable", reason_code: "evidence_unavailable" });
    expect(second.decision).toMatchObject({ kind: "temporarily_unavailable", reason_code: "evidence_unavailable" });
    expect(evidence.calls).toHaveLength(2);
  });

  it("validates newly resolved evidence against the clock after the provider returns", async () => {
    const clock = new MutableClock();
    const evidence = new TestEvidenceProvider(
      { ...internalEvidence, observed_at: "2026-07-20T00:00:01.000Z" },
      undefined,
      () => { clock.value = "2026-07-20T00:00:01.000Z"; },
    );
    const env = fixture({ clock, evidence });

    const result = await env.service.admit("policy-1", request());

    expect(result.decision).toMatchObject({ kind: "allow", reason_code: "internal_member" });
  });

  it("reuses positive and negative evidence until their distinct TTLs expire", async () => {
    const evidence = new TestEvidenceProvider(internalEvidence);
    const clock = new MutableClock();
    const env = fixture({ evidence, clock });
    await env.service.admit("policy-1", request({ ingress_id: "positive-1" }));
    clock.value = "2026-07-20T00:00:09.999Z";
    await env.service.admit("policy-1", request({ ingress_id: "positive-2" }));
    expect(evidence.calls).toHaveLength(1);
    clock.value = "2026-07-20T00:00:10.000Z";
    evidence.value = { ...internalEvidence, observed_at: clock.value };
    await env.service.admit("policy-1", request({ ingress_id: "positive-3" }));
    expect(evidence.calls).toHaveLength(2);

    evidence.value = { ...internalEvidence, membership: "external", observed_at: clock.value };
    await env.service.admit("policy-1", request({ external_subject_id: "negative", ingress_id: "negative-1" }));
    clock.value = "2026-07-20T00:00:11.999Z";
    await env.service.admit("policy-1", request({ external_subject_id: "negative", ingress_id: "negative-2" }));
    expect(evidence.calls).toHaveLength(3);
    clock.value = "2026-07-20T00:00:12.000Z";
    evidence.value = { ...evidence.value, observed_at: clock.value };
    await env.service.admit("policy-1", request({ external_subject_id: "negative", ingress_id: "negative-3" }));
    expect(evidence.calls).toHaveLength(4);
  });

  it("bounds the service evidence cache by insertion order", async () => {
    const evidence = new TestEvidenceProvider(internalEvidence);
    const env = fixture({ evidence });
    for (const externalSubjectId of ["one", "two", "three", "one"]) {
      evidence.value = { ...internalEvidence };
      await env.service.admit("policy-1", request({ external_subject_id: externalSubjectId, ingress_id: `ingress-${externalSubjectId}-${evidence.calls.length}` }));
    }
    expect(evidence.calls).toHaveLength(4);
  });

  it("reuses an existing deny without evaluation and an existing allow with a fresh grant only", async () => {
    const policies = new TestPolicyProvider(new Map([[
      "policy-1",
      policy({ deny: { external_subject_ids: ["denied"] } }),
    ]]));
    const env = fixture({ policies });
    const denied = await env.service.admit("policy-1", request({ external_subject_id: "denied", ingress_id: "denied" }));
    const firstAllow = await env.service.admit("policy-1", request({ ingress_id: "allowed" }));
    const bindingCount = env.bindings.calls.length;
    const evidenceCount = env.evidence.calls.length;
    const secondDeny = await env.service.admit("policy-1", request({ external_subject_id: "denied", ingress_id: "denied" }));
    const secondAllow = await env.service.admit("policy-1", request({ ingress_id: "allowed" }));

    expect(denied.decision.kind).toBe("deny");
    expect(secondDeny.decision).toEqual(denied.decision);
    expect(secondAllow.decision).toEqual(firstAllow.decision);
    expect(secondAllow.representation_grant).not.toBe(firstAllow.representation_grant);
    expect(env.bindings.calls).toHaveLength(bindingCount);
    expect(env.evidence.calls).toHaveLength(evidenceCount);
    expect(env.decisions.recordCalls).toHaveLength(2);
    expect(env.grants.calls).toHaveLength(2);
  });

  it("uses the store-returned allow record as canonical and grants only after recording", async () => {
    const events: string[] = [];
    const decisions = new TestDecisionStore(events);
    const grants = new TestGrantIssuer(events);
    const canonicalBinding: ParticipantBinding = {
      tenant_id: "tenant-1", connector_id: "connector-1", source_system: "source-1", external_tenant_id: "external-tenant-1",
      external_subject_type: "human", external_subject_fingerprint: "fingerprint:subject-1", actor_id: "actor:canonical",
      actor_type: "human", endpoint_id: "endpoint:canonical", created_at: "2026-07-19T00:00:00.000Z",
    };
    decisions.canonical = {
      decision: { kind: "allow", reason_code: "internal_member", policy_id: "policy-1", policy_revision: "revision-1", binding: canonicalBinding, decision_id: "decision-canonical" },
      scope: { tenant_id: "tenant-1", connector_id: "connector-1", source_system: "source-1", external_tenant_id: "external-tenant-1" },
      ingress_id: "ingress-1", external_subject_fingerprint: "fingerprint:subject-1", evidence: internalEvidence,
      recorded_at: "2026-07-20T00:00:00.000Z",
    };
    const env = fixture({ decisions, grants });
    const result = await env.service.admit("policy-1", request());

    expect(events).toEqual(["record", "grant"]);
    expect(result.decision).toEqual(decisions.canonical.decision);
    expect(grants.calls[0]?.decision).toEqual(decisions.canonical.decision);
    expect(grants.calls[0]?.expires_at).toBe("2026-07-20T00:01:00.000Z");
  });

  it("retains a recorded allow across grant failure and reissues from it on retry", async () => {
    const failingGrants = new TestGrantIssuer([], new Error("secret grant detail"));
    const env = fixture({ grants: failingGrants });
    const first = await env.service.admit("policy-1", request());
    expect(first).toEqual({ decision: { kind: "temporarily_unavailable", reason_code: "grant_unavailable", retry_after_seconds: 17 } });
    expect(env.decisions.recordCalls).toHaveLength(1);
    const bindingCount = env.bindings.calls.length;
    const evidenceCount = env.evidence.calls.length;

    failingGrants.failure = undefined;
    const second = await env.service.admit("policy-1", request());
    expect(second.decision.kind).toBe("allow");
    expect(second.representation_grant).toBeDefined();
    expect(env.decisions.recordCalls).toHaveLength(1);
    expect(env.bindings.calls).toHaveLength(bindingCount);
    expect(env.evidence.calls).toHaveLength(evidenceCount);
  });

  it.each([
    ["grant_ttl_seconds", 0],
    ["grant_ttl_seconds", 1.5],
    ["retry_after_seconds", -1],
    ["retry_after_seconds", Number.MAX_SAFE_INTEGER + 1],
    ["max_evidence_cache_entries", 0],
    ["max_evidence_cache_entries", Number.POSITIVE_INFINITY],
  ])("rejects invalid constructor option %s=%s", (field, value) => {
    const env = fixture();
    const base = {
      policies: env.policies,
      evidence_providers: new Map([["directory", env.evidence]]),
      binding_stores: new Map([["bindings", env.bindings]]),
      decisions: env.decisions,
      fingerprinter: { fingerprint: () => "fingerprint" },
      grants: env.grants,
      clock: env.clock,
      ids: { decisionId: () => "decision", actorId: () => "actor", endpointId: () => "endpoint" },
      grant_ttl_seconds: 60,
      retry_after_seconds: 17,
      max_evidence_cache_entries: 2,
    };
    expect(() => new DefaultCollaborationAdmissionService({ ...base, [field]: value })).toThrow();
  });
});
