import type {
  CapabilityManifest,
  IdentityProvider,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.identity.v1",
  adapter: "composite",
  capabilities: {
    authenticated_principal: true,
    trusted_actor_claims: true,
    tenant_binding: true,
  },
};

export class CompositeIdentityProvider implements IdentityProvider {
  private readonly providers: readonly IdentityProvider[];

  constructor(providers: readonly IdentityProvider[]) {
    const manifests = new Set<string>();
    for (const provider of providers) {
      const providerManifest = provider.manifest;
      const key = JSON.stringify([providerManifest.profile, providerManifest.adapter]);
      if (manifests.has(key)) {
        throw new TypeError("Duplicate Identity Provider manifest");
      }
      manifests.add(key);
    }
    this.providers = [...providers];
  }

  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async resolve(authenticationEvidence: JsonObject): Promise<ResolvedPrincipal | null> {
    for (const provider of this.providers) {
      const principal = await provider.resolve(authenticationEvidence);
      if (principal !== null) return principal;
    }
    return null;
  }
}
