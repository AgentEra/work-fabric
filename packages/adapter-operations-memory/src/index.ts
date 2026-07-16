export * from "./memory-audit-store.js";
export * from "./memory-collaboration-store.js";
export * from "./memory-discrepancy-store.js";

import { MemoryAuditStore } from "./memory-audit-store.js";
import { MemoryCollaborationViewStore } from "./memory-collaboration-store.js";

export class MemoryOperationsFixture {
  readonly collaboration: MemoryCollaborationViewStore;
  readonly audit: MemoryAuditStore;

  constructor(cursorSecret = "memory-operations-fixture-secret") {
    this.collaboration = new MemoryCollaborationViewStore({
      cursor_secret: cursorSecret,
    });
    this.audit = new MemoryAuditStore({ cursor_secret: cursorSecret });
  }
}
