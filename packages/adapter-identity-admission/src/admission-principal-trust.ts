import type { ResolvedPrincipal } from "@work-fabric/exchange-spi";

const trustedPrincipals = new WeakMap<AdmissionPrincipalTrust, WeakSet<ResolvedPrincipal>>();

export class AdmissionPrincipalTrust {
  constructor() {
    trustedPrincipals.set(this, new WeakSet());
  }

  isTrusted(principal: ResolvedPrincipal): boolean {
    return trustedPrincipals.get(this)?.has(principal) === true;
  }
}

export function markAdmissionPrincipalTrusted(
  trust: AdmissionPrincipalTrust,
  principal: ResolvedPrincipal,
): void {
  const principals = trustedPrincipals.get(trust);
  if (principals === undefined) throw new TypeError("Invalid admission principal trust");
  principals.add(principal);
}
