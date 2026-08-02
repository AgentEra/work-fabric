import { LeasedNetworkCitizenRuntime } from "@work-fabric/network-citizen-runtime";
import {
  canonicalCitizenDigest,
  type CapabilityExecutor,
  type CapabilityProviderRuntimePort,
  type CitizenDeclaration,
  type NetworkCitizenDescriptor,
} from "@work-fabric/network-citizen-spi";

export interface GitHubCapabilityCitizenRuntimeOptions {
  readonly citizen_id: string;
  readonly client_session_id: string;
  readonly expected_registration_version: number;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly executor: CapabilityExecutor;
  readonly version?: string;
}

/** Independently leased read-only GitHub Capability Provider Citizen. */
export class GitHubCapabilityCitizenRuntime
  extends LeasedNetworkCitizenRuntime
  implements CapabilityProviderRuntimePort {
  readonly citizen_kind = "capability-provider" as const;
  readonly executor: CapabilityExecutor;

  constructor(private readonly runtimeOptions: GitHubCapabilityCitizenRuntimeOptions) {
    super(runtimeOptions);
    this.executor = runtimeOptions.executor;
  }

  protected currentDescriptor(): NetworkCitizenDescriptor {
    const declarations = this.currentDeclarations();
    return {
      citizen_id: this.runtimeOptions.citizen_id,
      citizen_kind: this.citizen_kind,
      version: this.runtimeOptions.version ?? "1.0.0",
      identity: {
        principal_id: this.runtimeOptions.principal_id,
        actor: {
          actor_id: this.runtimeOptions.actor_id,
          actor_type: "system",
        },
        endpoint_id: this.runtimeOptions.endpoint_id,
      },
      protocol: {
        versions: ["1"],
        bindings: ["workfabric+https"],
      },
      declarations: {
        count: declarations.length,
        digest: canonicalCitizenDigest(declarations),
      },
      availability: "available",
      extensions: {
        "workfabric.dev/provider_family": "github",
        "workfabric.dev/declaration_source": "runtime",
        "workfabric.dev/mutation_support": "none",
      },
    };
  }

  protected currentDeclarations(): readonly CitizenDeclaration[] {
    return this.executor.describeCapabilities();
  }
}
