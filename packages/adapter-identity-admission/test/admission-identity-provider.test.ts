import { describe, expect, it, vi } from "vitest";

import type {
  IdentityProvider,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import type { RepresentationGrantVerifier } from "@work-fabric/admission-spi";

import {
  AdmissionIdentityProvider,
  AdmissionPrincipalTrust,
  CompositeIdentityProvider,
} from "../src/index.js";

const NOW = "2026-07-20T00:00:00.000Z";
const verified = {
  tenant_id: "tenant-a",
  connector_id: "connector-a",
  ingress_id: "ingress-a",
  decision_id: "decision-a",
  actor_id: "actor-a",
  actor_type: "human" as const,
  endpoint_id: "endpoint-a",
  external_subject_fingerprint: "afp_private",
  expires_at: "2026-07-20T00:01:00Z",
};

function verifier(result: typeof verified | null = verified): RepresentationGrantVerifier {
  return { verify: vi.fn(async () => result) };
}

function manifestProvider(
  adapter: string,
  resolve: (evidence: JsonObject) => Promise<ResolvedPrincipal | null>,
): IdentityProvider {
  return {
    manifest: {
      profile: "exchange.identity.v1",
      adapter,
      capabilities: {
        authenticated_principal: true,
        trusted_actor_claims: true,
        tenant_binding: true,
      },
    },
    resolve,
  };
}

describe("AdmissionIdentityProvider", () => {
  it("passes the injected verifier time and resolves exactly one dynamic Actor claim", async () => {
    const grants = verifier();
    const trust = new AdmissionPrincipalTrust();
    const provider = new AdmissionIdentityProvider({ grants, trust, clock: { now: () => NOW } });
    const principal = await provider.resolve({ bearer_token: "opaque-grant" });

    expect(grants.verify).toHaveBeenCalledWith("opaque-grant", NOW);
    expect(principal).toEqual({
      principal_id: "admission:connector-a",
      tenant_id: "tenant-a",
      actor_claims: [{ actor_id: "actor-a", actor_type: "human", endpoint_ids: ["endpoint-a"] }],
      attributes: {
        "workfabric.dev/identity_kind": "admission",
        "workfabric.dev/connector_id": "connector-a",
        "workfabric.dev/ingress_id": "ingress-a",
        "workfabric.dev/decision_id": "decision-a",
      },
    });
    expect(principal?.actor_claims).toHaveLength(1);
    expect(JSON.stringify(principal)).not.toContain("afp_private");
    expect(JSON.stringify(principal)).not.toContain("opaque-grant");
  });

  it("accepts only an exact own bearer_token string evidence shape", async () => {
    const grants = verifier();
    const provider = new AdmissionIdentityProvider({
      grants,
      trust: new AdmissionPrincipalTrust(),
      clock: { now: () => NOW },
    });
    const inherited = Object.create({ bearer_token: "opaque-grant" }) as JsonObject;
    const getter = Object.defineProperty({}, "bearer_token", { enumerable: true, get: () => { throw new Error("secret payload"); } }) as JsonObject;
    for (const evidence of [
      {}, { bearer_token: "opaque-grant", extra: true }, { bearer_token: 42 }, inherited, getter,
    ] as JsonObject[]) {
      await expect(provider.resolve(evidence)).resolves.toBeNull();
    }
    expect(grants.verify).not.toHaveBeenCalled();

    await expect(provider.resolve({ bearer_token: "opaque-grant" })).resolves.not.toBeNull();
    expect(grants.verify).toHaveBeenCalledOnce();
  });

  it("returns null when verification fails", async () => {
    const provider = new AdmissionIdentityProvider({
      grants: verifier(null),
      trust: new AdmissionPrincipalTrust(),
      clock: { now: () => NOW },
    });
    await expect(provider.resolve({ bearer_token: "invalid" })).resolves.toBeNull();
  });

  it("deep-freezes and trusts only the exact returned principal object", async () => {
    const trust = new AdmissionPrincipalTrust();
    const provider = new AdmissionIdentityProvider({ grants: verifier(), trust, clock: { now: () => NOW } });
    const principal = await provider.resolve({ bearer_token: "opaque-grant" });
    expect(principal).not.toBeNull();
    if (principal === null) throw new Error("expected admission principal");

    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.actor_claims)).toBe(true);
    expect(Object.isFrozen(principal.actor_claims[0])).toBe(true);
    expect(Object.isFrozen(principal.actor_claims[0]!.endpoint_ids)).toBe(true);
    expect(Object.isFrozen(principal.attributes)).toBe(true);
    expect(trust.isTrusted(principal)).toBe(true);
    expect(trust.isTrusted(structuredClone(principal))).toBe(false);
    expect(trust.isTrusted({ ...principal })).toBe(false);
    expect(() => (principal.actor_claims[0]!.endpoint_ids as string[]).push("forged")).toThrow();
  });
});

describe("CompositeIdentityProvider", () => {
  it("tries providers in order, falls back, and preserves returned object identity", async () => {
    const principal: ResolvedPrincipal = {
      principal_id: "local-principal",
      tenant_id: "tenant-a",
      actor_claims: [],
      attributes: {},
    };
    const first = manifestProvider("first", vi.fn(async () => null));
    const secondResolve = vi.fn(async () => principal);
    const second = manifestProvider("second", secondResolve);
    const thirdResolve = vi.fn(async () => null);
    const composite = new CompositeIdentityProvider([first, second, manifestProvider("third", thirdResolve)]);

    const resolved = await composite.resolve({ bearer_token: "local" });
    expect(resolved).toBe(principal);
    expect(first.resolve).toHaveBeenCalledOnce();
    expect(secondResolve).toHaveBeenCalledOnce();
    expect(thirdResolve).not.toHaveBeenCalled();
  });

  it("propagates provider errors and stops fallback", async () => {
    const fallback = manifestProvider("fallback", vi.fn(async () => null));
    const composite = new CompositeIdentityProvider([
      manifestProvider("throws", async () => { throw new Error("provider failed"); }),
      fallback,
    ]);

    await expect(composite.resolve({ bearer_token: "token" })).rejects.toThrow("provider failed");
    expect(fallback.resolve).not.toHaveBeenCalled();
  });

  it("rejects duplicate profile and adapter manifests", () => {
    const first = manifestProvider("same", async () => null);
    const duplicate = manifestProvider("same", async () => null);
    (duplicate.manifest.capabilities as Record<string, boolean>).extra = true;

    expect(() => new CompositeIdentityProvider([first, duplicate])).toThrow(TypeError);
  });
});
