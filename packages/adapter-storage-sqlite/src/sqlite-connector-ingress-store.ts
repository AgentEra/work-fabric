import {
  MemoryConnectorIngressStore,
  type MemoryConnectorIngressStoreOptions,
} from "@work-fabric/adapter-connector-memory";
import type { ConnectorIngressStore } from "@work-fabric/connector-spi";

import { createSqliteDurableAdapter } from "./sqlite-durable-adapter.js";
import type { SqliteSession } from "./sqlite-session.js";

export function createSqliteConnectorIngressStore(
  session: SqliteSession,
  tenantId: string,
  options: MemoryConnectorIngressStoreOptions = {},
): ConnectorIngressStore {
  let ingressSequence = 0;
  let claimSequence = 0;
  const stableOptions: MemoryConnectorIngressStoreOptions = {
    id_factory: () => `sqlite_ingress_${++ingressSequence}`,
    claim_token_factory: () => `sqlite_claim_${++claimSequence}`,
    ...options,
  };
  return createSqliteDurableAdapter({
    session,
    tenant_id: tenantId,
    store_kind: "connector-ingress",
    target: new MemoryConnectorIngressStore(stableOptions),
    mutations: new Set([
      "accept",
      "claim",
      "complete",
      "renew",
      "retry",
      "deadLetter",
      "requeue",
    ]),
    tenant_guard(_method, args) {
      const actual = (args[0] as { tenant_id?: unknown } | undefined)?.tenant_id;
      if (actual !== tenantId) throw new Error("tenant context mismatch");
    },
  });
}
