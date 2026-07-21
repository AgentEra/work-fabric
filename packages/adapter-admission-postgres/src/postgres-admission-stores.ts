import { isDeepStrictEqual } from "node:util";

import {
  ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES,
  ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES,
  AdmissionAdapterError,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
  type AdmissionSubjectType,
  type ParticipantBinding,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import type { PostgresClient, TenantSession } from "@work-fabric/adapter-postgres-common";
import { assertCapabilities, type CapabilityManifest } from "@work-fabric/exchange-spi";

type SessionFactory = () => TenantSession | Promise<TenantSession>;

const bindingManifest: CapabilityManifest = {
  profile: "admission.binding-store.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

const decisionManifest: CapabilityManifest = {
  profile: "admission.decision-store.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

type BindingRow = {
  tenant_id: string;
  connector_id: string;
  source_system: string;
  external_tenant_id: string;
  external_subject_type: AdmissionSubjectType;
  external_subject_fingerprint: string;
  actor_id: string;
  actor_type: AdmissionSubjectType;
  endpoint_id: string;
  created_at: string | Date;
};

type DecisionRow = {
  tenant_id: string;
  connector_id: string;
  source_system: string;
  external_tenant_id: string;
  ingress_id: string;
  idempotency_key: string;
  decision_kind: "allow" | "deny";
  reason_code: string;
  policy_id: string;
  policy_revision: string;
  decision_id: string;
  external_subject_fingerprint: string;
  binding_external_subject_type: AdmissionSubjectType | null;
  binding_external_subject_fingerprint: string | null;
  binding_actor_id: string | null;
  binding_actor_type: AdmissionSubjectType | null;
  binding_endpoint_id: string | null;
  binding_created_at: string | Date | null;
  evidence_present: boolean;
  evidence_membership: "internal" | "external" | "unknown" | null;
  evidence_active: boolean | null;
  evidence_observed_at: string | Date | null;
  evidence_provider_revision: string | null;
  recorded_at: string | Date;
};

const forbiddenKeys = new Set([
  "external_subject_id",
  "representation_grant",
  "token",
  "secret",
  "message",
  "content",
]);

class DecisionConflictError extends Error {}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeTimestamp(value: string): string {
  const match = RFC3339.exec(value);
  if (match === null) throw new TypeError("timestamp must be RFC3339");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new TypeError("timestamp must be RFC3339");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new TypeError("timestamp must be RFC3339");
  return new Date(epoch).toISOString();
}

function databaseTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("timestamp must be valid");
    return value.toISOString();
  }
  return normalizeTimestamp(value);
}

function bindingError(): AdmissionAdapterError {
  return new AdmissionAdapterError("binding_store_unavailable", "admission_binding_store_unavailable");
}

function decisionError(message = "admission_decision_store_unavailable"): AdmissionAdapterError {
  return new AdmissionAdapterError("decision_store_unavailable", message);
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

function assertDecisionRecordSafe(value: unknown): asserts value is AdmissionDecisionRecord {
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    for (const [field, child] of Object.entries(candidate)) {
      if (forbiddenKeys.has(field)) throw new TypeError("decision record contains private data");
      visit(child);
    }
  };
  visit(JSON.parse(JSON.stringify(value)) as unknown);
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

function bindingFromRow(row: BindingRow): ParticipantBinding {
  return {
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    source_system: row.source_system,
    external_tenant_id: row.external_tenant_id,
    external_subject_type: row.external_subject_type,
    external_subject_fingerprint: row.external_subject_fingerprint,
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    endpoint_id: row.endpoint_id,
    created_at: databaseTimestamp(row.created_at),
  };
}

function normalizeDecisionRecord(record: AdmissionDecisionRecord): AdmissionDecisionRecord {
  return {
    ...clone(record),
    decision: record.decision.kind === "allow"
      ? {
          ...clone(record.decision),
          binding: {
            ...clone(record.decision.binding),
            created_at: normalizeTimestamp(record.decision.binding.created_at),
          },
        }
      : clone(record.decision),
    ...(record.evidence === undefined ? {} : {
      evidence: {
        ...clone(record.evidence),
        observed_at: normalizeTimestamp(record.evidence.observed_at),
      },
    }),
    recorded_at: normalizeTimestamp(record.recorded_at),
  };
}

function decisionFromRow(row: DecisionRow): AdmissionDecisionRecord {
  const scope = {
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    source_system: row.source_system,
    external_tenant_id: row.external_tenant_id,
  };
  const decision: AdmissionDecisionRecord["decision"] = row.decision_kind === "allow"
    ? {
        kind: "allow",
        reason_code: row.reason_code as "explicit_allow" | "internal_member",
        policy_id: row.policy_id,
        policy_revision: row.policy_revision,
        decision_id: row.decision_id,
        binding: {
          ...scope,
          external_subject_type: row.binding_external_subject_type!,
          external_subject_fingerprint: row.binding_external_subject_fingerprint!,
          actor_id: row.binding_actor_id!,
          actor_type: row.binding_actor_type!,
          endpoint_id: row.binding_endpoint_id!,
          created_at: databaseTimestamp(row.binding_created_at!),
        },
      }
    : {
        kind: "deny",
        reason_code: row.reason_code as "explicit_deny" | "not_internal_member" | "inactive_subject" | "default_deny" | "scope_mismatch",
        policy_id: row.policy_id,
        policy_revision: row.policy_revision,
        decision_id: row.decision_id,
      };
  return {
    decision,
    scope,
    ingress_id: row.ingress_id,
    idempotency_key: row.idempotency_key,
    external_subject_fingerprint: row.external_subject_fingerprint,
    ...(row.evidence_present ? {
      evidence: {
        membership: row.evidence_membership!,
        active: row.evidence_active,
        observed_at: databaseTimestamp(row.evidence_observed_at!),
        provider_revision: row.evidence_provider_revision!,
      },
    } : {}),
    recorded_at: databaseTimestamp(row.recorded_at),
  };
}

function decisionValues(record: AdmissionDecisionRecord): readonly unknown[] {
  const binding = record.decision.kind === "allow" ? record.decision.binding : undefined;
  const evidence = record.evidence;
  return [
    record.scope.tenant_id,
    record.scope.connector_id,
    record.scope.source_system,
    record.scope.external_tenant_id,
    record.ingress_id,
    record.idempotency_key,
    record.decision.kind,
    record.decision.reason_code,
    record.decision.policy_id,
    record.decision.policy_revision,
    record.decision.decision_id,
    record.external_subject_fingerprint,
    binding?.external_subject_type ?? null,
    binding?.external_subject_fingerprint ?? null,
    binding?.actor_id ?? null,
    binding?.actor_type ?? null,
    binding?.endpoint_id ?? null,
    binding?.created_at ?? null,
    evidence !== undefined,
    evidence?.membership ?? null,
    evidence?.active ?? null,
    evidence?.observed_at ?? null,
    evidence?.provider_revision ?? null,
    record.recorded_at,
  ];
}

async function run<T>(sessions: SessionFactory, tenantId: string, operation: (client: PostgresClient) => Promise<T>): Promise<T> {
  const session = await sessions();
  if (session.tenant_id !== tenantId) throw new Error("tenant context mismatch");
  return session.withTransaction(operation);
}

export class PostgresParticipantBindingStore implements ParticipantBindingStore {
  constructor(private readonly sessions: SessionFactory, private readonly tenantId: string) {
    if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("tenantId must be non-empty");
  }

  get manifest(): CapabilityManifest {
    const value = clone(bindingManifest);
    assertCapabilities(value, ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES);
    return value;
  }

  async getOrCreate(input: Parameters<ParticipantBindingStore["getOrCreate"]>[0]): Promise<ParticipantBinding> {
    try {
      if (input.request.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
      const createdAt = normalizeTimestamp(input.created_at);
      return await run(this.sessions, this.tenantId, async (client) => {
        const result = await client.query<BindingRow>(`
          INSERT INTO work_fabric_admission_bindings
            (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type,
             external_subject_fingerprint, actor_id, actor_type, endpoint_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
          ON CONFLICT (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type, external_subject_fingerprint)
          DO UPDATE SET external_subject_fingerprint = EXCLUDED.external_subject_fingerprint
          RETURNING tenant_id, connector_id, source_system, external_tenant_id, external_subject_type,
                    external_subject_fingerprint, actor_id, actor_type, endpoint_id, created_at
        `, [
          this.tenantId,
          input.request.connector_id,
          input.request.source_system,
          input.request.external_tenant_id,
          input.request.external_subject_type,
          input.external_subject_fingerprint,
          input.actor_id,
          input.request.external_subject_type,
          input.endpoint_id,
          createdAt,
        ]);
        const row = result.rows[0];
        if (row === undefined) throw new Error("binding unavailable");
        return bindingFromRow(row);
      });
    } catch {
      throw bindingError();
    }
  }
}

export class PostgresAdmissionDecisionStore implements AdmissionDecisionStore {
  constructor(private readonly sessions: SessionFactory, private readonly tenantId: string) {
    if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("tenantId must be non-empty");
  }

  get manifest(): CapabilityManifest {
    const value = clone(decisionManifest);
    assertCapabilities(value, ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES);
    return value;
  }

  async findByIngress(input: Parameters<AdmissionDecisionStore["findByIngress"]>[0]): Promise<AdmissionDecisionRecord | null> {
    try {
      if (input.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
      return await run(this.sessions, this.tenantId, async (client) => {
        const result = await client.query<DecisionRow>(`
          SELECT * FROM work_fabric_admission_decisions
          WHERE tenant_id = $1 AND connector_id = $2 AND source_system = $3 AND external_tenant_id = $4 AND ingress_id = $5
        `, [this.tenantId, input.connector_id, input.source_system, input.external_tenant_id, input.ingress_id]);
        const row = result.rows[0];
        return row === undefined ? null : decisionFromRow(row);
      });
    } catch {
      throw decisionError();
    }
  }

  async record(input: AdmissionDecisionRecord): Promise<AdmissionDecisionRecord> {
    try {
      assertDecisionRecordSafe(input);
      if (input.scope.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
      const candidate = normalizeDecisionRecord(input);
      return await run(this.sessions, this.tenantId, async (client) => {
        const inserted = await client.query<DecisionRow>(`
          INSERT INTO work_fabric_admission_decisions
            (tenant_id, connector_id, source_system, external_tenant_id, ingress_id, idempotency_key,
             decision_kind, reason_code, policy_id, policy_revision, decision_id,
             external_subject_fingerprint, binding_external_subject_type, binding_external_subject_fingerprint,
             binding_actor_id, binding_actor_type, binding_endpoint_id, binding_created_at,
             evidence_present, evidence_membership, evidence_active, evidence_observed_at,
             evidence_provider_revision, recorded_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17, $18::timestamptz, $19, $20, $21, $22::timestamptz, $23, $24::timestamptz)
          ON CONFLICT (tenant_id, connector_id, source_system, external_tenant_id, ingress_id) DO NOTHING
          RETURNING *
        `, decisionValues(candidate));
        let row = inserted.rows[0];
        if (row === undefined) {
          const existing = await client.query<DecisionRow>(`
            SELECT * FROM work_fabric_admission_decisions
            WHERE tenant_id = $1 AND connector_id = $2 AND source_system = $3 AND external_tenant_id = $4 AND ingress_id = $5
            FOR UPDATE
          `, [
            this.tenantId,
            candidate.scope.connector_id,
            candidate.scope.source_system,
            candidate.scope.external_tenant_id,
            candidate.ingress_id,
          ]);
          row = existing.rows[0];
        }
        if (row === undefined) throw new Error("decision unavailable");
        const persisted = decisionFromRow(row);
        if (!isDeepStrictEqual(persisted, candidate)) throw new DecisionConflictError();
        return clone(persisted);
      });
    } catch (error: unknown) {
      if (error instanceof DecisionConflictError) throw decisionError("admission_decision_conflict");
      throw decisionError();
    }
  }
}
