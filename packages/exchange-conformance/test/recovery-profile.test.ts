import { describe, expect, it } from "vitest";
import { MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { verifyRecoveryStoreProfile } from "../src/index.js";

describe("verifyRecoveryStoreProfile", () => {
  it("accepts a fenced tenant-isolated recovery store", async () => {
    const store = new MemoryRecoveryStore();
    await expect(verifyRecoveryStoreProfile(() => store)).resolves.toBeUndefined();
  });
});
