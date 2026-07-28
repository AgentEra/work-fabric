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
  TargetEligibilityDecision,
  TargetEligibilityRequest,
  TargetEligibilityVerifier,
} from "@work-fabric/exchange-spi";

import {
  verifyAuthorityProfile,
  verifyContextProfile,
  verifyIdentityProfile,
  verifySignalProfile,
  verifyTargetEligibilityProfile,
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

type ContextWeakness =
  | "wrong_reference"
  | "tenant_id"
  | "context_id"
  | "version"
  | "actor_id"
  | "endpoint_id";

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextReference(bundle: JsonObject): ContextReference {
  const digest = bundle.digest;
  const normalizedDigest =
    isJsonObject(digest)
      ? `${String(digest.algorithm)}:${String(digest.value)}`
      : null;
  return {
    context_id: String(bundle.context_id),
    version: Number(bundle.version),
    digest: normalizedDigest,
  };
}

class ContextTestAdapter implements ContextRepository {
  readonly manifest: CapabilityManifest;
  behaviorCalls = 0;
  private bundle: JsonObject | null = null;
  private tenantId: string | null = null;
  private reference: ContextReference | null = null;

  constructor(
    adapterManifest: CapabilityManifest,
    private readonly weakness: ContextWeakness | null = null,
  ) {
    this.manifest = adapterManifest;
  }

  async putBundle(tenantId: string, bundle: JsonObject): Promise<ContextReference> {
    this.behaviorCalls += 1;
    if (this.bundle !== null && JSON.stringify(this.bundle) !== JSON.stringify(bundle)) {
      throw new Error("immutable version conflict");
    }
    this.bundle = structuredClone(bundle);
    this.tenantId = tenantId;
    this.reference = contextReference(bundle);
    return this.weakness === "wrong_reference"
      ? {
          context_id: "context_wrong",
          version: 999,
          digest: "sha-256:wrong",
        }
      : structuredClone(this.reference);
  }

  async checkAvailability(
    request: ContextAccessRequest,
  ): Promise<ContextAvailability> {
    this.behaviorCalls += 1;
    if (request.reference === null) {
      return { kind: "available" };
    }
    if (this.reference === null || this.tenantId === null) {
      return { kind: "unavailable", reason: "missing Context" };
    }
    if (
      this.weakness !== "tenant_id" &&
      request.tenant_id !== this.tenantId
    ) {
      return { kind: "unavailable", reason: "tenant mismatch" };
    }
    if (
      this.weakness !== "context_id" &&
      request.reference.context_id !== this.reference.context_id
    ) {
      return { kind: "unavailable", reason: "Context ID mismatch" };
    }
    if (
      this.weakness !== "version" &&
      request.reference.version !== this.reference.version
    ) {
      return { kind: "unavailable", reason: "version mismatch" };
    }
    if (
      request.reference.digest !== null &&
      request.reference.digest !== this.reference.digest
    ) {
      return { kind: "unavailable", reason: "digest mismatch" };
    }
    if (
      this.weakness !== "actor_id" &&
      request.actor_id !== "actor_allowed"
    ) {
      return { kind: "unavailable", reason: "Actor hidden" };
    }
    if (
      this.weakness !== "endpoint_id" &&
      request.endpoint_id !== "endpoint_01"
    ) {
      return { kind: "unavailable", reason: "Endpoint hidden" };
    }
    return { kind: "available" };
  }

  async readBundle(
    request: ContextAccessRequest,
  ): Promise<
    | { readonly kind: "available"; readonly bundle: JsonObject }
    | { readonly kind: "unavailable"; readonly reason: string }
  > {
    const availability = await this.checkAvailability(request);
    if (availability.kind === "unavailable") return availability;
    if (request.reference === null || this.bundle === null) {
      return { kind: "unavailable", reason: "missing Context" };
    }
    return { kind: "available", bundle: structuredClone(this.bundle) };
  }
}

function signalAdapter(
  adapterManifest: CapabilityManifest,
  onDeliver: () => void = () => undefined,
  corruptObservation = false,
): SignalAdapter & {
  deliveries(): readonly {
    readonly event: ProtocolEvent;
    readonly destination: SignalDestination;
  }[];
} {
  const deliveries: {
    readonly event: ProtocolEvent;
    readonly destination: SignalDestination;
  }[] = [];
  return {
    manifest: adapterManifest,
    async deliver(
      deliveredEvent: ProtocolEvent,
      destination: SignalDestination,
    ): Promise<SignalDeliveryResult> {
      onDeliver();
      deliveries.push({
        event: {
          ...structuredClone(deliveredEvent),
          id: corruptObservation ? "event_corrupted" : deliveredEvent.id,
        },
        destination: {
          ...structuredClone(destination),
          destination_id: corruptObservation
            ? "destination_corrupted"
            : destination.destination_id,
        },
      });
      if (destination.destination_id === "retryable") {
        return { kind: "retryable_failure", detail: "temporary" };
      }
      if (destination.destination_id === "permanent") {
        return { kind: "permanent_failure", detail: "invalid" };
      }
      return { kind: "accepted" };
    },
    deliveries() {
      return structuredClone(deliveries);
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
const targetEligibilityManifest = manifest("exchange.target-eligibility.v1", {
  explicit_target_only: true,
  no_candidate_selection: true,
  fail_closed: true,
});

function targetEligibilityAdapter(): TargetEligibilityVerifier {
  return {
    manifest: targetEligibilityManifest,
    async verify(
      request: TargetEligibilityRequest,
    ): Promise<TargetEligibilityDecision> {
      if ("actor_id" in request.proposed_target) {
        return { kind: "ineligible", reason: "Actor lacks capability" };
      }
      if (request.proposed_target.endpoint_id === "endpoint_unreachable") {
        return { kind: "unavailable", reason: "Directory unavailable" };
      }
      return { kind: "eligible" };
    },
  };
}

const targetEligibilityBase: TargetEligibilityRequest = {
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  handoff_id: "handoff_01",
  requirement: { capability_id: "software.implementation" },
  proposed_target: { endpoint_id: "endpoint_agent" },
  principal,
};

const authorityBase: AuthorityRequest = {
  principal,
  actor_id: "human_01",
  actor_type: "human",
  endpoint_id: "endpoint_01",
  delegation_id: null,
  action: "allowed",
  resource_id: null,
  correlation_id: null,
  idempotency_key: "command-01",
};

const bundle: JsonObject = {
  context_id: "context_01",
  version: 1,
  created_at: "2026-07-14T00:00:00.000Z",
  summary: "conformance Context",
  items: [],
  digest: { algorithm: "sha-256", value: "context-01" },
  visibility_scope: {
    actor_ids: ["actor_allowed"],
    endpoint_ids: ["endpoint_01"],
    expires_at: null,
  },
  extensions: {},
};

const reference: ContextReference = {
  context_id: "context_01",
  version: 1,
  digest: "sha-256:context-01",
};

const destination = (destinationId: string): SignalDestination => ({
  destination_id: destinationId,
  binding: "test",
  configuration: {},
});

describe("peripheral Adapter Profile verifiers", () => {
  it("verifies eligible, ineligible, and unavailable target decisions", async () => {
    await expect(
      verifyTargetEligibilityProfile(targetEligibilityAdapter(), {
        eligible_request: targetEligibilityBase,
        ineligible_request: {
          ...targetEligibilityBase,
          proposed_target: { actor_id: "actor_without_capability" },
        },
        unavailable_request: {
          ...targetEligibilityBase,
          proposed_target: { endpoint_id: "endpoint_unreachable" },
        },
      }),
    ).resolves.toBeUndefined();
  });

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
          endpoint_id: "endpoint_hidden",
          reference,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects Context anti-fakes with false references or missing isolation checks", async () => {
    const weaknesses: readonly ContextWeakness[] = [
      "wrong_reference",
      "tenant_id",
      "context_id",
      "version",
      "actor_id",
      "endpoint_id",
    ];

    for (const weakness of weaknesses) {
      await expect(
        verifyContextProfile(
          new ContextTestAdapter(contextManifest, weakness),
          {
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
              endpoint_id: "endpoint_hidden",
              reference,
            },
          },
        ),
        `expected ${weakness} anti-fake to fail conformance`,
      ).rejects.toThrow();
    }
  });

  it("verifies accepted, retryable, and permanent Signal outcomes", async () => {
    const adapter = signalAdapter(signalManifest);
    await expect(
      verifySignalProfile(adapter, {
        event,
        accepted_destination: destination("accepted"),
        retryable_destination: destination("retryable"),
        permanent_destination: destination("permanent"),
        observe_deliveries: async () => adapter.deliveries(),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Signal adapter whose observed Event IDs and Destinations are corrupted", async () => {
    const adapter = signalAdapter(signalManifest, () => undefined, true);

    await expect(
      verifySignalProfile(adapter, {
        event,
        accepted_destination: destination("accepted"),
        retryable_destination: destination("retryable"),
        permanent_destination: destination("permanent"),
        observe_deliveries: async () => adapter.deliveries(),
      }),
    ).rejects.toThrow(/event|destination|delivery/i);
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
          endpoint_id: "endpoint_hidden",
          reference,
        },
      }),
    ).rejects.toThrow(/digest_verification/i);
    const signal = signalAdapter(
      manifest("exchange.signal.v1", {
        event_id_preservation: true,
        outcome_classification: true,
        payload_isolation: false,
      }),
      behaviorRan,
    );
    await expect(
      verifySignalProfile(
        signal,
        {
          event,
          accepted_destination: destination("accepted"),
          retryable_destination: destination("retryable"),
          permanent_destination: destination("permanent"),
          observe_deliveries: async () => signal.deliveries(),
        },
      ),
    ).rejects.toThrow(/payload_isolation/i);

    expect(behaviorCalls).toBe(0);
    expect(context.behaviorCalls).toBe(0);
  });
});
