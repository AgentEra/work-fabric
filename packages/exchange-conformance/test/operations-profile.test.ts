import { describe, it } from "vitest";

import {
  MemoryAuditStore,
  MemoryCollaborationViewStore,
} from "@work-fabric/adapter-operations-memory";
import { verifyOperationsStoreProfile } from "../src/operations-profile.js";

describe("operations store conformance", () => {
  it("verifies the Memory reference adapter", async () => {
    await verifyOperationsStoreProfile(() => ({
      collaboration: new MemoryCollaborationViewStore(),
      audit: new MemoryAuditStore(),
    }));
  });
});
