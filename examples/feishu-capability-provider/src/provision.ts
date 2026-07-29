import {
  enabledFeishuProviderFacets,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
  feishuDocumentCapabilityDeclarations,
  feishuMessageCapabilityDeclarations,
  type FeishuProviderCitizenConfig,
} from "@work-fabric/provider-feishu";
import type {
  CitizenDeclaration,
  CitizenProvisioning,
} from "@work-fabric/network-citizen-spi";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type EndpointRegistration,
} from "@work-fabric/sdk-typescript";

import {
  loadFeishuProviderConfiguration,
  type FeishuProviderParticipant,
} from "./configuration.js";

type MinimalDeclaration = Pick<CitizenDeclaration, "declaration_id" | "risk">;

export interface FeishuProviderProvisioningPorts {
  readonly endpoints: {
    provision(
      endpointId: string,
      input: EndpointRegistration,
    ): Promise<unknown>;
  };
  readonly citizens: {
    provision(
      citizenId: string,
      input: CitizenProvisioning,
    ): Promise<unknown>;
  };
}

function maximumRisk(
  declarations: readonly MinimalDeclaration[],
): CitizenProvisioning["maximum_risk"] {
  const order = ["low", "medium", "high", "destructive"] as const;
  return order.reduce((maximum, candidate) =>
    declarations.some((item) => item.risk === candidate)
      ? candidate
      : maximum, "low" as CitizenProvisioning["maximum_risk"]);
}

function citizen(
  config: FeishuProviderCitizenConfig,
  kind: CitizenProvisioning["citizen_kind"],
  declarations: readonly MinimalDeclaration[],
): CitizenProvisioning {
  return {
    citizen_id: config.citizen_id,
    citizen_kind: kind,
    principal_id: config.principal_id,
    allowed_actor: {
      actor_id: config.actor_id,
      actor_type: "agent",
    },
    allowed_endpoint_id: config.endpoint_id,
    allowed_declaration_namespaces: ["feishu"],
    maximum_risk: maximumRisk(declarations),
    administrative_state: "enabled",
    registration_version: config.registration_version,
  };
}

export async function provisionFeishuProviderRecords(
  input: FeishuProviderProvisioningPorts & {
    readonly participant: FeishuProviderParticipant;
    readonly capability_facets: readonly {
      readonly citizen: FeishuProviderCitizenConfig;
      readonly declarations: readonly MinimalDeclaration[];
    }[];
    readonly context_citizen: FeishuProviderCitizenConfig;
    readonly context_declarations: readonly MinimalDeclaration[];
  },
): Promise<void> {
  if (input.capability_facets.length === 0) {
    throw new TypeError("at least one capability facet is required");
  }
  const capabilityIds = input.capability_facets
    .flatMap((facet) => facet.declarations)
    .map((item) => item.declaration_id)
    .sort();
  const registration: EndpointRegistration = {
    endpoint_id: input.participant.endpoint_id,
    actor: {
      actor_id: input.participant.actor_id,
      actor_type: input.participant.actor_type,
    },
    endpoint_type: "workfabric.dev/capability_provider",
    display_name: "Feishu Capability Provider",
    protocol_versions: ["1.0"],
    bindings: [{
      binding_type: "local_process",
      uri: "urn:work-fabric:provider:feishu",
      security_schemes: ["bearer"],
      extensions: {},
    }],
    allowed_capability_ids: capabilityIds,
    limits: {
      max_inline_content_bytes: 262_144,
      max_concurrent_handoffs: 8,
    },
    administrative_state: "enabled",
    registration_version: 1,
  };
  await input.endpoints.provision(input.participant.endpoint_id, registration);
  for (const facet of input.capability_facets) {
    await input.citizens.provision(
      facet.citizen.citizen_id,
      citizen(
        facet.citizen,
        "capability-provider",
        facet.declarations,
      ),
    );
  }
  await input.citizens.provision(
    input.context_citizen.citizen_id,
    citizen(
      input.context_citizen,
      "context-provider",
      input.context_declarations,
    ),
  );
}

export async function provisionFeishuProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const loaded = await loadFeishuProviderConfiguration({ environment });
  const adminToken = environment.WORK_FABRIC_ADMIN_TOKEN;
  if (adminToken === undefined || adminToken.length === 0) {
    throw new Error("WORK_FABRIC_ADMIN_TOKEN is required");
  }
  const client = new WorkFabricClient({
    baseUrl: loaded.service.work_fabric.base_url,
    tenantId: loaded.service.work_fabric.tenant_id,
    exchangeId: loaded.service.work_fabric.exchange_id,
    representation: {
      actorId: "actor-work-fabric-admin",
      endpointId: "endpoint-work-fabric-admin",
    },
    authentication: new BearerTokenProvider(adminToken),
  });
  await provisionFeishuProviderRecords({
    endpoints: client.endpoints,
    citizens: client.citizens,
    participant: loaded.participant,
    capability_facets: enabledFeishuProviderFacets(loaded.provider).map(
      (facet) => ({
        citizen: facet.citizen,
        declarations: facet.facet === "message"
          ? feishuMessageCapabilityDeclarations()
          : facet.facet === "document"
            ? feishuDocumentCapabilityDeclarations()
            : feishuCapabilityDeclarations(),
      }),
    ),
    context_citizen: loaded.provider.context_citizen,
    context_declarations: feishuContextDeclarations(),
  });
  console.log(
    `Feishu Provider provisioned: ${loaded.participant.endpoint_id}`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void provisionFeishuProvider().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Provider provisioning failed",
    );
    process.exitCode = 1;
  });
}
