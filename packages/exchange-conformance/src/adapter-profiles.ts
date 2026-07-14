import assert from "node:assert/strict";

import {
  AUTHORITY_REQUIRED_CAPABILITIES,
  CONTEXT_REQUIRED_CAPABILITIES,
  IDENTITY_REQUIRED_CAPABILITIES,
  SIGNAL_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type AuthorityPolicy,
  type AuthorityRequest,
  type ContextAccessRequest,
  type ContextRepository,
  type ExchangeAdapter,
  type IdentityProvider,
  type JsonObject,
  type ProtocolEvent,
  type ResolvedPrincipal,
  type SignalAdapter,
  type SignalDestination,
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

export async function verifyContextProfile(
  adapter: ContextRepository,
  fixtures: ContextProfileFixtures,
): Promise<void> {
  assertProfile(adapter, "exchange.context.v1", CONTEXT_REQUIRED_CAPABILITIES);

  const bundle = structuredClone(fixtures.bundle);
  const reference = await adapter.putBundle(fixtures.tenant_id, bundle);
  assert.deepEqual(
    await adapter.putBundle(fixtures.tenant_id, structuredClone(fixtures.bundle)),
    reference,
  );
  await assert.rejects(
    adapter.putBundle(fixtures.tenant_id, {
      ...structuredClone(fixtures.bundle),
      __conformance_body_variant: true,
    }),
  );
  assert.deepEqual(
    await adapter.checkAvailability({
      ...structuredClone(fixtures.allowed_request),
      reference: null,
    }),
    { kind: "available" },
  );
  assert.deepEqual(
    await adapter.checkAvailability(structuredClone(fixtures.allowed_request)),
    { kind: "available" },
  );
  assert.equal(
    (await adapter.checkAvailability(structuredClone(fixtures.denied_request))).kind,
    "unavailable",
  );

  const allowedReference = fixtures.allowed_request.reference ?? reference;
  assert.equal(
    (
      await adapter.checkAvailability({
        ...structuredClone(fixtures.allowed_request),
        reference: {
          ...structuredClone(allowedReference),
          digest: "conformance:digest-mismatch",
        },
      })
    ).kind,
    "unavailable",
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
}
