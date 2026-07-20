import {
  validateAdmissionRequest,
  type AdmissionDecision,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
  type AdmissionPolicy,
  type AdmissionPolicyProvider,
  type AdmissionRequest,
  type AdmissionResult,
  type CollaborationAdmissionService,
  type ExternalSubjectEvidence,
  type ExternalSubjectEvidenceProvider,
  type ExternalSubjectFingerprinter,
  type ParticipantBindingStore,
  type RepresentationGrantIssuer,
} from "@work-fabric/admission-spi";

import { compileAdmissionPolicy, type CompiledAdmissionPolicy } from "./compiled-policy.js";
import { BoundedEvidenceCache, type EvidenceCacheKey } from "./evidence-cache.js";

export interface CollaborationAdmissionServiceOptions {
  readonly policies: AdmissionPolicyProvider;
  readonly evidence_providers: ReadonlyMap<string, ExternalSubjectEvidenceProvider>;
  readonly binding_stores: ReadonlyMap<string, ParticipantBindingStore>;
  readonly decisions: AdmissionDecisionStore;
  readonly fingerprinter: ExternalSubjectFingerprinter;
  readonly grants: RepresentationGrantIssuer;
  readonly clock: { now(): string };
  readonly ids: {
    decisionId(): string;
    actorId(fingerprint: string): string;
    endpointId(fingerprint: string): string;
  };
  readonly grant_ttl_seconds: number;
  readonly retry_after_seconds: number;
  readonly max_evidence_cache_entries: number;
}

type TerminalDecision = Exclude<AdmissionDecision, { readonly kind: "temporarily_unavailable" }>;
type AllowDecision = Extract<AdmissionDecision, { readonly kind: "allow" }>;

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function sameScope(policy: AdmissionPolicy, request: AdmissionRequest): boolean {
  return policy.tenant_id === request.tenant_id
    && policy.connector_id === request.connector_id
    && policy.source_system === request.source_system
    && policy.external_tenant_id === request.external_tenant_id;
}

function scope(request: AdmissionRequest) {
  return {
    tenant_id: request.tenant_id,
    connector_id: request.connector_id,
    source_system: request.source_system,
    external_tenant_id: request.external_tenant_id,
  };
}

export class DefaultCollaborationAdmissionService implements CollaborationAdmissionService {
  private readonly compiledPolicies = new Map<string, CompiledAdmissionPolicy>();
  private readonly policiesByRequestedId = new Map<string, CompiledAdmissionPolicy>();
  private readonly policyLoads = new Map<string, Promise<CompiledAdmissionPolicy | null>>();
  private readonly evidenceCache: BoundedEvidenceCache;

  constructor(private readonly options: CollaborationAdmissionServiceOptions) {
    positiveSafeInteger(options.grant_ttl_seconds, "grant_ttl_seconds");
    positiveSafeInteger(options.retry_after_seconds, "retry_after_seconds");
    positiveSafeInteger(options.max_evidence_cache_entries, "max_evidence_cache_entries");
    this.evidenceCache = new BoundedEvidenceCache(options.max_evidence_cache_entries);
  }

  async admit(policyId: string, request: AdmissionRequest): Promise<AdmissionResult> {
    validateAdmissionRequest(request);

    let compiled: CompiledAdmissionPolicy | null;
    try {
      compiled = await this.loadPolicy(policyId);
    } catch {
      return this.unavailable("policy_unavailable");
    }
    if (compiled === null) return this.unavailable("policy_unavailable");

    const scopeMatches = sameScope(compiled.policy, request);

    let fingerprint: string;
    try {
      fingerprint = this.options.fingerprinter.fingerprint(request);
    } catch {
      return this.unavailable("store_unavailable");
    }

    let existing: AdmissionDecisionRecord | null;
    try {
      existing = await this.options.decisions.findByIngress({ ...scope(request), ingress_id: request.ingress_id });
    } catch {
      return this.unavailable("store_unavailable");
    }
    if (existing !== null) return this.resultForRecord(existing, request);

    if (!scopeMatches) {
      return this.recordTerminal(request, fingerprint, this.deny(compiled.policy, "scope_mismatch"));
    }

    if (compiled.exact_deny.has(request.external_subject_id)) {
      return this.recordTerminal(request, fingerprint, this.deny(compiled.policy, "explicit_deny"));
    }

    if (compiled.exact_allow.has(request.external_subject_id)) {
      return this.allow(compiled.policy, request, fingerprint, "explicit_allow");
    }

    if (request.external_subject_type === "human"
      && compiled.policy.allow.all_internal_members
      && compiled.policy.internal_membership !== undefined) {
      const evidence = await this.resolveEvidence(compiled.policy, request, fingerprint);
      if (evidence === null) return this.unavailable("evidence_unavailable");
      if (evidence.membership === "internal" && evidence.active === true) {
        return this.allow(compiled.policy, request, fingerprint, "internal_member", evidence);
      }
      const reason = evidence.membership === "internal" ? "inactive_subject" : "not_internal_member";
      return this.recordTerminal(request, fingerprint, this.deny(compiled.policy, reason), evidence);
    }

    return this.recordTerminal(request, fingerprint, this.deny(compiled.policy, "default_deny"));
  }

  private async loadPolicy(policyId: string): Promise<CompiledAdmissionPolicy | null> {
    const cached = this.policiesByRequestedId.get(policyId);
    if (cached !== undefined) return cached;
    const inFlight = this.policyLoads.get(policyId);
    if (inFlight !== undefined) return inFlight;

    const load = this.options.policies.load(policyId).then((policy) => {
      if (policy === null) return null;
      if (policy.policy_id !== policyId) throw new TypeError("policy_id mismatch");
      const key = JSON.stringify([policy.policy_id, policy.revision]);
      let compiled = this.compiledPolicies.get(key);
      if (compiled === undefined) {
        compiled = compileAdmissionPolicy(policy);
        this.compiledPolicies.set(key, compiled);
      }
      this.policiesByRequestedId.set(policyId, compiled);
      return compiled;
    }).finally(() => {
      this.policyLoads.delete(policyId);
    });
    this.policyLoads.set(policyId, load);
    return load;
  }

  private async resolveEvidence(
    policy: AdmissionPolicy,
    request: AdmissionRequest,
    fingerprint: string,
  ): Promise<ExternalSubjectEvidence | null> {
    const membership = policy.internal_membership!;
    const provider = this.options.evidence_providers.get(membership.evidence_provider_ref);
    if (provider === undefined) return null;
    const nowMs = Date.parse(this.options.clock.now());
    if (!Number.isFinite(nowMs)) return null;
    const key: EvidenceCacheKey = {
      ...scope(request),
      subject_type: request.external_subject_type,
      subject_fingerprint: fingerprint,
      provider_ref: membership.evidence_provider_ref,
    };
    const cached = this.evidenceCache.get(key, nowMs);
    if (cached !== null) return cached;
    let evidence: ExternalSubjectEvidence;
    try {
      evidence = await provider.resolve(request);
    } catch {
      return null;
    }
    const observedAtValidationMs = Date.parse(this.options.clock.now());
    if (!Number.isFinite(observedAtValidationMs)) return null;
    const cachedSuccessfully = this.evidenceCache.put(
      key,
      evidence,
      membership.positive_ttl_seconds,
      membership.negative_ttl_seconds,
      observedAtValidationMs,
    );
    return cachedSuccessfully ? structuredClone(evidence) : null;
  }

  private async allow(
    policy: AdmissionPolicy,
    request: AdmissionRequest,
    fingerprint: string,
    reasonCode: AllowDecision["reason_code"],
    evidence?: ExternalSubjectEvidence,
  ): Promise<AdmissionResult> {
    const store = this.options.binding_stores.get(policy.binding.store_ref);
    if (store === undefined) return this.unavailable("store_unavailable");
    let binding;
    try {
      binding = await store.getOrCreate({
        request,
        external_subject_fingerprint: fingerprint,
        actor_id: this.options.ids.actorId(fingerprint),
        endpoint_id: this.options.ids.endpointId(fingerprint),
        created_at: this.options.clock.now(),
      });
    } catch {
      return this.unavailable("store_unavailable");
    }
    const decision: AllowDecision = {
      kind: "allow",
      reason_code: reasonCode,
      policy_id: policy.policy_id,
      policy_revision: policy.revision,
      binding,
      decision_id: this.options.ids.decisionId(),
    };
    return this.recordTerminal(request, fingerprint, decision, evidence);
  }

  private deny(policy: AdmissionPolicy, reasonCode: Extract<AdmissionDecision, { kind: "deny" }>["reason_code"]): TerminalDecision {
    return {
      kind: "deny",
      reason_code: reasonCode,
      policy_id: policy.policy_id,
      policy_revision: policy.revision,
      decision_id: this.options.ids.decisionId(),
    };
  }

  private async recordTerminal(
    request: AdmissionRequest,
    fingerprint: string,
    decision: TerminalDecision,
    evidence?: ExternalSubjectEvidence,
  ): Promise<AdmissionResult> {
    const input: AdmissionDecisionRecord = {
      decision,
      scope: scope(request),
      ingress_id: request.ingress_id,
      external_subject_fingerprint: fingerprint,
      ...(evidence === undefined ? {} : {
        evidence: {
          membership: evidence.membership,
          active: evidence.active,
          observed_at: evidence.observed_at,
          provider_revision: evidence.provider_revision,
        },
      }),
      recorded_at: this.options.clock.now(),
    };
    let canonical: AdmissionDecisionRecord;
    try {
      canonical = await this.options.decisions.record(input);
    } catch {
      return this.unavailable("store_unavailable");
    }
    return this.resultForRecord(canonical, request);
  }

  private async resultForRecord(record: AdmissionDecisionRecord, request: AdmissionRequest): Promise<AdmissionResult> {
    if (record.decision.kind === "deny") return { decision: record.decision };
    let grant: string;
    try {
      const nowMs = Date.parse(this.options.clock.now());
      const expiresAt = new Date(nowMs + this.options.grant_ttl_seconds * 1_000).toISOString();
      grant = await this.options.grants.issue({ request, decision: record.decision, expires_at: expiresAt });
    } catch {
      return this.unavailable("grant_unavailable");
    }
    return { decision: record.decision, representation_grant: grant };
  }

  private unavailable(reasonCode: Extract<AdmissionDecision, { kind: "temporarily_unavailable" }>["reason_code"]): AdmissionResult {
    return {
      decision: {
        kind: "temporarily_unavailable",
        reason_code: reasonCode,
        retry_after_seconds: this.options.retry_after_seconds,
      },
    };
  }
}
