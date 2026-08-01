import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
  type MemoryDiscoveryStoreOptions,
} from "@work-fabric/adapter-discovery-memory";
import type {
  DiscoveryPeerBindingStore,
  DiscoveryScope,
  DiscoveryStore,
} from "@work-fabric/discovery-spi";

import { createSqliteDurableAdapter } from "./sqlite-durable-adapter.js";
import type { SqliteSession } from "./sqlite-session.js";

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

function guardScope(value: unknown, tenantId: string, tenantViewId: string): void {
  const scope = value as Partial<DiscoveryScope> | undefined;
  if (scope?.tenant_id !== tenantId) throw new Error("tenant context mismatch");
  if (scope.tenant_view_id !== tenantViewId) throw new Error("tenant view context mismatch");
}

export function createSqliteDiscoveryStore(
  session: SqliteSession,
  tenantId: string,
  tenantViewId: string,
  options: MemoryDiscoveryStoreOptions,
): DiscoveryStore {
  identity(tenantId, "tenant_id");
  identity(tenantViewId, "tenant_view_id");
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: `discovery-records:${tenantViewId}`,
    target: new MemoryDiscoveryStore(options),
    mutations: new Set(["apply", "prune"]),
    tenant_guard(_method, args) {
      guardScope(args[0], tenantId, tenantViewId);
    },
  });
}

export function createSqliteDiscoveryPeerBindingStore(
  session: SqliteSession,
  tenantId: string,
  tenantViewId: string,
): DiscoveryPeerBindingStore {
  identity(tenantId, "tenant_id");
  identity(tenantViewId, "tenant_view_id");
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: `discovery-peers:${tenantViewId}`,
    target: new MemoryDiscoveryPeerBindingStore(),
    mutations: new Set(["put"]),
    tenant_guard(method, args) {
      const scoped = method === "put"
        ? (args[0] as { readonly binding?: unknown } | undefined)?.binding
        : args[0];
      guardScope(scoped, tenantId, tenantViewId);
    },
  });
}
