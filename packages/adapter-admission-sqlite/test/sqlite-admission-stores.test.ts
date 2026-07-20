import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdmissionAdapterError,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
  type AdmissionRequest,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import {
  runAdmissionDecisionStoreProfile,
  runParticipantBindingStoreProfile,
} from "@work-fabric/admission-conformance";
import {
  SqliteSession,
  migrateSqlite,
} from "@work-fabric/adapter-storage-sqlite";
import {
  SQLITE_ADMISSION_MIGRATION,
  SqliteAdmissionDecisionStore,
  SqliteParticipantBindingStore,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-sqlite",
    connector_id: "connector-sqlite",
    source_system: "source-sqlite",
    external_tenant_id: "external-tenant-sqlite",
    external_subject_type: "human",
    external_subject_id: "must-never-be-persisted",
    ingress_id: "ingress-sqlite",
    ...overrides,
  };
}

function decision(overrides: Partial<AdmissionDecisionRecord> = {}): AdmissionDecisionRecord {
  return {
    decision: {
      kind: "allow",
      reason_code: "internal_member",
      policy_id: "policy-sqlite",
      policy_revision: "revision-sqlite",
      decision_id: "decision-sqlite",
      binding: {
        tenant_id: "tenant-sqlite",
        connector_id: "connector-sqlite",
        source_system: "source-sqlite",
        external_tenant_id: "external-tenant-sqlite",
        external_subject_type: "human",
        external_subject_fingerprint: "fingerprint-sqlite",
        actor_id: "actor-sqlite",
        actor_type: "human",
        endpoint_id: "endpoint-sqlite",
        created_at: "2026-07-20T00:00:00.000Z",
      },
    },
    scope: {
      tenant_id: "tenant-sqlite",
      connector_id: "connector-sqlite",
      source_system: "source-sqlite",
      external_tenant_id: "external-tenant-sqlite",
    },
    ingress_id: "ingress-sqlite",
    external_subject_fingerprint: "fingerprint-sqlite",
    evidence: {
      membership: "internal",
      active: true,
      observed_at: "2026-07-20T00:00:00.000Z",
      provider_revision: "provider-sqlite",
    },
    recorded_at: "2026-07-20T00:00:01.000Z",
    ...overrides,
  };
}

function migratedMemorySession(): SqliteSession {
  const session = new SqliteSession({ location: ":memory:" });
  migrateSqlite(session, [SQLITE_ADMISSION_MIGRATION]);
  return session;
}

function tenantRoutedBindingStore(session: SqliteSession): ParticipantBindingStore {
  return {
    manifest: new SqliteParticipantBindingStore(session, "tenant-profile").manifest,
    getOrCreate(input) {
      return new SqliteParticipantBindingStore(session, input.request.tenant_id).getOrCreate(input);
    },
  };
}

function tenantRoutedDecisionStore(session: SqliteSession): AdmissionDecisionStore {
  return {
    manifest: new SqliteAdmissionDecisionStore(session, "tenant-profile").manifest,
    findByIngress(input) {
      return new SqliteAdmissionDecisionStore(session, input.tenant_id).findByIngress(input);
    },
    record(input) {
      return new SqliteAdmissionDecisionStore(session, input.scope.tenant_id).record(input);
    },
  };
}

describe("SQLite Admission stores", () => {
  it("ships an isolated typed migration without private subject or grant columns", () => {
    expect(SQLITE_ADMISSION_MIGRATION.id).toBe("005_admission");
    expect(SQLITE_ADMISSION_MIGRATION.sql).toContain("PRIMARY KEY (tenant_id, connector_id, source_system, external_tenant_id, external_subject_type, external_subject_fingerprint)");
    expect(SQLITE_ADMISSION_MIGRATION.sql).toContain("UNIQUE (tenant_id, actor_id)");
    expect(SQLITE_ADMISSION_MIGRATION.sql).toContain("UNIQUE (tenant_id, endpoint_id)");
    expect(SQLITE_ADMISSION_MIGRATION.sql).not.toMatch(/external_subject_id|representation_grant|message_content/i);

    const session = migratedMemorySession();
    const bindingColumns = session.prepare("PRAGMA table_info(work_fabric_admission_bindings)").all() as Array<{ name: string }>;
    const decisionColumns = session.prepare("PRAGMA table_info(work_fabric_admission_decisions)").all() as Array<{ name: string }>;
    expect(bindingColumns.map(({ name }) => name)).not.toContain("external_subject_id");
    expect(decisionColumns.map(({ name }) => name)).not.toContain("representation_grant");
    session.close();
  });

  it("passes the binding conformance profile through tenant-bound stores", async () => {
    const session = migratedMemorySession();
    await runParticipantBindingStoreProfile(() => tenantRoutedBindingStore(session));
    session.close();
  });

  it("passes the decision conformance profile through tenant-bound stores", async () => {
    const session = migratedMemorySession();
    await runAdmissionDecisionStoreProfile(() => tenantRoutedDecisionStore(session));
    session.close();
  });

  it("retains bindings and decisions across a file-backed restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-admission-sqlite-"));
    temporaryDirectories.push(directory);
    const location = join(directory, "admission.db");
    const firstSession = new SqliteSession({ location });
    migrateSqlite(firstSession, [SQLITE_ADMISSION_MIGRATION]);
    const firstBindings = new SqliteParticipantBindingStore(firstSession, "tenant-sqlite");
    const firstDecisions = new SqliteAdmissionDecisionStore(firstSession, "tenant-sqlite");
    const binding = await firstBindings.getOrCreate({
      request: request(),
      external_subject_fingerprint: "fingerprint-sqlite",
      actor_id: "actor-sqlite",
      endpoint_id: "endpoint-sqlite",
      created_at: "2026-07-20T00:00:00.000Z",
    });
    await firstDecisions.record(decision());
    firstSession.close();

    const secondSession = new SqliteSession({ location });
    migrateSqlite(secondSession, [SQLITE_ADMISSION_MIGRATION]);
    const reopenedBindings = new SqliteParticipantBindingStore(secondSession, "tenant-sqlite");
    const reopenedDecisions = new SqliteAdmissionDecisionStore(secondSession, "tenant-sqlite");
    await expect(reopenedBindings.getOrCreate({
      request: request(),
      external_subject_fingerprint: "fingerprint-sqlite",
      actor_id: "actor-replacement",
      endpoint_id: "endpoint-replacement",
      created_at: "2026-07-21T00:00:00.000Z",
    })).resolves.toEqual(binding);
    await expect(reopenedDecisions.findByIngress({
      ...decision().scope,
      ingress_id: "ingress-sqlite",
    })).resolves.toEqual(decision());
    secondSession.close();
  });

  it("converges two file sessions on one binding without replacing the winner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-admission-sqlite-"));
    temporaryDirectories.push(directory);
    const location = join(directory, "admission.db");
    const leftSession = new SqliteSession({ location });
    migrateSqlite(leftSession, [SQLITE_ADMISSION_MIGRATION]);
    const rightSession = new SqliteSession({ location });
    const left = new SqliteParticipantBindingStore(leftSession, "tenant-sqlite");
    const right = new SqliteParticipantBindingStore(rightSession, "tenant-sqlite");
    const common = { request: request(), external_subject_fingerprint: "concurrent-fingerprint", created_at: "2026-07-20T00:00:00.000Z" } as const;
    const values = await Promise.all([
      left.getOrCreate({ ...common, actor_id: "actor-left", endpoint_id: "endpoint-left" }),
      right.getOrCreate({ ...common, actor_id: "actor-right", endpoint_id: "endpoint-right" }),
    ]);
    expect(values[1]).toEqual(values[0]);
    leftSession.close();
    rightSession.close();
  });

  it("rejects tenant mismatch and redacts database failures", async () => {
    const session = migratedMemorySession();
    const store = new SqliteParticipantBindingStore(session, "tenant-sqlite");
    await expect(store.getOrCreate({
      request: request({ tenant_id: "tenant-other", external_subject_id: "raw-private-value" }),
      external_subject_fingerprint: "fingerprint-private",
      actor_id: "actor-private",
      endpoint_id: "endpoint-private",
      created_at: "2026-07-20T00:00:00.000Z",
    })).rejects.toMatchObject({
      name: "AdmissionAdapterError",
      code: "binding_store_unavailable",
      message: "admission_binding_store_unavailable",
    });
    session.close();

    const failedSession = {
      transaction(): never { throw new Error("SQL SELECT secret-value"); },
    } as unknown as SqliteSession;
    const failedStore = new SqliteParticipantBindingStore(failedSession, "tenant-sqlite");
    const failure = await failedStore.getOrCreate({
      request: request(),
      external_subject_fingerprint: "fingerprint-secret-value",
      actor_id: "actor-secret-value",
      endpoint_id: "endpoint-secret-value",
      created_at: "2026-07-20T00:00:00.000Z",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdmissionAdapterError);
    expect(String((failure as Error).message)).toBe("admission_binding_store_unavailable");
    expect(String((failure as Error).message)).not.toContain("secret-value");
  });

  it("does not trust an AdmissionAdapterError thrown by the SQLite driver", async () => {
    const failedSession = {
      transaction(): never {
        throw new AdmissionAdapterError(
          "decision_store_unavailable",
          "SELECT * FROM private_table WHERE secret = raw-private-value",
        );
      },
    } as unknown as SqliteSession;
    const failure = await new SqliteAdmissionDecisionStore(
      failedSession,
      "tenant-sqlite",
    ).record(decision()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdmissionAdapterError);
    expect(failure).toMatchObject({
      code: "decision_store_unavailable",
      message: "admission_decision_store_unavailable",
    });
    expect(String((failure as Error).message)).not.toContain("private");
  });

  it("normalizes every persisted timestamp before first write and replay comparison", async () => {
    const session = migratedMemorySession();
    const bindings = new SqliteParticipantBindingStore(session, "tenant-sqlite");
    await expect(bindings.getOrCreate({
      request: request(),
      external_subject_fingerprint: "time-fingerprint",
      actor_id: "time-actor",
      endpoint_id: "time-endpoint",
      created_at: "2026-07-20T08:00:00+08:00",
    })).resolves.toMatchObject({ created_at: "2026-07-20T00:00:00.000Z" });

    const store = new SqliteAdmissionDecisionStore(session, "tenant-sqlite");
    const offsetRecord = decision({
      recorded_at: "2026-07-20T08:00:01+08:00",
      evidence: {
        ...decision().evidence!,
        observed_at: "2026-07-20T08:00:00+08:00",
      },
      decision: {
        ...(decision().decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>),
        binding: {
          ...(decision().decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>).binding,
          created_at: "2026-07-20T08:00:00+08:00",
        },
      },
    });
    const normalized = decision();
    await expect(store.record(offsetRecord)).resolves.toEqual(normalized);
    await expect(store.record(normalized)).resolves.toEqual(normalized);
    session.close();
  });

  it("rejects invalid RFC3339 timestamps before persistence", async () => {
    const session = migratedMemorySession();
    const bindings = new SqliteParticipantBindingStore(session, "tenant-sqlite");
    await expect(bindings.getOrCreate({
      request: request(),
      external_subject_fingerprint: "invalid-time-fingerprint",
      actor_id: "invalid-time-actor",
      endpoint_id: "invalid-time-endpoint",
      created_at: "2026-02-30T00:00:00Z",
    })).rejects.toMatchObject({
      code: "binding_store_unavailable",
      message: "admission_binding_store_unavailable",
    });

    const store = new SqliteAdmissionDecisionStore(session, "tenant-sqlite");
    const allow = decision().decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>;
    for (const invalid of [
      decision({ recorded_at: "not-a-time" }),
      decision({ decision: { ...allow, binding: { ...allow.binding, created_at: "2026-02-30T00:00:00Z" } } }),
      decision({ evidence: { ...decision().evidence!, observed_at: "2026-07-20 00:00:00" } }),
    ]) {
      await expect(store.record(invalid)).rejects.toMatchObject({
        code: "decision_store_unavailable",
        message: "admission_decision_store_unavailable",
      });
    }
    session.close();
  });

  it("compares every persisted decision field before accepting an ingress replay", async () => {
    const session = migratedMemorySession();
    const store = new SqliteAdmissionDecisionStore(session, "tenant-sqlite");
    await store.record(decision());
    const allow = decision().decision as Extract<AdmissionDecisionRecord["decision"], { kind: "allow" }>;
    const conflicts: AdmissionDecisionRecord[] = [
      decision({ external_subject_fingerprint: "other-fingerprint" }),
      decision({ recorded_at: "2026-07-20T00:00:02.000Z" }),
      decision({ evidence: { ...decision().evidence!, active: false } }),
      decision({ evidence: { ...decision().evidence!, provider_revision: "other-provider" } }),
      decision({ decision: { ...decision().decision, policy_revision: "other-revision" } }),
      decision({ decision: { ...allow, binding: { ...allow.binding, endpoint_id: "other-endpoint" } } }),
    ];
    for (const conflict of conflicts) {
      await expect(store.record(conflict)).rejects.toMatchObject({
        code: "decision_store_unavailable",
        message: "admission_decision_conflict",
      });
    }
    session.close();
  });
});
