import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import type { ContextRepository } from "@work-fabric/exchange-spi";

import { createSqliteDurableAdapter } from "./sqlite-durable-adapter.js";
import type { SqliteSession } from "./sqlite-session.js";

function tenant(value: unknown, expected: string): void {
  if (value !== expected) throw new Error("tenant context mismatch");
}

export function createSqliteContextStore(
  session: SqliteSession,
  tenantId: string,
): ContextRepository {
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "context",
    target: new MemoryContextRepository(),
    mutations: new Set(["putBundle"]),
    tenant_guard(method, args) {
      tenant(
        method === "putBundle"
          ? args[0]
          : (args[0] as { tenant_id?: unknown } | undefined)?.tenant_id,
        tenantId,
      );
    },
  });
}
