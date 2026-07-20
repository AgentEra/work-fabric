export interface AdmissionCapabilityManifest {
  readonly profile: string;
  readonly adapter: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface AdmissionAdapter {
  readonly manifest: AdmissionCapabilityManifest;
}

export const ADMISSION_POLICY_PROVIDER_REQUIRED_CAPABILITIES = [
  "immutable_revision",
  "source_neutral",
] as const;

export const ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES = [
  "authenticated_subject_facts",
  "tenant_binding",
  "bounded_evidence",
] as const;

export const ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES = [
  "atomic_get_or_create",
  "tenant_isolation",
  "stable_binding",
] as const;

export const ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES = [
  "ingress_idempotency",
  "tenant_isolation",
  "bounded_audit",
] as const;

export type AdmissionSubjectType = "human" | "agent" | "system";

export interface AdmissionScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
}

export interface AdmissionRequest extends AdmissionScope {
  readonly external_subject_type: AdmissionSubjectType;
  readonly external_subject_id: string;
  readonly ingress_id: string;
}

export interface ExternalSubjectEvidence {
  readonly membership: "internal" | "external" | "unknown";
  readonly active: boolean | null;
  readonly observed_at: string;
  readonly provider_revision: string;
}

export interface AdmissionPolicy extends AdmissionScope {
  readonly policy_id: string;
  readonly revision: string;
  readonly default: "deny";
  readonly allow: {
    readonly all_internal_members: boolean;
    readonly external_subject_ids: readonly string[];
  };
  readonly deny: { readonly external_subject_ids: readonly string[] };
  readonly internal_membership?: {
    readonly evidence_provider_ref: string;
    readonly positive_ttl_seconds: number;
    readonly negative_ttl_seconds: number;
  };
  readonly binding: { readonly actor_type: AdmissionSubjectType; readonly store_ref: string };
}

export interface ParticipantBinding extends AdmissionScope {
  readonly external_subject_type: AdmissionSubjectType;
  readonly external_subject_fingerprint: string;
  readonly actor_id: string;
  readonly actor_type: AdmissionSubjectType;
  readonly endpoint_id: string;
  readonly created_at: string;
}

export type AdmissionDecision =
  | { readonly kind: "allow"; readonly reason_code: "explicit_allow" | "internal_member"; readonly policy_id: string; readonly policy_revision: string; readonly binding: ParticipantBinding; readonly decision_id: string }
  | { readonly kind: "deny"; readonly reason_code: "explicit_deny" | "not_internal_member" | "inactive_subject" | "default_deny" | "scope_mismatch"; readonly policy_id: string; readonly policy_revision: string; readonly decision_id: string }
  | { readonly kind: "temporarily_unavailable"; readonly reason_code: "policy_unavailable" | "evidence_unavailable" | "store_unavailable" | "grant_unavailable"; readonly retry_after_seconds: number };

export interface AdmissionResult {
  readonly decision: AdmissionDecision;
  readonly representation_grant?: string;
}

export interface AdmissionPolicyProvider extends AdmissionAdapter {
  load(policyId: string): Promise<AdmissionPolicy | null>;
}

export interface ExternalSubjectEvidenceProvider extends AdmissionAdapter {
  readonly provider_ref: string;
  resolve(request: AdmissionRequest): Promise<ExternalSubjectEvidence>;
}

export interface ExternalSubjectFingerprinter {
  fingerprint(request: AdmissionRequest): string;
}

export interface ParticipantBindingStore extends AdmissionAdapter {
  getOrCreate(input: { readonly request: AdmissionRequest; readonly external_subject_fingerprint: string; readonly actor_id: string; readonly endpoint_id: string; readonly created_at: string }): Promise<ParticipantBinding>;
}

export interface AdmissionDecisionRecord {
  readonly decision: Exclude<AdmissionDecision, { readonly kind: "temporarily_unavailable" }>;
  readonly scope: AdmissionScope;
  readonly ingress_id: string;
  readonly external_subject_fingerprint: string;
  readonly evidence?: Pick<ExternalSubjectEvidence, "membership" | "active" | "observed_at" | "provider_revision">;
  readonly recorded_at: string;
}

export interface AdmissionDecisionStore extends AdmissionAdapter {
  findByIngress(input: AdmissionScope & { readonly ingress_id: string }): Promise<AdmissionDecisionRecord | null>;
  record(input: AdmissionDecisionRecord): Promise<AdmissionDecisionRecord>;
}

export interface RepresentationGrantIssuer {
  issue(input: { readonly request: AdmissionRequest; readonly decision: Extract<AdmissionDecision, { readonly kind: "allow" }>; readonly expires_at: string }): Promise<string>;
}

export interface RepresentationGrantVerifier {
  verify(grant: string, now: string): Promise<{ readonly tenant_id: string; readonly connector_id: string; readonly ingress_id: string; readonly decision_id: string; readonly actor_id: string; readonly actor_type: AdmissionSubjectType; readonly endpoint_id: string; readonly external_subject_fingerprint: string; readonly expires_at: string } | null>;
}

export interface CollaborationAdmissionService {
  admit(policyId: string, request: AdmissionRequest): Promise<AdmissionResult>;
}

function assertBoundedIdentifier(value: string, field: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${field} must be a trimmed string of 1-${maximum} UTF-16 code units`);
  }
}

export function validateAdmissionRequest(request: AdmissionRequest): void {
  assertBoundedIdentifier(request.tenant_id, "tenant_id", 255);
  assertBoundedIdentifier(request.connector_id, "connector_id", 255);
  assertBoundedIdentifier(request.source_system, "source_system", 255);
  assertBoundedIdentifier(request.external_tenant_id, "external_tenant_id", 255);
  assertBoundedIdentifier(request.external_subject_id, "external_subject_id", 255);
  assertBoundedIdentifier(request.ingress_id, "ingress_id", 128);
  if (request.external_subject_id === "*") {
    throw new TypeError("external_subject_id must not be a wildcard");
  }
}
