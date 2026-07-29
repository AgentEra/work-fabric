import type {
  CapabilityCandidate,
  CapabilityInvocationRequest,
  CapabilityRequirement,
  CapabilityOperationKind,
  RuntimeJsonObject,
} from "@work-fabric/agent-runtime-spi";
import type {
  CitizenCardPage,
  CitizenDeclarationContract,
  CitizenDeclarationSummaryPage,
  CitizenRisk,
  CitizenSchemaReference,
} from "@work-fabric/network-citizen-spi";
import type {
  CitizenDiscoveryInput,
  HandoffOfferPayload,
  HandoffReadModel,
  HandoffTargetResolutionPayload,
  ExistingHandoffCommandOptions,
  NewCommandOptions,
  OperationResult,
  RequestOptions,
} from "@work-fabric/sdk-typescript";

export interface CapabilityCatalogClient {
  list(
    input: CitizenDiscoveryInput,
    options?: RequestOptions,
  ): Promise<CitizenCardPage>;
  getDeclaration(
    citizenId: string,
    declarationId: string,
    options?: RequestOptions,
  ): Promise<CitizenDeclarationContract>;
}

export interface CapabilityDisclosureCatalogClient {
  list(
    input: CitizenDiscoveryInput,
    options?: RequestOptions,
  ): Promise<CitizenCardPage>;
  listDeclarations(
    citizenId: string,
    options?: RequestOptions,
  ): Promise<CitizenDeclarationSummaryPage>;
  getDeclaration(
    citizenId: string,
    declarationId: string,
    options?: RequestOptions,
  ): Promise<CitizenDeclarationContract>;
}

export interface BoundCapabilityContract {
  readonly candidate: CapabilityCandidate;
  readonly input_schema?: CitizenSchemaReference;
  readonly output_schema?: CitizenSchemaReference;
  readonly confirmation: "none" | "explicit";
  readonly risk: CitizenRisk;
  readonly operation_kind: CapabilityOperationKind;
}

export interface CapabilityContractResolver {
  discover(
    requirement: CapabilityRequirement,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]>;
  getBoundContract(
    candidate: CapabilityCandidate,
    signal?: AbortSignal,
  ): Promise<BoundCapabilityContract>;
}

export interface NormalizedInvocationAuthorityRequest {
  readonly tenant_id: string;
  readonly request: CapabilityInvocationRequest;
  readonly candidate: CapabilityCandidate;
  readonly contract: BoundCapabilityContract;
  readonly work_reference_uri: string;
}

export interface InvocationAuthorityProvider {
  authorize(
    input: NormalizedInvocationAuthorityRequest,
    signal: AbortSignal,
  ): Promise<RuntimeJsonObject>;
}

export interface InvocationSchemaValidator {
  validateInput(
    contract: BoundCapabilityContract,
    input: RuntimeJsonObject,
    signal: AbortSignal,
  ): Promise<void>;
  validateOutput(
    contract: BoundCapabilityContract,
    data: RuntimeJsonObject,
    artifacts: readonly RuntimeJsonObject[],
    signal: AbortSignal,
  ): Promise<{
    readonly data: RuntimeJsonObject;
    readonly artifacts: readonly RuntimeJsonObject[];
  }>;
}

export interface InvocationSchemaRegistry {
  load(
    reference: CitizenSchemaReference,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export type AuxiliaryHandoffTerminal =
  | {
      readonly outcome: "succeeded";
      readonly data: RuntimeJsonObject;
      readonly artifacts: readonly RuntimeJsonObject[];
    }
  | {
      readonly outcome: "rejected" | "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface BoundAuxiliaryHandoff {
  readonly tenant_id: string;
  readonly original_handoff_id: string;
  readonly auxiliary_handoff_id: string;
  readonly invocation_id: string;
  readonly candidate: CapabilityCandidate;
  readonly contract: BoundCapabilityContract;
  readonly deadline: string;
}

export interface AuxiliaryHandoffWaiter {
  wait(
    input: BoundAuxiliaryHandoff,
    signal: AbortSignal,
  ): Promise<AuxiliaryHandoffTerminal>;
}

export interface CapabilityHandoffClient {
  offer(
    payload: HandoffOfferPayload,
    options: NewCommandOptions,
  ): Promise<OperationResult>;
  resolveTarget(
    payload: HandoffTargetResolutionPayload,
    options: ExistingHandoffCommandOptions,
  ): Promise<OperationResult>;
  getHandoff(
    handoffId: string,
    options?: RequestOptions,
  ): Promise<HandoffReadModel>;
}
