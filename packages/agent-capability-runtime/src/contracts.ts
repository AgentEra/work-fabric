import type {
  CitizenCardPage,
  CitizenDeclarationContract,
} from "@work-fabric/network-citizen-spi";
import type {
  CitizenDiscoveryInput,
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
