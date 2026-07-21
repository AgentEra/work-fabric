import type {
  CapabilityManifest,
  IdentityProvider,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import type { RepresentationGrantVerifier } from "@work-fabric/admission-spi";

import {
  AdmissionPrincipalTrust,
  markAdmissionPrincipalTrusted,
} from "./admission-principal-trust.js";

const manifest: CapabilityManifest = {
  profile: "exchange.identity.v1",
  adapter: "admission",
  capabilities: {
    authenticated_principal: true,
    trusted_actor_claims: true,
    tenant_binding: true,
  },
};

export interface AdmissionIdentityProviderOptions {
  readonly grants: RepresentationGrantVerifier;
  readonly trust: AdmissionPrincipalTrust;
  readonly clock: { now(): string };
}

function bearerToken(evidence: JsonObject): string | null {
  try {
    const keys = Reflect.ownKeys(evidence);
    if (keys.length !== 1 || keys[0] !== "bearer_token") return null;
    const descriptor = Object.getOwnPropertyDescriptor(evidence, "bearer_token");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function admissionPrincipal(input: NonNullable<Awaited<ReturnType<RepresentationGrantVerifier["verify"]>>>): ResolvedPrincipal {
  const endpointIds = Object.freeze([input.endpoint_id]);
  const claim = Object.freeze({
    actor_id: input.actor_id,
    actor_type: input.actor_type,
    endpoint_ids: endpointIds,
  });
  const actorClaims = Object.freeze([claim]);
  const attributes = Object.freeze({
    "workfabric.dev/identity_kind": "admission",
    "workfabric.dev/connector_id": input.connector_id,
    "workfabric.dev/ingress_id": input.ingress_id,
    "workfabric.dev/idempotency_key": input.idempotency_key,
    "workfabric.dev/decision_id": input.decision_id,
  });
  return Object.freeze({
    principal_id: `admission:${input.connector_id}`,
    tenant_id: input.tenant_id,
    actor_claims: actorClaims,
    attributes,
  });
}

export class AdmissionIdentityProvider implements IdentityProvider {
  constructor(private readonly options: AdmissionIdentityProviderOptions) {}

  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async resolve(authenticationEvidence: JsonObject): Promise<ResolvedPrincipal | null> {
    const grant = bearerToken(authenticationEvidence);
    if (grant === null) return null;
    const verified = await this.options.grants.verify(grant, this.options.clock.now());
    if (verified === null) return null;
    const principal = admissionPrincipal(verified);
    markAdmissionPrincipalTrusted(this.options.trust, principal);
    return principal;
  }
}
