import {
  MemoryAuditStore,
  MemoryCollaborationViewStore,
  MemoryDiscrepancyStore,
  MemoryRecoveryStore,
} from "@work-fabric/adapter-operations-memory";
import type { ConnectorDiscrepancyStore } from "@work-fabric/connector-runtime";
import {
  MemoryHandoffReadModelStore,
} from "@work-fabric/exchange-runtime";
import type { HandoffReadModelStore } from "@work-fabric/exchange-spi";
import type {
  AuditStore,
  CollaborationViewStore,
  RecoveryRequestStore,
} from "@work-fabric/operations-spi";

import { createSqliteDurableAdapter } from "./sqlite-durable-adapter.js";
import type { SqliteSession } from "./sqlite-session.js";

function assertTenant(value: unknown, tenantId: string): void {
  if (value !== tenantId) throw new Error("tenant context mismatch");
}

function objectTenant(value: unknown): unknown {
  return (value as { tenant_id?: unknown } | undefined)?.tenant_id;
}

export function createSqliteHandoffReadModelStore(
  session: SqliteSession,
  tenantId: string,
): HandoffReadModelStore {
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "handoff-read-model",
    target: new MemoryHandoffReadModelStore(),
    mutations: new Set(["putHandoff", "clearPartition"]),
    tenant_guard(method, args) {
      if (method === "putHandoff") assertTenant(objectTenant(args[0]), tenantId);
    },
  });
}

export interface SqliteOperationsStores {
  readonly collaboration: CollaborationViewStore;
  readonly audit: AuditStore;
  readonly discrepancies: ConnectorDiscrepancyStore;
  readonly recoveries: RecoveryRequestStore;
}

export function createSqliteOperationsStores(
  session: SqliteSession,
  tenantId: string,
  cursorSecret: string,
): SqliteOperationsStores {
  let recoveryClaimSequence = 0;
  const collaboration = createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "operations-collaboration",
    target: new MemoryCollaborationViewStore({ cursor_secret: cursorSecret }),
    mutations: new Set([
      "putResponsibility",
      "putTimeline",
      "putRelationship",
      "replaceHandoffRelationships",
      "clearPartition",
    ]),
    tenant_guard(method, args) {
      assertTenant(
        ["replaceHandoffRelationships", "clearPartition"].includes(method)
          ? args[0]
          : method === "getResponsibility"
            ? tenantId
            : objectTenant(args[0]),
        tenantId,
      );
    },
  });
  const audit = createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "operations-audit",
    target: new MemoryAuditStore({ cursor_secret: cursorSecret }),
    mutations: new Set(["append", "pruneBefore"]),
    tenant_guard(method, args) {
      assertTenant(method === "pruneBefore" ? args[0] : objectTenant(args[0]), tenantId);
    },
  });
  const discrepancies = createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "operations-discrepancy",
    target: new MemoryDiscrepancyStore({ cursor_secret: cursorSecret }),
    mutations: new Set(["put", "acknowledge"]),
    tenant_guard(method, args) {
      assertTenant(method === "get" ? args[0] : objectTenant(args[0]), tenantId);
    },
  });
  const recoveries = createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "operations-recovery",
    target: new MemoryRecoveryStore({
      claim_token_factory: () => `sqlite_recovery_${++recoveryClaimSequence}`,
    }),
    mutations: new Set(["submit", "claim", "complete", "fail"]),
    tenant_guard(method, args) {
      assertTenant(method === "get" ? args[0] : objectTenant(args[0]), tenantId);
    },
  });
  return { collaboration, audit, discrepancies, recoveries };
}
