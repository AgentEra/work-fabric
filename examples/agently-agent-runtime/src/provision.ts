import { BearerTokenProvider, WorkFabricClient } from "@work-fabric/sdk-typescript";
import { loadAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";

import { dailyAssistantEndpointRegistration } from "./subscription.js";

export async function provisionDailyAssistant(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const adminToken = environment.WORK_FABRIC_ADMIN_TOKEN;
  if (adminToken === undefined || adminToken.length === 0) throw new Error("WORK_FABRIC_ADMIN_TOKEN is required for endpoint provisioning");
  const loaded = await loadAgentRuntimeConfiguration({ environment });
  const registration = {
    ...dailyAssistantEndpointRegistration(),
    endpoint_id: loaded.participant.endpoint_id,
    actor: {
      actor_id: loaded.participant.actor_id,
      actor_type: loaded.participant.actor_type,
    },
    limits: { max_inline_content_bytes: 262_144, max_concurrent_handoffs: loaded.service.concurrency.max_active_runs },
  };
  const client = new WorkFabricClient({
    baseUrl: loaded.service.work_fabric.base_url, tenantId: loaded.service.work_fabric.tenant_id, exchangeId: loaded.service.work_fabric.exchange_id,
    representation: { actorId: "actor-work-fabric-admin", endpointId: "endpoint-work-fabric-admin" },
    authentication: new BearerTokenProvider(adminToken),
  });
  await client.endpoints.provision(loaded.participant.endpoint_id, registration);
  console.log(`Endpoint provisioned: ${loaded.participant.endpoint_id}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void provisionDailyAssistant().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Endpoint provisioning failed");
    process.exitCode = 1;
  });
}
