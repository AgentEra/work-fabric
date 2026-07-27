import { LeasedNetworkCitizenRuntime } from "@work-fabric/network-citizen-runtime";
import {
  canonicalCitizenDigest,
  type CapabilityExecutionContext,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type CapabilityExecutor,
  type CapabilityProviderRuntimePort,
  type CitizenDeclaration,
  type CitizenJsonObject,
  type ContextProviderRuntimePort,
  type NetworkCitizenDescriptor,
} from "@work-fabric/network-citizen-spi";

interface FeishuCitizenIdentityOptions {
  readonly citizen_id: string;
  readonly client_session_id: string;
  readonly expected_registration_version: number;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly actor_type: "agent" | "system";
  readonly endpoint_id: string;
  readonly version?: string;
}

export interface FeishuCapabilityCitizenRuntimeOptions
  extends FeishuCitizenIdentityOptions {
  readonly declarations: () => readonly CitizenDeclaration[];
  readonly execute: (
    request: CapabilityExecutionRequest,
    context: CapabilityExecutionContext,
  ) => Promise<CapabilityExecutionResult>;
}

export interface FeishuContextCitizenRuntimeOptions
  extends FeishuCitizenIdentityOptions {
  readonly declarations: () => readonly CitizenDeclaration[];
  readonly resolve: (
    request: CitizenJsonObject,
    signal: AbortSignal,
  ) => Promise<CitizenJsonObject>;
}

function descriptor(
  options: FeishuCitizenIdentityOptions,
  citizenKind: "capability-provider" | "context-provider",
  declarations: readonly CitizenDeclaration[],
): NetworkCitizenDescriptor {
  return {
    citizen_id: options.citizen_id,
    citizen_kind: citizenKind,
    version: options.version ?? "1.0.0",
    identity: {
      principal_id: options.principal_id,
      actor: {
        actor_id: options.actor_id,
        actor_type: options.actor_type,
      },
      endpoint_id: options.endpoint_id,
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
      provider_family: "feishu",
      declaration_source: "runtime",
    },
  };
}

export class FeishuCapabilityCitizenRuntime
  extends LeasedNetworkCitizenRuntime
  implements CapabilityProviderRuntimePort {
  readonly citizen_kind = "capability-provider" as const;
  readonly executor: CapabilityExecutor;

  constructor(private readonly runtimeOptions: FeishuCapabilityCitizenRuntimeOptions) {
    super(runtimeOptions);
    this.executor = {
      describeCapabilities: () => this.currentDeclarations(),
      execute: (request, context) => runtimeOptions.execute(request, context),
    };
  }

  protected currentDescriptor(): NetworkCitizenDescriptor {
    return descriptor(
      this.runtimeOptions,
      this.citizen_kind,
      this.currentDeclarations(),
    );
  }

  protected currentDeclarations(): readonly CitizenDeclaration[] {
    return this.runtimeOptions.declarations();
  }
}

export class FeishuContextCitizenRuntime
  extends LeasedNetworkCitizenRuntime
  implements ContextProviderRuntimePort {
  readonly citizen_kind = "context-provider" as const;

  constructor(private readonly runtimeOptions: FeishuContextCitizenRuntimeOptions) {
    super(runtimeOptions);
  }

  resolve(
    request: CitizenJsonObject,
    signal: AbortSignal,
  ): Promise<CitizenJsonObject> {
    return this.runtimeOptions.resolve(request, signal);
  }

  protected currentDescriptor(): NetworkCitizenDescriptor {
    return descriptor(
      this.runtimeOptions,
      this.citizen_kind,
      this.currentDeclarations(),
    );
  }

  protected currentDeclarations(): readonly CitizenDeclaration[] {
    return this.runtimeOptions.declarations();
  }
}
