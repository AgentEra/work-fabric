import { githubReadCapabilityDeclarations } from "@work-fabric/provider-github";
import type { CitizenProvisioning } from "@work-fabric/network-citizen-spi";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type EndpointRegistration,
} from "@work-fabric/sdk-typescript";

import {
  loadGitHubProviderConfiguration,
  type GitHubProviderCitizenConfiguration,
} from "./configuration.js";

export interface GitHubProviderProvisioningPorts {
  readonly endpoints: {
    provision(endpointId: string, input: EndpointRegistration): Promise<EndpointRegistration>;
  };
  readonly citizens: {
    provision(citizenId: string, input: CitizenProvisioning): Promise<unknown>;
  };
}

export async function provisionGitHubProviderRecords(
  input: GitHubProviderProvisioningPorts & {
    readonly citizen: GitHubProviderCitizenConfiguration;
  },
): Promise<void> {
  const capabilityIds = githubReadCapabilityDeclarations().map((item) => item.declaration_id);
  const registration: EndpointRegistration = {
    endpoint_id: input.citizen.endpoint_id,
    actor: { actor_id: input.citizen.actor_id, actor_type: "system" },
    endpoint_type: "workfabric.dev/capability_provider",
    display_name: "GitHub Capability Provider",
    protocol_versions: ["1.0"],
    bindings: [{
      binding_type: "local_process",
      uri: "urn:work-fabric:provider:github",
      security_schemes: ["bearer"],
      extensions: {},
    }],
    allowed_capability_ids: capabilityIds,
    limits: { max_inline_content_bytes: 262_144, max_concurrent_handoffs: 8 },
    administrative_state: "enabled",
    registration_version: input.citizen.registration_version,
  };
  await input.endpoints.provision(input.citizen.endpoint_id, registration);
  await input.citizens.provision(input.citizen.citizen_id, {
    citizen_id: input.citizen.citizen_id,
    citizen_kind: "capability-provider",
    principal_id: input.citizen.principal_id,
    allowed_actor: { actor_id: input.citizen.actor_id, actor_type: "system" },
    allowed_endpoint_id: input.citizen.endpoint_id,
    allowed_declaration_namespaces: ["github"],
    maximum_risk: "low",
    administrative_state: "enabled",
    registration_version: input.citizen.registration_version,
  });
}

export async function provisionGitHubProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const loaded = await loadGitHubProviderConfiguration({ environment });
  const adminToken = environment.WORK_FABRIC_ADMIN_TOKEN;
  if (adminToken === undefined || adminToken.length === 0) {
    throw new Error("WORK_FABRIC_ADMIN_TOKEN is required");
  }
  const client = new WorkFabricClient({
    baseUrl: loaded.service.work_fabric.base_url,
    tenantId: loaded.service.work_fabric.tenant_id,
    exchangeId: loaded.service.work_fabric.exchange_id,
    representation: { actorId: "actor-work-fabric-admin", endpointId: "endpoint-work-fabric-admin" },
    authentication: new BearerTokenProvider(adminToken),
  });
  await provisionGitHubProviderRecords({
    endpoints: client.endpoints,
    citizens: client.citizens,
    citizen: loaded.provider.citizen,
  });
}
