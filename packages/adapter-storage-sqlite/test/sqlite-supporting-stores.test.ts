import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyConnectorIngressProfile,
  verifyEndpointDirectoryProfile,
  verifyOperationsStoreProfile,
  verifyRecoveryStoreProfile,
  verifyTenantScopedProjectionProfile,
} from "@work-fabric/exchange-conformance";

import {
  SqliteSession,
  createSqliteConnectorIngressStore,
  createSqliteContextStore,
  createSqliteEndpointDirectoryStore,
  createSqliteEndpointInboxStore,
  createSqliteHandoffReadModelStore,
  createSqliteOperationsStores,
  migrateSqlite,
} from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite supporting stores", () => {
  it("passes Connector, Endpoint, projection, operations and recovery profiles", async () => {
    await verifyConnectorIngressProfile(() => {
      const session = new SqliteSession({ location: ":memory:" });
      migrateSqlite(session);
      return createSqliteConnectorIngressStore(session, "tenant_profile_01");
    });
    await verifyEndpointDirectoryProfile(() => {
      const session = new SqliteSession({ location: ":memory:" });
      migrateSqlite(session);
      return createSqliteEndpointDirectoryStore(session, "tenant_profile_01");
    });
    const projectionSession = new SqliteSession({ location: ":memory:" });
    migrateSqlite(projectionSession);
    await verifyTenantScopedProjectionProfile((tenantId) =>
      createSqliteHandoffReadModelStore(projectionSession, tenantId)
    );
    await verifyOperationsStoreProfile(() => {
      const session = new SqliteSession({ location: ":memory:" });
      migrateSqlite(session);
      return createSqliteOperationsStores(
        session,
        "tenant-profile",
        "stable-profile-cursor-secret",
      );
    });
    const recoverySession = new SqliteSession({ location: ":memory:" });
    migrateSqlite(recoverySession);
    await verifyRecoveryStoreProfile((tenantId) =>
      createSqliteOperationsStores(
        recoverySession,
        tenantId,
        "stable-recovery-cursor-secret",
      ).recoveries
    );
  });

  it("replays Context, Connector, Handoff, collaboration and audit facts after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-support-"));
    directories.push(directory);
    const location = join(directory, "work-fabric.db");
    const firstSession = new SqliteSession({ location });
    migrateSqlite(firstSession);
    const context = createSqliteContextStore(firstSession, "tenant-local");
    await context.putBundle("tenant-local", {
      context_id: "context-local",
      version: 1,
      digest: null,
      visibility_scope: { actor_ids: ["actor-local"], endpoint_ids: ["endpoint-local"] },
      chunks: [],
    });
    const connector = createSqliteConnectorIngressStore(firstSession, "tenant-local", {
      id_factory: () => "ingress-local",
      claim_token_factory: () => "claim-local",
    });
    const inbox = createSqliteEndpointInboxStore(firstSession, "tenant-local");
    await inbox.upsertRoutingFact({
      tenant_id: "tenant-local",
      partition_id: "partition-local",
      handoff_id: "handoff-local",
      resource_version: 1,
      lifecycle_state: "offered",
      capability_ids: [],
      last_event_id: "event-local",
      observed_position: 1,
      visible_actor_ids: ["actor-local"],
      visible_endpoint_ids: ["endpoint-local"],
      active: true,
    });
    await connector.accept({
      tenant_id: "tenant-local",
      connector_id: "connector-local",
      source_system: "feishu",
      external_tenant_id: "external-local",
      external_event_id: "event-local",
      dedupe_key: "dedupe-local",
      event_type: "document.changed",
      occurred_at: "2026-07-16T08:00:00.000Z",
      received_at: "2026-07-16T08:00:01.000Z",
      payload: {},
    });
    const handoffs = createSqliteHandoffReadModelStore(firstSession, "tenant-local");
    await handoffs.putHandoff({
      tenant_id: "tenant-local",
      partition_id: "partition-local",
      handoff_id: "handoff-local",
      stream_version: 1,
      state: { lifecycle_state: "offered" },
      latest_status: null,
    });
    const operations = createSqliteOperationsStores(
      firstSession,
      "tenant-local",
      "stable-local-cursor-secret",
    );
    await operations.audit.append({
      tenant_id: "tenant-local",
      audit_id: "audit-local",
      occurred_at: "2026-07-16T08:00:02.000Z",
      request_id: "request-local",
      trace_id: null,
      principal_id: "principal-local",
      represented_actor: null,
      represented_endpoint_id: null,
      delegation_id: null,
      operation: "workfabric.test.read.v1",
      resource_kind: "tenant",
      resource_id: "tenant-local",
      authorization_decision: "allowed",
      outcome: "succeeded",
      reason_code: null,
      service_category: "http",
    });
    firstSession.close();

    const secondSession = new SqliteSession({ location });
    migrateSqlite(secondSession);
    const reopenedContext = createSqliteContextStore(
      secondSession,
      "tenant-local",
    );
    const contextAccess = {
      tenant_id: "tenant-local",
      actor_id: "actor-local",
      endpoint_id: "endpoint-local",
      reference: { context_id: "context-local", version: 1, digest: null },
    };
    await expect(reopenedContext.checkAvailability(contextAccess)).resolves.toEqual({
      kind: "available",
    });
    await expect(reopenedContext.readBundle(contextAccess)).resolves.toEqual({
      kind: "available",
      bundle: {
        context_id: "context-local",
        version: 1,
        digest: null,
        visibility_scope: {
          actor_ids: ["actor-local"],
          endpoint_ids: ["endpoint-local"],
        },
        chunks: [],
      },
    });
    await expect(createSqliteConnectorIngressStore(
      secondSession,
      "tenant-local",
      {
        id_factory: () => "ingress-local",
        claim_token_factory: () => "claim-local",
      },
    ).get({
      tenant_id: "tenant-local",
      connector_id: "connector-local",
      ingress_id: "ingress-local",
    })).resolves.toMatchObject({ ingress_id: "ingress-local", state: "pending" });
    await expect(createSqliteHandoffReadModelStore(
      secondSession,
      "tenant-local",
    ).getHandoff("handoff-local")).resolves.toMatchObject({ stream_version: 1 });
    await expect(createSqliteEndpointInboxStore(
      secondSession,
      "tenant-local",
    ).listPartitions({
      tenant_id: "tenant-local",
      actor_id: "actor-local",
      endpoint_id: "endpoint-local",
      limit: 10,
    })).resolves.toMatchObject({
      items: [{ partition_id: "partition-local", latest_position: 1 }],
    });
    const reopenedOperations = createSqliteOperationsStores(
      secondSession,
      "tenant-local",
      "stable-local-cursor-secret",
    );
    await expect(reopenedOperations.audit.list({
      tenant_id: "tenant-local",
      limit: 10,
    })).resolves.toMatchObject({ items: [{ audit_id: "audit-local" }] });
    secondSession.close();
  });
});
