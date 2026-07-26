import { verifyAgentRuntimeStateStoreContract } from "@work-fabric/agent-runtime-conformance";
import { MemoryAgentRuntimeStateStore } from "../src/index.js";

verifyAgentRuntimeStateStoreContract("memory Agent Runtime state", async () => {
  const store = new MemoryAgentRuntimeStateStore();
  return { store, close: () => store.close() };
});
