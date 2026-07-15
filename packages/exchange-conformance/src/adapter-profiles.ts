import assert from "node:assert/strict";

import {
  AUTHORITY_REQUIRED_CAPABILITIES,
  CONTEXT_REQUIRED_CAPABILITIES,
  IDENTITY_REQUIRED_CAPABILITIES,
  SIGNAL_REQUIRED_CAPABILITIES,
  TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type AuthorityPolicy,
  type AuthorityRequest,
  type ContextAccessRequest,
  type ContextReference,
  type ContextRepository,
  type ExchangeAdapter,
  type IdentityProvider,
  type JsonObject,
  type JsonValue,
  type ProtocolEvent,
  type ResolvedPrincipal,
  type SignalAdapter,
  type SignalDestination,
  type TargetEligibilityRequest,
  type TargetEligibilityVerifier,
} from "@work-fabric/exchange-spi";

export interface IdentityProfileFixtures {
  readonly known_evidence: JsonObject;
  readonly unknown_evidence: JsonObject;
  readonly expected_principal: ResolvedPrincipal;
}

export interface AuthorityProfileFixtures {
  readonly allowed_request: AuthorityRequest;
  readonly denied_request: AuthorityRequest;
}

export interface ContextProfileFixtures {
  readonly tenant_id: string;
  readonly bundle: JsonObject;
  readonly allowed_request: ContextAccessRequest;
  readonly denied_request: ContextAccessRequest;
}

export interface SignalProfileFixtures {
  readonly event: ProtocolEvent;
  readonly accepted_destination: SignalDestination;
  readonly retryable_destination: SignalDestination;
  readonly permanent_destination: SignalDestination;
  readonly observe_deliveries: () => Promise<readonly {
    readonly event: ProtocolEvent;
    readonly destination: SignalDestination;
  }[]>;
}

export interface TargetEligibilityProfileFixtures {
  readonly eligible_request: TargetEligibilityRequest;
  readonly ineligible_request: TargetEligibilityRequest;
  readonly unavailable_request: TargetEligibilityRequest;
}

function assertProfile(
  adapter: ExchangeAdapter,
  profile: string,
  capabilities: readonly string[],
): void {
  assert.equal(
    adapter.manifest.profile,
    profile,
    `expected Adapter Profile ${profile}`,
  );
  assertCapabilities(adapter.manifest, capabilities);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedContextReference(bundle: JsonObject): ContextReference {
  const contextId = bundle.context_id;
  assert.ok(
    typeof contextId === "string" && contextId.length > 0,
    "Context Profile fixture context_id must be a non-empty string",
  );
  const version = bundle.version;
  assert.ok(
    typeof version === "number" && Number.isInteger(version) && version > 0,
    "Context Profile fixture version must be a positive integer",
  );
  const wireDigest = bundle.digest;
  if (wireDigest === null) {
    return { context_id: contextId, version, digest: null };
  }
  assert.ok(
    isJsonObject(wireDigest),
    "Context Profile fixture digest must be a WFPP Digest object or null",
  );
  assert.deepEqual(
    Object.keys(wireDigest).sort(),
    ["algorithm", "value"],
    "Context Profile fixture digest must contain exactly algorithm and value",
  );
  const algorithm = wireDigest.algorithm;
  const value = wireDigest.value;
  assert.ok(
    algorithm === "sha-256" ||
      algorithm === "sha-384" ||
      algorithm === "sha-512",
    "Context Profile fixture digest algorithm must be a WFPP algorithm",
  );
  assert.ok(
    typeof value === "string" && value.length > 0,
    "Context Profile fixture digest value must be a non-empty string",
  );
  return { context_id: contextId, version, digest: `${algorithm}:${value}` };
}

function requiredAudience(
  bundle: JsonObject,
  field: "actor_ids" | "endpoint_ids",
): readonly string[] {
  const visibility = bundle.visibility_scope;
  assert.ok(
    isJsonObject(visibility),
    "Context Profile fixture visibility_scope must be an object",
  );
  const audience = visibility[field];
  assert.ok(
    Array.isArray(audience) &&
      audience.length > 0 &&
      audience.every((value) => typeof value === "string"),
    `Context Profile fixture ${field} must declare an audience`,
  );
  return audience;
}

function unknownValue(prefix: string, existing: readonly string[]): string {
  let candidate = prefix;
  while (existing.includes(candidate)) {
    candidate += "_other";
  }
  return candidate;
}

async function assertContextUnavailable(
  adapter: ContextRepository,
  request: ContextAccessRequest,
  scenario: string,
): Promise<void> {
  assert.equal(
    (await adapter.checkAvailability(structuredClone(request))).kind,
    "unavailable",
    `expected unavailable Context for ${scenario}`,
  );
}

export async function verifyIdentityProfile(
  adapter: IdentityProvider,
  fixtures: IdentityProfileFixtures,
): Promise<void> {
  assertProfile(adapter, "exchange.identity.v1", IDENTITY_REQUIRED_CAPABILITIES);

  assert.deepEqual(
    await adapter.resolve(structuredClone(fixtures.known_evidence)),
    fixtures.expected_principal,
  );
  assert.equal(
    await adapter.resolve(structuredClone(fixtures.unknown_evidence)),
    null,
  );
}

export async function verifyAuthorityProfile(
  adapter: AuthorityPolicy,
  fixtures: AuthorityProfileFixtures,
): Promise<void> {
  assertProfile(
    adapter,
    "exchange.authority.v1",
    AUTHORITY_REQUIRED_CAPABILITIES,
  );

  assert.equal(
    (await adapter.authorize(structuredClone(fixtures.allowed_request))).kind,
    "allow",
  );
  assert.equal(
    (await adapter.authorize(structuredClone(fixtures.denied_request))).kind,
    "deny",
  );
}

export async function verifyTargetEligibilityProfile(
  adapter: TargetEligibilityVerifier,
  fixtures: TargetEligibilityProfileFixtures,
): Promise<void> {
  assertProfile(
    adapter,
    "exchange.target-eligibility.v1",
    TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES,
  );

  assert.deepEqual(
    await adapter.verify(structuredClone(fixtures.eligible_request)),
    { kind: "eligible" },
  );
  assert.equal(
    (await adapter.verify(structuredClone(fixtures.ineligible_request))).kind,
    "ineligible",
  );
  assert.equal(
    (await adapter.verify(structuredClone(fixtures.unavailable_request))).kind,
    "unavailable",
  );
}

export async function verifyContextProfile(
  adapter: ContextRepository,
  fixtures: ContextProfileFixtures,
): Promise<void> {
  assertProfile(adapter, "exchange.context.v1", CONTEXT_REQUIRED_CAPABILITIES);

  const bundle = structuredClone(fixtures.bundle);
  const expectedReference = expectedContextReference(bundle);
  const reference = await adapter.putBundle(fixtures.tenant_id, bundle);
  assert.deepEqual(
    reference,
    expectedReference,
    "putBundle returned a non-canonical Context reference",
  );
  assert.deepEqual(
    await adapter.putBundle(fixtures.tenant_id, structuredClone(fixtures.bundle)),
    reference,
  );
  const bodyVariant = structuredClone(fixtures.bundle);
  assert.ok(
    isJsonObject(bodyVariant.extensions),
    "Context Profile fixture extensions must be an object",
  );
  const bodyVariantWithExtension: JsonObject = {
    ...bodyVariant,
    extensions: {
      ...bodyVariant.extensions,
      "work-fabric.test/conformance_variant": true,
    },
  };
  await assert.rejects(
    adapter.putBundle(fixtures.tenant_id, bodyVariantWithExtension),
  );
  const allowedRequest: ContextAccessRequest = {
    ...structuredClone(fixtures.allowed_request),
    tenant_id: fixtures.tenant_id,
    reference,
  };
  assert.deepEqual(
    await adapter.checkAvailability({
      ...allowedRequest,
      reference: null,
    }),
    { kind: "available" },
  );
  assert.deepEqual(
    await adapter.checkAvailability(structuredClone(allowedRequest)),
    { kind: "available" },
  );
  await assertContextUnavailable(
    adapter,
    {
      ...structuredClone(fixtures.denied_request),
      tenant_id: fixtures.tenant_id,
      reference,
    },
    "fixture visibility denial",
  );
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      tenant_id: unknownValue("tenant_conformance_unknown", [fixtures.tenant_id]),
    },
    "unknown tenant",
  );
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      reference: {
        ...reference,
        context_id: unknownValue("context_conformance_unknown", [
          reference.context_id,
        ]),
      },
    },
    "unknown Context ID",
  );
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      reference: { ...reference, version: reference.version + 1 },
    },
    "unknown Context version",
  );
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      reference: { ...reference, digest: "conformance:digest-mismatch" },
    },
    "digest mismatch",
  );

  const actorIds = requiredAudience(bundle, "actor_ids");
  const endpointIds = requiredAudience(bundle, "endpoint_ids");
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      actor_id: unknownValue("actor_conformance_unknown", actorIds),
    },
    "Actor visibility",
  );
  await assertContextUnavailable(
    adapter,
    {
      ...allowedRequest,
      endpoint_id: unknownValue("endpoint_conformance_unknown", endpointIds),
    },
    "Endpoint visibility",
  );
}

export async function verifySignalProfile(
  adapter: SignalAdapter,
  fixtures: SignalProfileFixtures,
): Promise<void> {
  assertProfile(adapter, "exchange.signal.v1", SIGNAL_REQUIRED_CAPABILITIES);

  const eventBefore = structuredClone(fixtures.event);
  const acceptedDestinationBefore = structuredClone(fixtures.accepted_destination);
  const retryableDestinationBefore = structuredClone(fixtures.retryable_destination);
  const permanentDestinationBefore = structuredClone(fixtures.permanent_destination);
  assert.equal(
    (
      await adapter.deliver(
        fixtures.event,
        fixtures.accepted_destination,
      )
    ).kind,
    "accepted",
  );
  assert.equal(
    (
      await adapter.deliver(
        fixtures.event,
        fixtures.retryable_destination,
      )
    ).kind,
    "retryable_failure",
  );
  assert.equal(
    (
      await adapter.deliver(
        fixtures.event,
        fixtures.permanent_destination,
      )
    ).kind,
    "permanent_failure",
  );
  assert.deepEqual(fixtures.event, eventBefore);
  assert.equal(fixtures.event.id, eventBefore.id);
  assert.deepEqual(fixtures.accepted_destination, acceptedDestinationBefore);
  assert.deepEqual(fixtures.retryable_destination, retryableDestinationBefore);
  assert.deepEqual(fixtures.permanent_destination, permanentDestinationBefore);

  const observedDeliveries = await fixtures.observe_deliveries();
  assert.equal(
    observedDeliveries.length,
    3,
    "expected exactly three observed Signal deliveries",
  );
  const expectedDestinationIds = [
    fixtures.accepted_destination.destination_id,
    fixtures.retryable_destination.destination_id,
    fixtures.permanent_destination.destination_id,
  ];
  for (const [index, delivery] of observedDeliveries.entries()) {
    assert.equal(
      delivery.event.id,
      fixtures.event.id,
      `observed Signal delivery ${index + 1} did not preserve Event ID`,
    );
    assert.equal(
      delivery.destination.destination_id,
      expectedDestinationIds[index],
      `observed Signal delivery ${index + 1} did not preserve Destination ID`,
    );
  }
}
