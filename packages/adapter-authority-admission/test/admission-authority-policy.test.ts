import { describe, expect, it, vi } from "vitest";

import type { RepresentationGrantVerifier } from "@work-fabric/admission-spi";
import {
  AdmissionIdentityProvider,
  AdmissionPrincipalTrust,
} from "@work-fabric/adapter-identity-admission";
import { markAdmissionPrincipalTrusted } from "../../adapter-identity-admission/src/admission-principal-trust.js";
import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

import {
  AdmissionAuthorityPolicy,
  CompositeAuthorityPolicy,
  type AdmissionAuthorityRule,
} from "../src/index.js";

const NOW = "2026-07-20T00:00:00.000Z";
const OFFER = "workfabric.handoff.offer.v1" as const;
const verified = {
  tenant_id: "tenant-a",
  connector_id: "connector-a",
  ingress_id: "ingress-a",
  idempotency_key: "command-a",
  decision_id: "decision-a",
  actor_id: "actor-a",
  actor_type: "human" as const,
  endpoint_id: "endpoint-a",
  external_subject_fingerprint: "fingerprint-private",
  expires_at: "2026-07-20T00:01:00.000Z",
};

function rule(
  overrides: Partial<AdmissionAuthorityRule> = {},
): AdmissionAuthorityRule {
  return {
    tenant_id: "tenant-a",
    connector_id: "connector-a",
    principal_id: "admission:connector-a",
    action: OFFER,
    ...overrides,
  };
}

async function resolvePrincipal(
  trust: AdmissionPrincipalTrust,
  overrides: Partial<typeof verified> = {},
): Promise<ResolvedPrincipal> {
  const grants: RepresentationGrantVerifier = {
    verify: async () => ({ ...verified, ...overrides }),
  };
  const provider = new AdmissionIdentityProvider({
    grants,
    trust,
    clock: { now: () => NOW },
  });
  const principal = await provider.resolve({ bearer_token: "opaque-grant" });
  if (principal === null) throw new Error("expected a trusted admission principal");
  return principal;
}

function request(
  principal: ResolvedPrincipal,
  overrides: Partial<AuthorityRequest> = {},
): AuthorityRequest {
  return {
    principal,
    actor_id: "actor-a",
    actor_type: "human",
    endpoint_id: "endpoint-a",
    delegation_id: null,
    action: OFFER,
    resource_id: null,
    correlation_id: "ingress-a",
    idempotency_key: "command-a",
    ...overrides,
  } as AuthorityRequest;
}

function authority(
  authorize: AuthorityPolicy["authorize"],
  adapter = "test",
): AuthorityPolicy {
  return {
    manifest: {
      profile: "exchange.authority.v1",
      adapter,
      capabilities: {
        explicit_decision: true,
        default_deny: true,
        resource_scoping: true,
      },
    },
    authorize,
  };
}

describe("AdmissionAuthorityPolicy", () => {
  it("allows only the exact offer represented by one trusted admission principal", async () => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(policy.authorize(request(principal))).resolves.toEqual({ kind: "allow" });
  });

  it.each([
    ["another ingress", { correlation_id: "ingress-b" }],
    ["another command key", { idempotency_key: "command-b" }],
    ["both changed", { correlation_id: "ingress-b", idempotency_key: "command-b" }],
  ] as const)("denies a grant replayed for %s", async (_label, overrides) => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(policy.authorize(request(principal, overrides))).resolves.toMatchObject({
      kind: "deny",
    });
  });

  it.each([
    "workfabric.handoff.accept.v1",
    "workfabric.handoff.report_status.v1",
    "workfabric.handoff.return_result.v1",
    "workfabric.handoff.verify.v1",
    "workfabric.query.handoff.read.v1",
    "workfabric.operations.subscription.list.v1",
    "workfabric.operations.health.read.v1",
  ])("denies non-offer action %s", async (action) => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(policy.authorize(request(principal, { action }))).resolves.toMatchObject({
      kind: "deny",
    });
  });

  it.each([
    ["another tenant", { tenant_id: "tenant-b" }],
    ["another connector", { connector_id: "connector-b" }],
  ] as const)("denies a trusted principal from %s", async (_label, principalOverrides) => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust, principalOverrides);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(policy.authorize(request(principal))).resolves.toMatchObject({ kind: "deny" });
  });

  it.each([
    ["another actor", { actor_id: "actor-b" }],
    ["another actor type", { actor_type: "agent" as const }],
    ["another endpoint", { endpoint_id: "endpoint-b" }],
    ["a delegation", { delegation_id: "delegation-a" }],
    ["a resource", { resource_id: "handoff-a" }],
  ] as const)("denies %s", async (_label, requestOverrides) => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(
      policy.authorize(request(principal, requestOverrides)),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies forged principals that are structurally identical but not trusted", async () => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const forged = structuredClone(principal);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    expect(forged).toEqual(principal);
    expect(trust.isTrusted(forged)).toBe(false);
    await expect(policy.authorize(request(forged))).resolves.toMatchObject({ kind: "deny" });
  });

  it.each([
    [
      "multiple claims",
      [
        { actor_id: "actor-a", actor_type: "human" as const, endpoint_ids: ["endpoint-a"] },
        { actor_id: "actor-b", actor_type: "human" as const, endpoint_ids: ["endpoint-b"] },
      ],
    ],
    [
      "multiple endpoints",
      [{ actor_id: "actor-a", actor_type: "human" as const, endpoint_ids: ["endpoint-a", "endpoint-b"] }],
    ],
  ] as const)("denies a trusted malformed principal with %s", async (_label, actorClaims) => {
    const trust = new AdmissionPrincipalTrust();
    const principal: ResolvedPrincipal = {
      principal_id: "admission:connector-a",
      tenant_id: "tenant-a",
      actor_claims: actorClaims,
      attributes: {
        "workfabric.dev/identity_kind": "admission",
        "workfabric.dev/connector_id": "connector-a",
      },
    };
    markAdmissionPrincipalTrusted(trust, principal);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);

    await expect(policy.authorize(request(principal))).resolves.toMatchObject({ kind: "deny" });
  });

  it("requires exact own trusted identity attributes", async () => {
    const trust = new AdmissionPrincipalTrust();
    const inheritedAttributes = Object.create({
      "workfabric.dev/identity_kind": "admission",
      "workfabric.dev/connector_id": "connector-a",
      "workfabric.dev/ingress_id": "ingress-a",
      "workfabric.dev/idempotency_key": "command-a",
    }) as ResolvedPrincipal["attributes"];
    const principal: ResolvedPrincipal = {
      principal_id: "admission:connector-a",
      tenant_id: "tenant-a",
      actor_claims: [{ actor_id: "actor-a", actor_type: "human", endpoint_ids: ["endpoint-a"] }],
      attributes: inheritedAttributes,
    };
    markAdmissionPrincipalTrusted(trust, principal);

    await expect(
      new AdmissionAuthorityPolicy([rule()], trust).authorize(request(principal)),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies inherited or accessor-backed command tuple fields without invoking getters", async () => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const policy = new AdmissionAuthorityPolicy([rule()], trust);
    const inherited = Object.create(request(principal)) as AuthorityRequest;
    await expect(policy.authorize(inherited)).resolves.toMatchObject({ kind: "deny" });

    for (const field of ["correlation_id", "idempotency_key"] as const) {
      const getter = vi.fn(() => { throw new Error("tuple getter executed"); });
      const accessor = Object.defineProperty(
        { ...request(principal) },
        field,
        { enumerable: true, get: getter },
      ) as AuthorityRequest;
      await expect(policy.authorize(accessor)).resolves.toMatchObject({ kind: "deny" });
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("validates exact own bounded rule fields without invoking accessors", () => {
    const trust = new AdmissionPrincipalTrust();
    const invalidRules: unknown[] = [
      rule({ tenant_id: "" }),
      rule({ tenant_id: " tenant-a" }),
      rule({ tenant_id: "t".repeat(256) }),
      rule({ connector_id: "" }),
      rule({ connector_id: "connector-a " }),
      rule({ connector_id: "c".repeat(256) }),
      rule({ principal_id: "admission:connector-b" }),
      rule({ principal_id: "p".repeat(256) }),
      { ...rule(), action: "workfabric.handoff.accept.v1" },
      Object.assign(Object.create({ action: OFFER }), {
        tenant_id: "tenant-a",
        connector_id: "connector-a",
        principal_id: "admission:connector-a",
      }),
    ];

    for (const invalidRule of invalidRules) {
      expect(
        () => new AdmissionAuthorityPolicy([invalidRule as AdmissionAuthorityRule], trust),
      ).toThrow(TypeError);
    }

    const accessor = Object.defineProperty(
      { ...rule() },
      "tenant_id",
      { enumerable: true, get: () => { throw new Error("accessor executed"); } },
    );
    expect(
      () => new AdmissionAuthorityPolicy([accessor as AdmissionAuthorityRule], trust),
    ).toThrow(TypeError);
    expect(
      () => new AdmissionAuthorityPolicy([accessor as AdmissionAuthorityRule], trust),
    ).not.toThrow("accessor executed");
  });

  it("rejects exact duplicate rules instead of widening their meaning", () => {
    expect(
      () => new AdmissionAuthorityPolicy(
        [rule(), rule()],
        new AdmissionPrincipalTrust(),
      ),
    ).toThrow(TypeError);
  });

  it("accepts the bounded Task 5 principal derived from a maximum-length connector ID", () => {
    const connectorId = "c".repeat(255);
    expect(
      () => new AdmissionAuthorityPolicy([
        rule({
          connector_id: connectorId,
          principal_id: `admission:${connectorId}`,
        }),
      ], new AdmissionPrincipalTrust()),
    ).not.toThrow();
  });

  it("clones rules at construction and returns isolated authority manifests", async () => {
    const trust = new AdmissionPrincipalTrust();
    const principal = await resolvePrincipal(trust);
    const input = rule() as { -readonly [K in keyof AdmissionAuthorityRule]: AdmissionAuthorityRule[K] };
    const policy = new AdmissionAuthorityPolicy([input], trust);
    input.tenant_id = "tenant-b";

    const manifest = policy.manifest;
    expect(manifest).toEqual({
      profile: "exchange.authority.v1",
      adapter: "admission",
      capabilities: {
        explicit_decision: true,
        default_deny: true,
        resource_scoping: true,
      },
    });
    (manifest.capabilities as Record<string, boolean>).explicit_decision = false;
    expect(policy.manifest.capabilities.explicit_decision).toBe(true);
    await expect(policy.authorize(request(principal))).resolves.toEqual({ kind: "allow" });
  });
});

describe("CompositeAuthorityPolicy", () => {
  it("accepts ordinary own allow and deny decisions", async () => {
    const request = {} as AuthorityRequest;
    const childAllow = { kind: "allow" as const };
    const allow = await new CompositeAuthorityPolicy([
      authority(async () => childAllow),
    ]).authorize(request);
    expect(allow).toEqual({ kind: "allow" });
    expect(allow).not.toBe(childAllow);
    expect(Object.isFrozen(allow)).toBe(true);
    await expect(
      new CompositeAuthorityPolicy([
        authority(async () => ({ kind: "deny", reason: "ordinary deny" })),
      ]).authorize(request),
    ).resolves.toEqual({
      kind: "deny",
      reason: "No authority policy allowed the request",
    });
  });

  it("tries children in order and stops at the first allow", async () => {
    const calls: string[] = [];
    const first = authority(async () => {
      calls.push("first");
      return { kind: "deny", reason: "first private reason" };
    }, "first");
    const second = authority(async () => {
      calls.push("second");
      return { kind: "allow" };
    }, "second");
    const third = authority(async () => {
      calls.push("third");
      return { kind: "allow" };
    }, "third");

    const decision = await new CompositeAuthorityPolicy([first, second, third]).authorize(
      {} as AuthorityRequest,
    );

    expect(decision).toEqual({ kind: "allow" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("returns one stable generic deny without exposing child reasons", async () => {
    const policy = new CompositeAuthorityPolicy([
      authority(async () => ({ kind: "deny", reason: "secret reason A" })),
      authority(async () => ({ kind: "deny", reason: "secret reason B" })),
    ]);

    const first = await policy.authorize({} as AuthorityRequest);
    const second = await policy.authorize({} as AuthorityRequest);
    expect(first).toEqual(second);
    expect(first).toEqual({ kind: "deny", reason: "No authority policy allowed the request" });
    expect(JSON.stringify(first)).not.toContain("secret reason");
  });

  it("propagates child errors and never skips a failed authority to reach an allow", async () => {
    const later = vi.fn(async () => ({ kind: "allow" as const }));
    const policy = new CompositeAuthorityPolicy([
      authority(async () => { throw new Error("authority unavailable"); }),
      authority(later),
    ]);

    await expect(policy.authorize({} as AuthorityRequest)).rejects.toThrow(
      "authority unavailable",
    );
    expect(later).not.toHaveBeenCalled();
  });

  it("rejects an inherited allow decision and never reaches a later allow", async () => {
    const inherited = Object.create({ kind: "allow" }) as AuthorityDecision;
    const later = vi.fn(async () => ({ kind: "allow" as const }));
    const policy = new CompositeAuthorityPolicy([
      authority(async () => inherited),
      authority(later),
    ]);

    await expect(policy.authorize({} as AuthorityRequest)).rejects.toThrow(
      new TypeError("Authority policy returned an invalid decision"),
    );
    expect(later).not.toHaveBeenCalled();
  });

  it("rejects an accessor-backed allow without invoking it or reaching a later allow", async () => {
    const getter = vi.fn(() => "allow");
    const accessor = Object.defineProperty({}, "kind", { get: getter }) as AuthorityDecision;
    const later = vi.fn(async () => ({ kind: "allow" as const }));
    const policy = new CompositeAuthorityPolicy([
      authority(async () => accessor),
      authority(later),
    ]);

    await expect(policy.authorize({} as AuthorityRequest)).rejects.toThrow(
      new TypeError("Authority policy returned an invalid decision"),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("rejects a malformed own decision kind", async () => {
    const malformed = { kind: "permit" } as unknown as AuthorityDecision;

    await expect(
      new CompositeAuthorityPolicy([
        authority(async () => malformed),
      ]).authorize({} as AuthorityRequest),
    ).rejects.toThrow(new TypeError("Authority policy returned an invalid decision"));
  });

  it("returns an isolated manifest with all required authority capabilities", () => {
    const policy = new CompositeAuthorityPolicy([]);
    const manifest = policy.manifest;

    expect(manifest).toEqual({
      profile: "exchange.authority.v1",
      adapter: "composite",
      capabilities: {
        explicit_decision: true,
        default_deny: true,
        resource_scoping: true,
      },
    });
    (manifest.capabilities as Record<string, boolean>).default_deny = false;
    expect(policy.manifest.capabilities.default_deny).toBe(true);
  });
});
