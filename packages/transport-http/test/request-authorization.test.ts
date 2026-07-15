import { describe, expect, it } from "vitest";

import { LocalAuthorityPolicy, LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import type { ResolvedPrincipal } from "@work-fabric/exchange-spi";

import { authorizeHttpRequest } from "../src/index.js";

const principal: ResolvedPrincipal = {
  principal_id: "principal_01",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_01",
      actor_type: "agent",
      endpoint_ids: ["endpoint_01"],
    },
  ],
  attributes: {},
};

function dependencies(allowed = true) {
  return {
    identity: new LocalIdentityProvider([
      {
        authentication_evidence: { bearer_token: "known" },
        principal,
      },
    ]),
    authority: new LocalAuthorityPolicy(
      allowed
        ? [
            {
              tenant_id: "tenant_01",
              principal_id: "principal_01",
              actor_id: "actor_01",
              actor_type: "agent",
              endpoint_id: "endpoint_01",
              action: "workfabric.query.handoff.read.v1",
              resource_id: "handoff_01",
            },
          ]
        : [],
    ),
  };
}

const request = {
  authentication_evidence: { bearer_token: "known" },
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  delegation_id: null,
  action: "workfabric.query.handoff.read.v1",
  resource_id: "handoff_01",
} as const;

describe("authorizeHttpRequest", () => {
  it("returns the trusted Principal and represented Actor", async () => {
    await expect(
      authorizeHttpRequest(request, dependencies()),
    ).resolves.toEqual({
      kind: "authorized",
      principal,
      actor: { actor_id: "actor_01", actor_type: "agent" },
      endpoint_id: "endpoint_01",
      delegation_id: null,
    });
  });

  it("returns 401 for missing or unknown evidence", async () => {
    for (const authentication_evidence of [null, { bearer_token: "unknown" }]) {
      await expect(
        authorizeHttpRequest(
          { ...request, authentication_evidence },
          dependencies(),
        ),
      ).resolves.toMatchObject({
        kind: "denied",
        problem: { status: 401, code: "unauthenticated" },
      });
    }
  });

  it("returns 403 before Authority when Actor or Endpoint is unrepresented", async () => {
    await expect(
      authorizeHttpRequest(
        { ...request, endpoint_id: "endpoint_other" },
        dependencies(),
      ),
    ).resolves.toMatchObject({
      kind: "denied",
      problem: { status: 403, code: "permission_denied" },
    });
  });

  it("returns 403 when the exact action/resource is denied", async () => {
    await expect(
      authorizeHttpRequest(request, dependencies(false)),
    ).resolves.toMatchObject({
      kind: "denied",
      problem: { status: 403, code: "permission_denied" },
    });
  });
});
