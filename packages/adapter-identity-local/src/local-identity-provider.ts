import { isDeepStrictEqual } from "node:util";

import type {
  CapabilityManifest,
  IdentityProvider,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

export interface LocalIdentityRecord {
  readonly authentication_evidence: JsonObject;
  readonly principal: ResolvedPrincipal;
}

const manifest: CapabilityManifest = {
  profile: "exchange.identity.v1",
  adapter: "local",
  capabilities: {
    authenticated_principal: true,
    trusted_actor_claims: true,
    tenant_binding: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LocalIdentityProvider implements IdentityProvider {
  private readonly records: readonly LocalIdentityRecord[];

  constructor(records: readonly LocalIdentityRecord[]) {
    this.records = clone(records);
  }

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async resolve(
    authenticationEvidence: JsonObject,
  ): Promise<ResolvedPrincipal | null> {
    const evidence = clone(authenticationEvidence);
    const record = this.records.find((candidate) =>
      isDeepStrictEqual(candidate.authentication_evidence, evidence),
    );
    return record === undefined ? null : clone(record.principal);
  }
}
