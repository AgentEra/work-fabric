import { describe, expect, it } from "vitest";

import {
  AdmissionAdapterError,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import {
  runAdmissionDecisionStoreProfile,
  runParticipantBindingStoreProfile,
} from "@work-fabric/admission-conformance";
import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresClient,
  type TenantSession,
} from "@work-fabric/adapter-postgres-common";
import {
  POSTGRES_ADMISSION_MIGRATION,
  PostgresAdmissionDecisionStore,
  PostgresParticipantBindingStore,
} from "../src/index.js";

type Row = Record<string, unknown>;

class MemoryPostgresState {
  readonly bindings = new Map<string, Row>();
  readonly decisions = new Map<string, Row>();
}

function row(columns: readonly string[], values: readonly unknown[]): Row {
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

class MemoryPostgresClient implements PostgresClient {
  constructor(private readonly state: MemoryPostgresState) {}

  async query<Result extends Row = Row>(text: string, values: readonly unknown[] = []): Promise<{ rows: readonly Result[]; rowCount: number }> {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("INSERT INTO work_fabric_admission_bindings")) {
      const columns = ["tenant_id", "connector_id", "source_system", "external_tenant_id", "external_subject_type", "external_subject_fingerprint", "actor_id", "actor_type", "endpoint_id", "created_at"];
      const key = JSON.stringify(values.slice(0, 6));
      const existing = this.state.bindings.get(key);
      const stored = existing ?? row(columns, values);
      this.state.bindings.set(key, stored);
      return { rows: [structuredClone(stored) as Result], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO work_fabric_admission_decisions")) {
      const columns = [
        "tenant_id", "connector_id", "source_system", "external_tenant_id", "ingress_id",
        "decision_kind", "reason_code", "policy_id", "policy_revision", "decision_id",
        "external_subject_fingerprint", "binding_external_subject_type", "binding_external_subject_fingerprint",
        "binding_actor_id", "binding_actor_type", "binding_endpoint_id", "binding_created_at",
        "evidence_present", "evidence_membership", "evidence_active", "evidence_observed_at",
        "evidence_provider_revision", "recorded_at",
      ];
      const key = JSON.stringify(values.slice(0, 5));
      if (this.state.decisions.has(key)) return { rows: [], rowCount: 0 };
      const stored = row(columns, values);
      this.state.decisions.set(key, stored);
      return { rows: [structuredClone(stored) as Result], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT") && normalized.includes("FROM work_fabric_admission_decisions")) {
      const stored = this.state.decisions.get(JSON.stringify(values.slice(0, 5)));
      return { rows: stored === undefined ? [] : [structuredClone(stored) as Result], rowCount: stored === undefined ? 0 : 1 };
    }
    throw new Error(`unexpected fake query: ${normalized}`);
  }

  release(): void {}
}

function memorySession(state: MemoryPostgresState, tenantId: string): TenantSession {
  return {
    tenant_id: tenantId,
    withTransaction(operation) {
      return operation(new MemoryPostgresClient(state));
    },
  };
}

function tenantRoutedBindingStore(state: MemoryPostgresState): ParticipantBindingStore {
  return {
    manifest: new PostgresParticipantBindingStore(() => memorySession(state, "tenant-profile"), "tenant-profile").manifest,
    getOrCreate(input) {
      const tenantId = input.request.tenant_id;
      return new PostgresParticipantBindingStore(() => memorySession(state, tenantId), tenantId).getOrCreate(input);
    },
  };
}

function tenantRoutedDecisionStore(state: MemoryPostgresState): AdmissionDecisionStore {
  return {
    manifest: new PostgresAdmissionDecisionStore(() => memorySession(state, "tenant-profile"), "tenant-profile").manifest,
    findByIngress(input) {
      return new PostgresAdmissionDecisionStore(() => memorySession(state, input.tenant_id), input.tenant_id).findByIngress(input);
    },
    record(input) {
      const tenantId = input.scope.tenant_id;
      return new PostgresAdmissionDecisionStore(() => memorySession(state, tenantId), tenantId).record(input);
    },
  };
}

function decisionRecord(tenantId = "tenant-postgres"): AdmissionDecisionRecord {
  const scope = {
    tenant_id: tenantId,
    connector_id: "connector-postgres",
    source_system: "source-postgres",
    external_tenant_id: "external-postgres",
  };
  return {
    decision: {
      kind: "allow",
      reason_code: "internal_member",
      policy_id: "policy-postgres",
      policy_revision: "revision-postgres",
      decision_id: "decision-postgres",
      binding: {
        ...scope,
        external_subject_type: "human",
        external_subject_fingerprint: "fingerprint-postgres",
        actor_id: "actor-postgres",
        actor_type: "human",
        endpoint_id: "endpoint-postgres",
        created_at: "2026-07-20T00:00:00.000Z",
      },
    },
    scope,
    ingress_id: "ingress-postgres",
    external_subject_fingerprint: "fingerprint-postgres",
    evidence: {
      membership: "internal",
      active: true,
      observed_at: "2026-07-20T00:00:00.000Z",
      provider_revision: "provider-postgres",
    },
    recorded_at: "2026-07-20T00:00:01.000Z",
  };
}

describe("PostgreSQL Admission stores", () => {
  it("ships composite authority keys and fail-closed tenant RLS", () => {
    expect(POSTGRES_ADMISSION_MIGRATION.id).toBe("010_admission");
    expect(POSTGRES_ADMISSION_MIGRATION.sql).toContain("PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type, external_subject_fingerprint)");
    expect(POSTGRES_ADMISSION_MIGRATION.sql).toContain("PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, ingress_id)");
    expect(POSTGRES_ADMISSION_MIGRATION.sql).toContain("UNIQUE (tenant_id, actor_id)");
    expect(POSTGRES_ADMISSION_MIGRATION.sql).toContain("UNIQUE (tenant_id, endpoint_id)");
    expect(POSTGRES_ADMISSION_MIGRATION.sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(POSTGRES_ADMISSION_MIGRATION.sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(POSTGRES_ADMISSION_MIGRATION.sql.match(/work_fabric_current_tenant\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(POSTGRES_ADMISSION_MIGRATION.sql).not.toMatch(/external_subject_id|representation_grant|message_content/i);
    expect(POSTGRES_ADMISSION_MIGRATION.sql).not.toMatch(/jsonb/i);
  });

  it("passes the binding conformance profile with transaction-scoped tenant sessions", async () => {
    const state = new MemoryPostgresState();
    await runParticipantBindingStoreProfile(() => tenantRoutedBindingStore(state));
  });

  it("passes the decision conformance profile with transaction-scoped tenant sessions", async () => {
    const state = new MemoryPostgresState();
    await runAdmissionDecisionStoreProfile(() => tenantRoutedDecisionStore(state));
  });

  it("fails closed when a session tenant is wrong and redacts driver errors", async () => {
    const mismatched = new PostgresParticipantBindingStore(
      () => memorySession(new MemoryPostgresState(), "tenant-wrong"),
      "tenant-expected",
    );
    const failure = await mismatched.getOrCreate({
      request: {
        tenant_id: "tenant-expected",
        connector_id: "connector-secret",
        source_system: "source-secret",
        external_tenant_id: "external-secret",
        external_subject_type: "human",
        external_subject_id: "raw-secret",
        ingress_id: "ingress-secret",
      },
      external_subject_fingerprint: "fingerprint-secret",
      actor_id: "actor-secret",
      endpoint_id: "endpoint-secret",
      created_at: "2026-07-20T00:00:00.000Z",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdmissionAdapterError);
    expect(failure).toMatchObject({
      code: "binding_store_unavailable",
      message: "admission_binding_store_unavailable",
    });
    expect(String((failure as Error).message)).not.toContain("secret");

    const failingSession: TenantSession = {
      tenant_id: "tenant-expected",
      withTransaction: async () => {
        throw new Error("duplicate key from SQL containing secret-driver-value");
      },
    };
    const driverFailure = await new PostgresParticipantBindingStore(
      () => failingSession,
      "tenant-expected",
    ).getOrCreate({
      request: {
        tenant_id: "tenant-expected",
        connector_id: "connector",
        source_system: "source",
        external_tenant_id: "external",
        external_subject_type: "human",
        external_subject_id: "raw-private",
        ingress_id: "ingress",
      },
      external_subject_fingerprint: "fingerprint",
      actor_id: "actor",
      endpoint_id: "endpoint",
      created_at: "2026-07-20T00:00:00.000Z",
    }).catch((error: unknown) => error);
    expect(driverFailure).toMatchObject({
      code: "binding_store_unavailable",
      message: "admission_binding_store_unavailable",
    });
    expect(String((driverFailure as Error).message)).not.toContain("secret-driver-value");
  });

  it("does not trust an AdmissionAdapterError thrown by the PostgreSQL driver", async () => {
    const failedSession: TenantSession = {
      tenant_id: "tenant-postgres",
      withTransaction: async () => {
        throw new AdmissionAdapterError(
          "decision_store_unavailable",
          "SELECT private_value FROM admission_secret",
        );
      },
    };
    const failure = await new PostgresAdmissionDecisionStore(
      () => failedSession,
      "tenant-postgres",
    ).record(decisionRecord()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdmissionAdapterError);
    expect(failure).toMatchObject({
      code: "decision_store_unavailable",
      message: "admission_decision_store_unavailable",
    });
    expect(String((failure as Error).message)).not.toContain("private_value");
  });

  it("normalizes equivalent RFC3339 timestamps before write and replay comparison", async () => {
    const state = new MemoryPostgresState();
    const store = new PostgresAdmissionDecisionStore(
      () => memorySession(state, "tenant-postgres"),
      "tenant-postgres",
    );
    const canonical = decisionRecord();
    const allow = canonical.decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>;
    const offset: AdmissionDecisionRecord = {
      ...canonical,
      recorded_at: "2026-07-20T08:00:01+08:00",
      decision: {
        ...allow,
        binding: { ...allow.binding, created_at: "2026-07-20T08:00:00+08:00" },
      },
      evidence: { ...canonical.evidence!, observed_at: "2026-07-20T08:00:00+08:00" },
    };
    await expect(store.record(offset)).resolves.toEqual(canonical);
    await expect(store.record(canonical)).resolves.toEqual(canonical);
  });

  it("rejects invalid RFC3339 decision timestamps before opening a transaction", async () => {
    let transactions = 0;
    const session: TenantSession = {
      tenant_id: "tenant-postgres",
      withTransaction: async () => {
        transactions += 1;
        throw new Error("must not run");
      },
    };
    const canonical = decisionRecord();
    const allow = canonical.decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>;
    for (const invalid of [
      { ...canonical, recorded_at: "not-a-time" },
      { ...canonical, decision: { ...allow, binding: { ...allow.binding, created_at: "2026-02-30T00:00:00Z" } } },
      { ...canonical, evidence: { ...canonical.evidence!, observed_at: "2026-07-20 00:00:00" } },
    ] satisfies AdmissionDecisionRecord[]) {
      await expect(new PostgresAdmissionDecisionStore(
        () => session,
        "tenant-postgres",
      ).record(invalid)).rejects.toMatchObject({
        code: "decision_store_unavailable",
        message: "admission_decision_store_unavailable",
      });
    }
    expect(transactions).toBe(0);
  });
});

const liveConnection = process.env.WORK_FABRIC_TEST_POSTGRES_URL;
const live = typeof liveConnection === "string" && liveConnection.trim().length > 0;

describe.skipIf(!live)("PostgreSQL Admission live integration", () => {
  it("converges concurrent clients and isolates tenant sessions", async () => {
    if (liveConnection === undefined) return;
    const pool = createPgPool(liveConnection);
    try {
      const migrationClient = await pool.connect();
      try {
        await runMigrations(migrationClient, [TENANT_CONTEXT_MIGRATION, POSTGRES_ADMISSION_MIGRATION]);
      } finally {
        migrationClient.release();
      }
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tenantA = `admission-a-${suffix}`;
      const tenantB = `admission-b-${suffix}`;
      const left = new PostgresParticipantBindingStore(() => createTenantSession(pool, tenantA), tenantA);
      const right = new PostgresParticipantBindingStore(() => createTenantSession(pool, tenantA), tenantA);
      const input = {
        request: {
          tenant_id: tenantA,
          connector_id: "connector-live",
          source_system: "source-live",
          external_tenant_id: "external-live",
          external_subject_type: "human" as const,
          external_subject_id: "not-persisted",
          ingress_id: "ingress-live",
        },
        external_subject_fingerprint: "fingerprint-live",
        created_at: "2026-07-20T00:00:00.000Z",
      };
      const bindings = await Promise.all([
        left.getOrCreate({ ...input, actor_id: "actor-left", endpoint_id: "endpoint-left" }),
        right.getOrCreate({ ...input, actor_id: "actor-right", endpoint_id: "endpoint-right" }),
      ]);
      expect(bindings[1]).toEqual(bindings[0]);

      const tenantADecisions = new PostgresAdmissionDecisionStore(() => createTenantSession(pool, tenantA), tenantA);
      const tenantBDecisions = new PostgresAdmissionDecisionStore(() => createTenantSession(pool, tenantB), tenantB);
      const tenantARecord = decisionRecord(tenantA);
      await expect(tenantADecisions.record(tenantARecord)).resolves.toEqual(tenantARecord);
      await expect(tenantADecisions.findByIngress({
        ...tenantARecord.scope,
        ingress_id: tenantARecord.ingress_id,
      })).resolves.toEqual(tenantARecord);
      await expect(tenantBDecisions.findByIngress({
        tenant_id: tenantB,
        connector_id: tenantARecord.scope.connector_id,
        source_system: tenantARecord.scope.source_system,
        external_tenant_id: tenantARecord.scope.external_tenant_id,
        ingress_id: tenantARecord.ingress_id,
      })).resolves.toBeNull();

      await expect(createTenantSession(pool, tenantB).withTransaction((client) => client.query(`
        INSERT INTO work_fabric_admission_decisions
          (tenant_id, connector_id, source_system, external_tenant_id, ingress_id,
           decision_kind, reason_code, policy_id, policy_revision, decision_id,
           external_subject_fingerprint, evidence_present, recorded_at)
        VALUES ($1, $2, $3, $4, $5, 'deny', 'default_deny', $6, $7, $8, $9, false, $10::timestamptz)
      `, [
        tenantA,
        "connector-cross-tenant",
        "source-cross-tenant",
        "external-cross-tenant",
        "ingress-cross-tenant",
        "policy-cross-tenant",
        "revision-cross-tenant",
        "decision-cross-tenant",
        "fingerprint-cross-tenant",
        "2026-07-20T00:00:00.000Z",
      ]))).rejects.toBeDefined();
    } finally {
      await pool.end();
    }
  });
});
