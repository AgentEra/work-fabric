import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import type {
  EndpointDirectoryStore,
  EndpointInboxStore,
} from "@work-fabric/exchange-spi";

import { createSqliteDurableAdapter } from "./sqlite-durable-adapter.js";
import type { SqliteSession } from "./sqlite-session.js";

function assertTenant(value: unknown, tenantId: string): void {
  if (value !== tenantId) throw new Error("tenant context mismatch");
}

function inputTenant(input: unknown): unknown {
  const value = input as Record<string, unknown> | undefined;
  const registration = value?.registration as Record<string, unknown> | undefined;
  return registration?.tenant_id ?? value?.tenant_id;
}

export function createSqliteEndpointDirectoryStore(
  session: SqliteSession,
  tenantId: string,
): EndpointDirectoryStore {
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "endpoint-directory",
    target: new MemoryEndpointDirectoryStore(),
    mutations: new Set([
      "putRegistration",
      "openSession",
      "heartbeat",
      "closeSession",
    ]),
    tenant_guard(method, args) {
      if (["putRegistration", "openSession", "heartbeat", "closeSession"].includes(method)) {
        assertTenant(inputTenant(args[0]), tenantId);
      }
    },
  });
}

export function createSqliteEndpointInboxStore(
  session: SqliteSession,
  tenantId: string,
): EndpointInboxStore {
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "endpoint-inbox",
    target: new MemoryEndpointInboxStore(),
    mutations: new Set(["upsertRoutingFact", "clearPartitionProjection", "clearTenantProjection"]),
    tenant_guard(method, args) {
      assertTenant(
        method === "upsertRoutingFact"
          ? (args[0] as { tenant_id?: unknown } | undefined)?.tenant_id
          : method === "clearTenantProjection" || method === "clearPartitionProjection"
            ? args[0]
            : (args[0] as { tenant_id?: unknown } | undefined)?.tenant_id,
        tenantId,
      );
    },
  });
}
