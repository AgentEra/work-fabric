import { isDeepStrictEqual } from "node:util";

import {
  ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES,
  AdmissionAdapterError,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
} from "@work-fabric/admission-spi";
import { assertCapabilities, type CapabilityManifest } from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "admission.decision-store.v1",
  adapter: "memory",
  capabilities: {
    ...Object.fromEntries(ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true])),
    process_local_atomicity: true,
  },
};

const forbiddenKeys = new Set([
  "external_subject_id",
  "representation_grant",
  "token",
  "secret",
  "message",
  "content",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const candidate = value as Record<string, unknown>;
  for (const field of Object.keys(candidate)) {
    if (!allowed.includes(field)) throw new TypeError(`${label} contains unsafe field`);
  }
  return candidate;
}

function requireFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const field of fields) if (!(field in value)) throw new TypeError(`${label} is incomplete`);
}

function scanSerialized(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    for (const [field, child] of Object.entries(candidate)) {
      if (forbiddenKeys.has(field)) throw new TypeError("decision record contains private data");
      visit(child);
    }
  };
  visit(JSON.parse(JSON.stringify(value)) as unknown);
}

function assertDecisionRecordIsPrivateAndBounded(value: unknown): asserts value is AdmissionDecisionRecord {
  scanSerialized(value);
  const record = object(value, ["decision", "scope", "ingress_id", "idempotency_key", "external_subject_fingerprint", "evidence", "recorded_at"], "decision record");
  requireFields(record, ["decision", "scope", "ingress_id", "idempotency_key", "external_subject_fingerprint", "recorded_at"], "decision record");
  if (typeof record.idempotency_key !== "string" || record.idempotency_key.length === 0 || record.idempotency_key.length > 256 || record.idempotency_key.trim() !== record.idempotency_key) {
    throw new TypeError("decision record idempotency_key is invalid");
  }
  const scope = object(record.scope, ["tenant_id", "connector_id", "source_system", "external_tenant_id"], "scope");
  requireFields(scope, ["tenant_id", "connector_id", "source_system", "external_tenant_id"], "scope");
  const decision = object(record.decision, ["kind", "reason_code", "policy_id", "policy_revision", "binding", "decision_id"], "decision");
  requireFields(decision, ["kind", "reason_code", "policy_id", "policy_revision", "decision_id"], "decision");
  if (decision.kind === "allow") {
    requireFields(decision, ["binding"], "allow decision");
    const binding = object(decision.binding, ["tenant_id", "connector_id", "source_system", "external_tenant_id", "external_subject_type", "external_subject_fingerprint", "actor_id", "actor_type", "endpoint_id", "created_at"], "binding");
    requireFields(binding, ["tenant_id", "connector_id", "source_system", "external_tenant_id", "external_subject_type", "external_subject_fingerprint", "actor_id", "actor_type", "endpoint_id", "created_at"], "binding");
  } else if (decision.kind !== "deny" || "binding" in decision) {
    throw new TypeError("decision is invalid");
  }
  if (record.evidence !== undefined) {
    const evidence = object(record.evidence, ["membership", "active", "observed_at", "provider_revision"], "evidence");
    requireFields(evidence, ["membership", "active", "observed_at", "provider_revision"], "evidence");
  }
}

export class MemoryAdmissionDecisionStore implements AdmissionDecisionStore {
  private readonly records = new Map<string, AdmissionDecisionRecord>();

  get manifest(): CapabilityManifest {
    const value = clone(manifest);
    assertCapabilities(value, ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES);
    return value;
  }

  async findByIngress(input: Parameters<AdmissionDecisionStore["findByIngress"]>[0]): Promise<AdmissionDecisionRecord | null> {
    const lookup = clone(input);
    const record = this.records.get(key([
      lookup.tenant_id,
      lookup.connector_id,
      lookup.source_system,
      lookup.external_tenant_id,
      lookup.ingress_id,
    ]));
    return record === undefined ? null : clone(record);
  }

  async record(input: AdmissionDecisionRecord): Promise<AdmissionDecisionRecord> {
    assertDecisionRecordIsPrivateAndBounded(input);
    const candidate = clone(input);
    const recordKey = key([
      candidate.scope.tenant_id,
      candidate.scope.connector_id,
      candidate.scope.source_system,
      candidate.scope.external_tenant_id,
      candidate.ingress_id,
    ]);
    const existing = this.records.get(recordKey);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, candidate)) {
        throw new AdmissionAdapterError("decision_store_unavailable", "admission_decision_conflict");
      }
      return clone(existing);
    }
    this.records.set(recordKey, candidate);
    return clone(candidate);
  }
}
