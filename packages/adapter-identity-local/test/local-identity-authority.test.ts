import { describe, expect, it } from "vitest";

import {
  verifyAuthorityProfile,
  verifyIdentityProfile,
} from "@work-fabric/exchange-conformance";
import type {
  AuthorityRequest,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
} from "../src/index.js";

const runtimePrincipal: ResolvedPrincipal = {
  principal_id: "principal_runtime",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "agent_research",
      actor_type: "agent",
      endpoint_ids: ["endpoint_runtime"],
    },
    {
      actor_id: "agent_writer",
      actor_type: "agent",
      endpoint_ids: ["endpoint_runtime"],
    },
  ],
  attributes: { runtime: "local" },
};

const mixedPrincipal: ResolvedPrincipal = {
  principal_id: "principal_mixed",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "human_01",
      actor_type: "human",
      endpoint_ids: ["endpoint_human"],
    },
    {
      actor_id: "agent_01",
      actor_type: "agent",
      endpoint_ids: ["endpoint_agent"],
    },
    {
      actor_id: "system_01",
      actor_type: "system",
      endpoint_ids: ["endpoint_system"],
    },
  ],
  attributes: {},
};

function authorityRequest(
  principal: ResolvedPrincipal,
  overrides: Partial<AuthorityRequest> = {},
): AuthorityRequest {
  return {
    principal,
    actor_id: "agent_research",
    actor_type: "agent",
    endpoint_id: "endpoint_runtime",
    delegation_id: null,
    action: "handoff.offer",
    resource_id: "handoff_01",
    ...overrides,
  };
}

function allowRule(
  overrides: Partial<LocalAuthorityAllowRule> = {},
): LocalAuthorityAllowRule {
  return {
    tenant_id: "tenant_01",
    principal_id: "principal_runtime",
    actor_id: "agent_research",
    actor_type: "agent",
    endpoint_id: "endpoint_runtime",
    action: "handoff.offer",
    resource_id: "handoff_01",
    ...overrides,
  };
}

describe("LocalIdentityProvider", () => {
  it("declares only the required identity profile capabilities", () => {
    const provider = new LocalIdentityProvider([]);

    expect(provider.manifest).toEqual({
      profile: "exchange.identity.v1",
      adapter: "local",
      capabilities: {
        authenticated_principal: true,
        trusted_actor_claims: true,
        tenant_binding: true,
      },
    });
  });

  it("resolves known authentication evidence and rejects unknown evidence", async () => {
    const provider = new LocalIdentityProvider([
      {
        authentication_evidence: { bearer: "known-token" },
        principal: runtimePrincipal,
      },
    ]);

    await expect(provider.resolve({ bearer: "known-token" })).resolves.toEqual(
      runtimePrincipal,
    );
    await expect(provider.resolve({ bearer: "unknown-token" })).resolves.toBeNull();
    await expect(
      provider.resolve({
        payload: {
          principal_id: runtimePrincipal.principal_id,
          tenant_id: runtimePrincipal.tenant_id,
        },
      }),
    ).resolves.toBeNull();
  });

  it("returns trusted Principal records isolated from caller mutation", async () => {
    const evidence = { bearer: "known-token" };
    const principal = structuredClone(runtimePrincipal);
    const provider = new LocalIdentityProvider([
      { authentication_evidence: evidence, principal },
    ]);

    evidence.bearer = "changed-after-construction";
    (principal.actor_claims[0]!.endpoint_ids as string[])[0] = "changed-input";
    const first = await provider.resolve({ bearer: "known-token" });
    expect(first).not.toBeNull();
    if (first === null) {
      throw new Error("expected a resolved Principal");
    }
    (first.actor_claims[0]!.endpoint_ids as string[])[0] = "changed-output";

    await expect(provider.resolve({ bearer: "known-token" })).resolves.toEqual(
      runtimePrincipal,
    );
  });

  it("preserves distinct human, agent, and system Actor claims", async () => {
    const provider = new LocalIdentityProvider([
      {
        authentication_evidence: { session: "mixed" },
        principal: mixedPrincipal,
      },
    ]);

    const resolved = await provider.resolve({ session: "mixed" });

    expect(resolved?.actor_claims.map(({ actor_id, actor_type }) => ({
      actor_id,
      actor_type,
    }))).toEqual([
      { actor_id: "human_01", actor_type: "human" },
      { actor_id: "agent_01", actor_type: "agent" },
      { actor_id: "system_01", actor_type: "system" },
    ]);
  });

  it("passes the reusable identity profile verifier", async () => {
    const provider = new LocalIdentityProvider([
      {
        authentication_evidence: { bearer: "known-token" },
        principal: runtimePrincipal,
      },
    ]);

    await expect(
      verifyIdentityProfile(provider, {
        known_evidence: { bearer: "known-token" },
        unknown_evidence: { bearer: "unknown-token" },
        expected_principal: runtimePrincipal,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("LocalAuthorityPolicy", () => {
  it("declares only the required authority profile capabilities", () => {
    const policy = new LocalAuthorityPolicy([]);

    expect(policy.manifest).toEqual({
      profile: "exchange.authority.v1",
      adapter: "local",
      capabilities: {
        explicit_decision: true,
        default_deny: true,
        resource_scoping: true,
      },
    });
  });

  it("allows both configured Agent Actors represented by one Runtime Principal", async () => {
    const policy = new LocalAuthorityPolicy([
      allowRule(),
      allowRule({ actor_id: "agent_writer", action: "handoff.accept" }),
    ]);

    await expect(policy.authorize(authorityRequest(runtimePrincipal))).resolves.toEqual({
      kind: "allow",
    });
    await expect(
      policy.authorize(
        authorityRequest(runtimePrincipal, {
          actor_id: "agent_writer",
          action: "handoff.accept",
        }),
      ),
    ).resolves.toEqual({ kind: "allow" });
  });

  it("scopes target-resolution authority to the exact action and Handoff", async () => {
    const action = "workfabric.handoff.resolve_target.v1";
    const policy = new LocalAuthorityPolicy([
      allowRule({ action, resource_id: "handoff_pending" }),
    ]);

    await expect(
      policy.authorize(
        authorityRequest(runtimePrincipal, {
          action,
          resource_id: "handoff_pending",
        }),
      ),
    ).resolves.toEqual({ kind: "allow" });
    await expect(
      policy.authorize(
        authorityRequest(runtimePrincipal, {
          action: "workfabric.handoff.report_target_unavailable.v1",
          resource_id: "handoff_pending",
        }),
      ),
    ).resolves.toMatchObject({ kind: "deny" });
    await expect(
      policy.authorize(
        authorityRequest(runtimePrincipal, {
          action,
          resource_id: "handoff_other",
        }),
      ),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies an explicit rule when the Principal has no trusted Actor representation", async () => {
    const policy = new LocalAuthorityPolicy([
      allowRule({ actor_id: "agent_unconfigured" }),
    ]);

    const decision = await policy.authorize(
      authorityRequest(runtimePrincipal, { actor_id: "agent_unconfigured" }),
    );

    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toMatch(/representation|claim/i);
    }
  });

  it("defaults to deny and never treats wildcard-looking rules as implicit allow", async () => {
    const emptyPolicy = new LocalAuthorityPolicy([]);
    const wildcardPolicy = new LocalAuthorityPolicy([
      allowRule({ action: "*" }),
      allowRule({ resource_id: "*" }),
    ]);

    await expect(
      emptyPolicy.authorize(authorityRequest(runtimePrincipal)),
    ).resolves.toMatchObject({ kind: "deny" });
    await expect(
      wildcardPolicy.authorize(authorityRequest(runtimePrincipal)),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("matches every tenant, Principal, Actor type, Endpoint, action, and resource field exactly", async () => {
    const policy = new LocalAuthorityPolicy([allowRule()]);
    const mismatches: readonly AuthorityRequest[] = [
      authorityRequest({ ...runtimePrincipal, tenant_id: "tenant_02" }),
      authorityRequest({ ...runtimePrincipal, principal_id: "principal_other" }),
      authorityRequest(runtimePrincipal, { actor_id: "agent_writer" }),
      authorityRequest(runtimePrincipal, { actor_type: "system" }),
      authorityRequest(runtimePrincipal, { endpoint_id: "endpoint_other" }),
      authorityRequest(runtimePrincipal, { action: "handoff.accept" }),
      authorityRequest(runtimePrincipal, { resource_id: null }),
    ];

    await expect(policy.authorize(authorityRequest(runtimePrincipal))).resolves.toEqual({
      kind: "allow",
    });
    for (const mismatch of mismatches) {
      await expect(policy.authorize(mismatch)).resolves.toMatchObject({
        kind: "deny",
      });
    }
  });

  it("keeps human, agent, and system Actor types distinct during authorization", async () => {
    const rules: readonly LocalAuthorityAllowRule[] = [
      {
        tenant_id: "tenant_01",
        principal_id: "principal_mixed",
        actor_id: "human_01",
        actor_type: "human",
        endpoint_id: "endpoint_human",
        action: "act",
        resource_id: null,
      },
      {
        tenant_id: "tenant_01",
        principal_id: "principal_mixed",
        actor_id: "agent_01",
        actor_type: "agent",
        endpoint_id: "endpoint_agent",
        action: "act",
        resource_id: null,
      },
      {
        tenant_id: "tenant_01",
        principal_id: "principal_mixed",
        actor_id: "system_01",
        actor_type: "system",
        endpoint_id: "endpoint_system",
        action: "act",
        resource_id: null,
      },
    ];
    const policy = new LocalAuthorityPolicy(rules);

    for (const rule of rules) {
      await expect(
        policy.authorize({
          principal: mixedPrincipal,
          actor_id: rule.actor_id,
          actor_type: rule.actor_type,
          endpoint_id: rule.endpoint_id,
          delegation_id: null,
          action: rule.action,
          resource_id: rule.resource_id,
        }),
      ).resolves.toEqual({ kind: "allow" });
    }
    await expect(
      policy.authorize({
        principal: mixedPrincipal,
        actor_id: "human_01",
        actor_type: "agent",
        endpoint_id: "endpoint_human",
        delegation_id: null,
        action: "act",
        resource_id: null,
      }),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("passes the reusable authority profile verifier", async () => {
    const allowed = authorityRequest(runtimePrincipal);
    const denied = authorityRequest(runtimePrincipal, { action: "handoff.accept" });
    const policy = new LocalAuthorityPolicy([allowRule()]);

    await expect(
      verifyAuthorityProfile(policy, {
        allowed_request: allowed,
        denied_request: denied,
      }),
    ).resolves.toBeUndefined();
  });
});
