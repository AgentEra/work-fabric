import { describe, expect, it } from "vitest";

import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
  ContextAccessRequest,
  ContextAvailability,
  ContextReference,
  ContextRepository,
  IdentityProvider,
  JsonObject,
  ProtocolEvent,
  ResolvedPrincipal,
  SignalAdapter,
  SignalDeliveryResult,
  SignalDestination,
} from "@work-fabric/exchange-spi";

import {
  verifyAuthorityProfile,
  verifyContextProfile,
  verifyIdentityProfile,
  verifySignalProfile,
} from "../src/index.js";

const principal: ResolvedPrincipal = {
  principal_id: "principal_01",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "human_01",
      actor_type: "human",
      endpoint_ids: ["endpoint_01"],
    },
    {
      actor_id: "agent_01",
      actor_type: "agent",
      endpoint_ids: ["endpoint_02"],
    },
    {
      actor_id: "system_01",
      actor_type: "system",
      endpoint_ids: ["endpoint_03"],
    },
  ],
  attributes: {},
};

const event: ProtocolEvent = {
  specversion: "1.0",
  id: "event_01",
  source: "urn:work-fabric:exchange:exchange_01",
  type: "workfabric.test.v1",
  subject: "handoff_01",
  time: "2026-07-14T00:00:00.000Z",
  datacontenttype: "application/json",
  dataschema: "urn:work-fabric:event:test:v1",
  wfsequence: 1,
  data: { state: "offered" },
};

function manifest(
  profile: string,
  capabilities: Readonly<Record<string, boolean>>,
): CapabilityManifest {
  return { profile, adapter: "conformance-test", capabilities };
}

function identityAdapter(
  adapterManifest: CapabilityManifest,
  onResolve: () => void = () => undefined,
): IdentityProvider {
  return {
    manifest: adapterManifest,
    async resolve(evidence: JsonObject): Promise<ResolvedPrincipal | null> {
      onResolve();
      return evidence.credential === "known" ? structuredClone(principal) : null;
    },
  };
}

function authorityAdapter(
  adapterManifest: CapabilityManifest,
  onAuthorize: () => void = () => undefined,
): AuthorityPolicy {
  return {
    manifest: adapterManifest,
    async authorize(request: AuthorityRequest): Promise<AuthorityDecision> {
      onAuthorize();
      return request.action === "allowed"
        ? { kind: "allow" }
        : { kind: "deny", reason: "default deny" };
    },
  };
}

class ContextTestAdapter implements ContextRepository {
  readonly manifest: CapabilityManifest;
  behaviorCalls = 0;
  private bundle: JsonObject | null = null;

  constructor(adapterManifest: CapabilityManifest) {
    this.manifest = adapterManifest;
  }

  async putBundle(_tenantId: string, bundle: JsonObject): Promise<ContextReference> {
    this.behaviorCalls += 1;
    if (this.bundle !== null && JSON.stringify(this.bundle) !== JSON.stringify(bundle)) {
      throw new Error("immutable version conflict");
    }
    this.bundle = structuredClone(bundle);
    return {
      context_id: String(bundle.context_id),
      version: Number(bundle.version),
      digest: typeof bundle.digest === "string" ? bundle.digest : null,
    };
  }

  async checkAvailability(
    request: ContextAccessRequest,
  ): Promise<ContextAvailability> {
    this.behaviorCalls += 1;
    if (request.reference === null) {
      return { kind: "available" };
    }
    if (
      request.reference.digest !== null &&
      request.reference.digest !== this.bundle?.digest
    ) {
      return { kind: "unavailable", reason: "digest mismatch" };
    }
    if (request.actor_id === "actor_allowed") {
      return { kind: "available" };
    }
    return { kind: "unavailable", reason: "hidden" };
  }
}

function signalAdapter(
  adapterManifest: CapabilityManifest,
  onDeliver: () => void = () => undefined,
): SignalAdapter {
  return {
    manifest: adapterManifest,
    async deliver(
      _event: ProtocolEvent,
      destination: SignalDestination,
    ): Promise<SignalDeliveryResult> {
      onDeliver();
      if (destination.destination_id === "retryable") {
        return { kind: "retryable_failure", detail: "temporary" };
      }
      if (destination.destination_id === "permanent") {
        return { kind: "permanent_failure", detail: "invalid" };
      }
      return { kind: "accepted" };
    },
  };
}

const identityManifest = manifest("exchange.identity.v1", {
  authenticated_principal: true,
  trusted_actor_claims: true,
  tenant_binding: true,
});
const authorityManifest = manifest("exchange.authority.v1", {
  explicit_decision: true,
  default_deny: true,
  resource_scoping: true,
});
const contextManifest = manifest("exchange.context.v1", {
  immutable_versions: true,
  digest_verification: true,
  visibility_enforcement: true,
});
const signalManifest = manifest("exchange.signal.v1", {
  event_id_preservation: true,
  outcome_classification: true,
  payload_isolation: true,
});

const authorityBase: AuthorityRequest = {
  principal,
  actor_id: "human_01",
  actor_type: "human",
  endpoint_id: "endpoint_01",
  delegation_id: null,
  action: "allowed",
  resource_id: null,
};

const bundle: JsonObject = {
  context_id: "context_01",
  version: 1,
  digest: "sha256:context-01",
  visibility_scope: {
    actor_ids: ["actor_allowed"],
    endpoint_ids: ["endpoint_01"],
    expires_at: null,
  },
};

const reference: ContextReference = {
  context_id: "context_01",
  version: 1,
  digest: "sha256:context-01",
};

const destination = (destinationId: string): SignalDestination => ({
  destination_id: destinationId,
  binding: "test",
  configuration: {},
});

describe("peripheral Adapter Profile verifiers", () => {
  it("verifies identity behavior including trusted Actor type preservation", async () => {
    await expect(
      verifyIdentityProfile(identityAdapter(identityManifest), {
        known_evidence: { credential: "known" },
        unknown_evidence: { credential: "unknown" },
        expected_principal: principal,
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies explicit authority allow and default deny", async () => {
    await expect(
      verifyAuthorityProfile(authorityAdapter(authorityManifest), {
        allowed_request: authorityBase,
        denied_request: { ...authorityBase, action: "denied" },
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies immutable Context versions plus availability checks", async () => {
    await expect(
      verifyContextProfile(new ContextTestAdapter(contextManifest), {
        tenant_id: "tenant_01",
        bundle,
        allowed_request: {
          tenant_id: "tenant_01",
          actor_id: "actor_allowed",
          endpoint_id: "endpoint_01",
          reference,
        },
        denied_request: {
          tenant_id: "tenant_01",
          actor_id: "actor_hidden",
          endpoint_id: "endpoint_01",
          reference,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies accepted, retryable, and permanent Signal outcomes", async () => {
    await expect(
      verifySignalProfile(signalAdapter(signalManifest), {
        event,
        accepted_destination: destination("accepted"),
        retryable_destination: destination("retryable"),
        permanent_destination: destination("permanent"),
      }),
    ).resolves.toBeUndefined();
  });

  it("checks every exact profile and capability set before behavior", async () => {
    let behaviorCalls = 0;
    const behaviorRan = (): void => {
      behaviorCalls += 1;
    };
    const context = new ContextTestAdapter(
      manifest("exchange.context.v1", {
        immutable_versions: true,
        digest_verification: false,
        visibility_enforcement: true,
      }),
    );

    await expect(
      verifyIdentityProfile(
        identityAdapter(
          manifest("exchange.identity.v2", identityManifest.capabilities),
          behaviorRan,
        ),
        {
          known_evidence: { credential: "known" },
          unknown_evidence: { credential: "unknown" },
          expected_principal: principal,
        },
      ),
    ).rejects.toThrow(/exchange\.identity\.v1/i);
    await expect(
      verifyAuthorityProfile(
        authorityAdapter(
          manifest("exchange.authority.v1", {
            explicit_decision: true,
            default_deny: false,
            resource_scoping: true,
          }),
          behaviorRan,
        ),
        {
          allowed_request: authorityBase,
          denied_request: { ...authorityBase, action: "denied" },
        },
      ),
    ).rejects.toThrow(/default_deny/i);
    await expect(
      verifyContextProfile(context, {
        tenant_id: "tenant_01",
        bundle,
        allowed_request: {
          tenant_id: "tenant_01",
          actor_id: "actor_allowed",
          endpoint_id: "endpoint_01",
          reference,
        },
        denied_request: {
          tenant_id: "tenant_01",
          actor_id: "actor_hidden",
          endpoint_id: "endpoint_01",
          reference,
        },
      }),
    ).rejects.toThrow(/digest_verification/i);
    await expect(
      verifySignalProfile(
        signalAdapter(
          manifest("exchange.signal.v1", {
            event_id_preservation: true,
            outcome_classification: true,
            payload_isolation: false,
          }),
          behaviorRan,
        ),
        {
          event,
          accepted_destination: destination("accepted"),
          retryable_destination: destination("retryable"),
          permanent_destination: destination("permanent"),
        },
      ),
    ).rejects.toThrow(/payload_isolation/i);

    expect(behaviorCalls).toBe(0);
    expect(context.behaviorCalls).toBe(0);
  });
});
