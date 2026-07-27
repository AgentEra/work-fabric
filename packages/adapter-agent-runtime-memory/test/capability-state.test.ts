import { verifyCapabilityInvocationStoreContract } from "@work-fabric/agent-runtime-conformance";

import { MemoryAgentRuntimeStateStore } from "../src/index.js";

verifyCapabilityInvocationStoreContract(
  "memory Agent capability invocation state",
  async () => {
    const store = new MemoryAgentRuntimeStateStore();
    return { store, close: () => store.close() };
  },
);
