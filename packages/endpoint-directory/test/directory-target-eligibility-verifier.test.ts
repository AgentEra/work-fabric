import { describe, expect, it } from "vitest";

import { MemoryEndpointDirectoryStore } from "@work-fabric/adapter-endpoint-memory";
import type {
  CapabilityConstraintEvaluator,
  EndpointDirectoryStore,
  EndpointRegistration,
  ResolvedPrincipal,
  TargetEligibilityRequest,
} from "@work-fabric/exchange-spi";

import {
  DirectoryTargetEligibilityVerifier,
  EndpointDirectoryService,
} from "../src/index.js";

const tenantId = "tenant_01";
const endpointId = "endpoint_01";
const actorId = "actor_01";
const principal: ResolvedPrincipal = {
  principal_id: "resolver_01",
  tenant_id: tenantId,
  actor_claims: [],
  attributes: {},
};
const capability = {
  capability_id: "software.implementation",
  version: "1.2.0",
  name: "Implementation",
  description: "Implements an explicit Handoff",
  input_media_types: ["application/json", "text/markdown"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous"] as const,
  constraints: { region: "local" },
};
const registration: EndpointRegistration = {
  endpoint_id: endpointId,
  actor: { actor_id: actorId, actor_type: "agent" },
  endpoint_type: "native_agent",
  display_name: "Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [{
    binding_type: "http_sse",
    uri: "https://runtime.example.test/wf",
    security_schemes: ["oauth2"],
  }],
  allowed_capability_ids: [capability.capability_id],
  limits: { max_inline_content_bytes: 65_536 },
  administrative_state: "enabled",
  registration_version: 1,
};

class Clock {
  current = "2026-07-15T00:00:00Z";
  now(): string { return this.current; }
}

async function fixture(
  constraintEvaluator?: CapabilityConstraintEvaluator,
): Promise<{
  verifier: DirectoryTargetEligibilityVerifier;
  clock: Clock;
  store: MemoryEndpointDirectoryStore;
}> {
  const clock = new Clock();
  const store = new MemoryEndpointDirectoryStore();
  const service = new EndpointDirectoryService({
    store,
    clock,
    ids: { sessionId: () => "session_01" },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 300,
      renew_ahead_seconds: 10,
      max_capabilities: 64,
      max_bindings: 16,
      default_page_limit: 50,
      max_page_limit: 200,
    },
  });
  await service.provision({ tenant_id: tenantId, principal_id: "admin" }, registration, null);
  await service.openSession({
    tenant_id: tenantId,
    principal_id: "runtime",
    represented_actor: registration.actor,
    represented_endpoint_id: endpointId,
  }, endpointId, {
    client_session_id: "client_01",
    protocol_version: "1.0",
    capabilities: [capability],
    availability: "available",
    requested_lease_seconds: 60,
    expected_registration_version: 1,
  });
  return {
    clock,
    store,
    verifier: new DirectoryTargetEligibilityVerifier({
      store,
      clock,
      ...(constraintEvaluator === undefined ? {} : { constraintEvaluator }),
    }),
  };
}

function request(
  proposedTarget: TargetEligibilityRequest["proposed_target"],
  requirement: TargetEligibilityRequest["requirement"] = {
    capability_id: "software.implementation",
    version_constraint: ">=1.0.0 <2.0.0",
    input_media_types: ["application/json"],
    output_media_types: ["application/json"],
  },
): TargetEligibilityRequest {
  return {
    tenant_id: tenantId,
    exchange_id: "exchange_01",
    handoff_id: "handoff_01",
    requirement,
    proposed_target: proposedTarget,
    principal,
  };
}

describe("DirectoryTargetEligibilityVerifier", () => {
  it("validates only the explicit Endpoint", async () => {
    const { verifier } = await fixture();

    await expect(verifier.verify(request({ endpoint_id: endpointId }))).resolves.toEqual({ kind: "eligible" });
    await expect(verifier.verify(request({ endpoint_id: "missing" }))).resolves.toEqual({ kind: "ineligible", reason: "endpoint_unavailable" });
  });

  it("validates an Actor without returning or persisting a selected Endpoint", async () => {
    const { verifier } = await fixture();

    await expect(verifier.verify(request({ actor_id: actorId }))).resolves.toEqual({ kind: "eligible" });
  });

  it("fails structural mismatches closed with bounded reasons", async () => {
    const { verifier } = await fixture();

    await expect(verifier.verify(request({ endpoint_id: endpointId }, {
      capability_id: "software.implementation",
      version_constraint: ">=2.0.0",
    }))).resolves.toEqual({ kind: "ineligible", reason: "capability_mismatch" });
    await expect(verifier.verify(request({ endpoint_id: endpointId }, {
      capability_id: "software.implementation",
      input_media_types: ["video/mp4"],
    }))).resolves.toEqual({ kind: "ineligible", reason: "capability_mismatch" });
  });

  it("makes lease expiry immediately ineligible", async () => {
    const { verifier, clock } = await fixture();
    clock.current = "2026-07-15T00:01:01Z";

    await expect(verifier.verify(request({ endpoint_id: endpointId }))).resolves.toEqual({ kind: "ineligible", reason: "endpoint_unavailable" });
  });

  it("does not guess unknown constraint semantics", async () => {
    const { verifier } = await fixture();

    await expect(verifier.verify(request({ endpoint_id: endpointId }, {
      capability_id: "software.implementation",
      constraints: { residency: "local" },
    }))).resolves.toEqual({ kind: "unavailable", reason: "constraint_evaluator_unavailable" });
  });

  it("uses an injected constraint evaluator without selecting candidates", async () => {
    const evaluator: CapabilityConstraintEvaluator = {
      manifest: { profile: "exchange.capability-constraint.v1", adapter: "test", capabilities: {} },
      evaluate: async () => "match",
    };
    const { verifier } = await fixture(evaluator);

    await expect(verifier.verify(request({ actor_id: actorId }, {
      capability_id: "software.implementation",
      constraints: { residency: "local" },
    }))).resolves.toEqual({ kind: "eligible" });
  });

  it("maps Directory failure to unavailable without leaking the exception", async () => {
    const { store, clock } = await fixture();
    const failing = new Proxy(store as EndpointDirectoryStore, {
      get(target, property, receiver) {
        if (property === "getProjectedEndpoint") return async () => { throw new Error("database password leaked"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const verifier = new DirectoryTargetEligibilityVerifier({ store: failing, clock });

    await expect(verifier.verify(request({ endpoint_id: endpointId }))).resolves.toEqual({ kind: "unavailable", reason: "directory_unavailable" });
  });
});
