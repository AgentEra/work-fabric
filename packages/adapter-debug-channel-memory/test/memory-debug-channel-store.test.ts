import { describe } from "vitest";
import { runDebugChannelStoreContract } from "../../debug-channel-spi/test/store-contract.js";
import { MemoryDebugChannelStore } from "../src/index.js";

describe("MemoryDebugChannelStore", () => {
  runDebugChannelStoreContract({
    async create() {
      return {
        store: new MemoryDebugChannelStore(),
        async close() {},
      };
    },
  });
});
