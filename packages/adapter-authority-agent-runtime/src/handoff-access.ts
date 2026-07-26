import type { HandoffReadModelStore } from "@work-fabric/exchange-spi";

/** The public projection store surface used for tenant-checked Handoff lookups. */
export type AgentRuntimeHandoffAccess = Pick<HandoffReadModelStore, "getHandoff">;
