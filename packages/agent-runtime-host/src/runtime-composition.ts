import type { AgentRuntimeDriver, AgentRuntimeStateStore } from "@work-fabric/agent-runtime-spi";
import type { AgentEndpointSession } from "@work-fabric/agent-gateway";

import { AgentRuntimeHost, type AgentRuntimeHostDependencies } from "./runtime-host.js";

/** Keeps runtime wiring provider-neutral; Driver-specific configuration stays outside the Host. */
export function composeAgentRuntimeHost(
  dependencies: AgentRuntimeHostDependencies & {
    readonly state: AgentRuntimeStateStore;
    readonly driver: AgentRuntimeDriver;
    readonly session?: AgentEndpointSession;
  },
): AgentRuntimeHost {
  return new AgentRuntimeHost(dependencies);
}
