import {
  BearerTokenProvider,
  WorkFabricClient,
} from "@work-fabric/sdk-typescript";
import type { ConsoleRuntimeConfig } from "./config.js";

export function createConsoleClient(config: ConsoleRuntimeConfig): WorkFabricClient {
  const authentication = window.__WORK_FABRIC_AUTH__;
  if (authentication === undefined) {
    throw new Error("Console authentication integration is not installed");
  }
  return new WorkFabricClient({
    baseUrl: config.baseUrl,
    tenantId: config.tenantId,
    exchangeId: config.exchangeId,
    authentication: new BearerTokenProvider(authentication),
    representation: { actorId: config.actorId, endpointId: config.endpointId },
  });
}
