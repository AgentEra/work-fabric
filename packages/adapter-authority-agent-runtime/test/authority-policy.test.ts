import { describe, expect, it, vi } from "vitest";

import type {
  AuthorityRequest,
  HandoffReadModel,
  HandoffReadModelStore,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

import {
  AgentRuntimeAuthorityPolicy,
  type AgentRuntimeAuthorityGrant,
} from "../src/index.js";

const grant: AgentRuntimeAuthorityGrant = {
  tenant_id: "tenant-local",
  principal_id: "principal-intake-agent",
  actor_id: "actor-intake-agent",
  endpoint_id: "endpoint-intake-agent",
  subscription_id: "subscription-intake-agent",
};

const principal: ResolvedPrincipal = {
  principal_id: grant.principal_id,
  tenant_id: grant.tenant_id,
  actor_claims: [{
    actor_id: grant.actor_id,
    actor_type: "agent",
    endpoint_ids: [grant.endpoint_id],
  }],
  attributes: {},
};

function request(overrides: Partial<AuthorityRequest> = {}): AuthorityRequest {
  return {
    principal,
    actor_id: grant.actor_id,
    actor_type: "agent",
    endpoint_id: grant.endpoint_id,
    delegation_id: null,
    action: "workfabric.query.handoff.read.v1",
    resource_id: "handoff-targeted",
    correlation_id: "correlation-runtime",
    idempotency_key: "runtime-command",
    ...overrides,
  };
}

function state(id: string, overrides: Record<string, unknown> = {}): HandoffReadModel["state"] {
  return {
    handoff_id: id,
    thread_id: `thread:${id}`,
    resource_version: 1,
    lifecycle_state: "offered",
    initiator: { actor_id: "actor-initiator", actor_type: "human" },
    recipient: null,
    verifier: { actor_id: "actor-verifier", actor_type: "human" },
    current_responsible_actor: null,
    target_binding: null,
    package: {
      work_reference: { uri: "urn:work:item:1" },
      target: { actor_id: grant.actor_id },
      intent: [],
      context: null,
      authority_scope: {
        delegation_id: "delegation-runtime",
        scopes: [],
        resource_refs: [],
        expires_at: "2026-07-20T01:00:00.000Z",
        may_redelegate: false,
      },
      acceptance_criteria: [],
      verifier: { actor_id: "actor-verifier", actor_type: "human" },
      priority: "normal",
      accept_by: "2026-07-20T01:00:00.000Z",
      result_due_at: "2026-07-20T02:00:00.000Z",
    },
    result: null,
    parent_handoff_id: null,
    child_handoff_id: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function packageFor(id: string): Record<string, unknown> {
  const candidate = state(id).package;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("expected package fixture");
  return candidate as Record<string, unknown>;
}

function handoff(id: string, handoffState: HandoffReadModel["state"] = state(id), tenantId = grant.tenant_id): HandoffReadModel {
  return {
    tenant_id: tenantId,
    partition_id: `handoff:${id}`,
    handoff_id: id,
    stream_version: 1,
    state: handoffState,
    latest_status: null,
  };
}

function targetedSnapshot(id: string, target: Pick<AgentRuntimeAuthorityGrant, "actor_id" | "endpoint_id"> = grant): HandoffReadModel {
  return handoff(id, state(id, { package: { ...packageFor(id), target: { actor_id: target.actor_id } } }));
}

function acceptedSnapshot(id: string): HandoffReadModel {
  return handoff(id, state(id, {
    lifecycle_state: "accepted",
    package: { ...packageFor(id), target: { endpoint_id: grant.endpoint_id } },
    target_binding: null,
    recipient: { actor_id: grant.actor_id, actor_type: "agent" },
    current_responsible_actor: { actor_id: grant.actor_id, actor_type: "agent" },
  }));
}

function initiatedCapabilitySnapshot(
  id: string,
  lifecycle_state: "target_resolution_pending" | "offered" | "result_returned" =
    "target_resolution_pending",
): HandoffReadModel {
  return handoff(id, state(id, {
    lifecycle_state,
    initiator: { actor_id: grant.actor_id, actor_type: "agent" },
    current_responsible_actor:
      lifecycle_state === "result_returned"
        ? null
        : { actor_id: grant.actor_id, actor_type: "agent" },
    package: {
      ...packageFor(id),
      target: {
        capability_requirement: {
          capability_id: "feishu.document.create",
          version_constraint: "1.0.0",
          assignment_mode: "external_resolution",
          constraints: {},
        },
      },
    },
  }));
}

function claimableSnapshot(id: string): HandoffReadModel {
  return handoff(id, state(id, {
    lifecycle_state: "claimable",
    package: {
      ...packageFor(id),
      target: {
        capability_requirement: {
          capability_ids: ["capability.requirements.intake"],
        },
      },
    },
  }));
}

function claimedSnapshot(id: string): HandoffReadModel {
  return handoff(id, state(id, {
    lifecycle_state: "claimed",
    package: {
      ...packageFor(id),
      target: {
        capability_requirement: {
          capability_ids: ["capability.requirements.intake"],
        },
      },
    },
    active_claim: {
      claim_id: "claim-runtime",
      actor: { actor_id: grant.actor_id, actor_type: "agent" },
      endpoint_id: grant.endpoint_id,
      fencing_token: 1,
      heartbeat_sequence: 0,
      accepted_lease_seconds: 60,
      expires_at: "2026-07-20T00:01:00.000Z",
      renew_after: "2026-07-20T00:00:40.000Z",
    },
    claim_fencing_token: 1,
  }));
}

function store(models: readonly HandoffReadModel[] = []): HandoffReadModelStore {
  const byId = new Map(models.map((model) => [model.handoff_id, model]));
  return {
    getHandoff: vi.fn(async (id: string) => byId.get(id) ?? null),
  } as unknown as HandoffReadModelStore;
}

describe("AgentRuntimeAuthorityPolicy", () => {
  it("authorizes a configured system runtime through target, accept, status, and Result", async () => {
    const systemGrant = {
      ...grant,
      principal_id: "principal-github-citizen",
      actor_id: "citizen-github-provider",
      actor_type: "system" as const,
      endpoint_id: "endpoint-github-provider",
      subscription_id: "subscription-github-provider",
    };
    const systemPrincipal: ResolvedPrincipal = {
      principal_id: systemGrant.principal_id,
      tenant_id: systemGrant.tenant_id,
      actor_claims: [{
        actor_id: systemGrant.actor_id,
        actor_type: "system",
        endpoint_ids: [systemGrant.endpoint_id],
      }],
      attributes: {},
    };
    const offered = handoff("handoff-system-offered", state("handoff-system-offered", {
      package: {
        ...packageFor("handoff-system-offered"),
        target: { endpoint_id: systemGrant.endpoint_id },
      },
    }));
    const accepted = handoff("handoff-system-accepted", state("handoff-system-accepted", {
      lifecycle_state: "accepted",
      package: {
        ...packageFor("handoff-system-accepted"),
        target: { endpoint_id: systemGrant.endpoint_id },
      },
      recipient: { actor_id: systemGrant.actor_id, actor_type: "system" },
      current_responsible_actor: {
        actor_id: systemGrant.actor_id,
        actor_type: "system",
      },
    }));
    const policy = new AgentRuntimeAuthorityPolicy(
      [systemGrant],
      store([offered, accepted]),
    );
    const systemRequest = (
      action: string,
      resource_id: string,
    ): AuthorityRequest => ({
      ...request(),
      principal: systemPrincipal,
      actor_id: systemGrant.actor_id,
      actor_type: "system",
      endpoint_id: systemGrant.endpoint_id,
      action,
      resource_id,
    });

    await expect(policy.authorize(systemRequest(
      "workfabric.endpoint.session.open.v1",
      systemGrant.endpoint_id,
    ))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(systemRequest(
      "workfabric.handoff.accept.v1",
      offered.handoff_id,
    ))).resolves.toEqual({ kind: "allow" });
    for (const action of [
      "workfabric.handoff.report_status.v1",
      "workfabric.handoff.return_result.v1",
    ]) {
      await expect(policy.authorize(systemRequest(
        action,
        accepted.handoff_id,
      ))).resolves.toEqual({ kind: "allow" });
    }
  });

  it("rejects human runtime grants", () => {
    expect(() => new AgentRuntimeAuthorityPolicy([
      { ...grant, actor_type: "human" } as unknown as AgentRuntimeAuthorityGrant,
    ], store())).toThrow("authority grants");
  });

  it("allows only the configured Principal to manage its own Runtime edge", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store());

    await expect(policy.authorize(request({
      action: "workfabric.endpoint.session.open.v1",
      resource_id: grant.endpoint_id,
    }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      endpoint_id: "endpoint-other",
      action: "workfabric.endpoint.session.open.v1",
      resource_id: grant.endpoint_id,
    }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({
      action: "workfabric.endpoint.claim-pool.read.v1",
      resource_id: grant.endpoint_id,
    }))).resolves.toEqual({ kind: "allow" });
  });

  it("allows only bounded sessions under its own Endpoint", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store());

    for (const action of [
      "workfabric.endpoint.session.heartbeat.v1",
      "workfabric.endpoint.session.close.v1",
    ]) {
      await expect(policy.authorize(request({
        action,
        resource_id: `${grant.endpoint_id}/session-runtime`,
      }))).resolves.toEqual({ kind: "allow" });
    }
    for (const resource_id of [grant.endpoint_id, `${grant.endpoint_id}/`, `${grant.endpoint_id}/a/b`, "endpoint-other/session-runtime"]) {
      await expect(policy.authorize(request({
        action: "workfabric.endpoint.session.heartbeat.v1",
        resource_id,
      }))).resolves.toMatchObject({ kind: "deny" });
    }
  });

  it("allows only the configured Subscription", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store());

    for (const action of [
      "workfabric.subscription.read.v1",
      "workfabric.subscription.manage.v1",
      "workfabric.subscription.stream.v1",
      "workfabric.subscription.ack.v1",
    ]) {
      await expect(policy.authorize(request({ action, resource_id: grant.subscription_id }))).resolves.toEqual({ kind: "allow" });
    }
    await expect(policy.authorize(request({
      action: "workfabric.subscription.read.v1",
      resource_id: `${grant.subscription_id}-other`,
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("permits a registered Runtime to request bounded Context content while repository audience remains authoritative", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store());

    await expect(policy.authorize(request({
      action: "workfabric.context.content.read.v1",
      resource_id: "context_feishu_01",
    }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      action: "workfabric.context.content.read.v1",
      resource_id: "",
    }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({
      action: "workfabric.context.content.read.v1",
      resource_id: "context_feishu_01",
      delegation_id: "forged-delegation",
    }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({
      action: "workfabric.context.content.read.v1",
      resource_id: "context_feishu_01",
      principal: { ...principal, actor_claims: [] },
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("allows an Agent to resolve and track only its own auxiliary Capability Handoff", async () => {
    const pending = initiatedCapabilitySnapshot("handoff-aux-pending");
    const offered = initiatedCapabilitySnapshot("handoff-aux-offered", "offered");
    const terminal = initiatedCapabilitySnapshot(
      "handoff-aux-terminal",
      "result_returned",
    );
    const policy = new AgentRuntimeAuthorityPolicy(
      [grant],
      store([pending, offered, terminal]),
    );

    await expect(policy.authorize(request({
      action: "workfabric.handoff.resolve_target.v1",
      resource_id: pending.handoff_id,
    }))).resolves.toEqual({ kind: "allow" });
    for (const snapshot of [pending, offered, terminal]) {
      await expect(policy.authorize(request({
        action: "workfabric.query.handoff.read.v1",
        resource_id: snapshot.handoff_id,
      }))).resolves.toEqual({ kind: "allow" });
    }
    await expect(policy.authorize(request({
      action: "workfabric.handoff.resolve_target.v1",
      resource_id: offered.handoff_id,
    }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({
      action: "workfabric.handoff.return_result.v1",
      resource_id: pending.handoff_id,
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("does not resolve another initiator's Capability Handoff", async () => {
    const pending = handoff(
      "handoff-aux-other",
      state("handoff-aux-other", {
        lifecycle_state: "target_resolution_pending",
        package: {
          ...packageFor("handoff-aux-other"),
          target: {
            capability_requirement: {
              capability_id: "feishu.document.create",
              version_constraint: "1.0.0",
              assignment_mode: "external_resolution",
              constraints: {},
            },
          },
        },
      }),
    );
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([pending]));

    await expect(policy.authorize(request({
      action: "workfabric.handoff.resolve_target.v1",
      resource_id: pending.handoff_id,
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("allows Handoff reads and acceptance only when the snapshot targets the Agent", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([
      targetedSnapshot("handoff-targeted"),
      targetedSnapshot("handoff-other", { actor_id: "actor-other", endpoint_id: "endpoint-other" }),
    ]));

    await expect(policy.authorize(request({ resource_id: "handoff-targeted" }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      action: "workfabric.handoff.accept.v1",
      resource_id: "handoff-targeted",
    }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      action: "workfabric.handoff.accept.v1",
      resource_id: "handoff-other",
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("allows targeted commands only while the Handoff is offered", async () => {
    const nonOffered = handoff("handoff-targeted-accepted", state("handoff-targeted-accepted", {
      lifecycle_state: "accepted",
      package: { ...packageFor("handoff-targeted-accepted"), target: { actor_id: grant.actor_id } },
      recipient: { actor_id: "actor-other", actor_type: "agent" },
      current_responsible_actor: { actor_id: "actor-other", actor_type: "agent" },
    }));
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([nonOffered]));

    await expect(policy.authorize(request({ resource_id: nonOffered.handoff_id }))).resolves.toEqual({ kind: "allow" });
    for (const action of ["workfabric.handoff.accept.v1", "workfabric.handoff.decline.v1"]) {
      await expect(policy.authorize(request({ action, resource_id: nonOffered.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
    }
  });

  it("allows an Agent to claim a capability pool and only the active Claim holder to manage it", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([
      claimableSnapshot("handoff-claimable"),
      claimedSnapshot("handoff-claimed"),
    ]));

    await expect(policy.authorize(request({
      action: "workfabric.handoff.claim.v1",
      resource_id: "handoff-claimable",
    }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      action: "workfabric.query.handoff.read.v1",
      resource_id: "handoff-claimed",
    }))).resolves.toEqual({ kind: "allow" });
    for (const action of [
      "workfabric.handoff.renew_claim.v1",
      "workfabric.handoff.release_claim.v1",
      "workfabric.handoff.accept.v1",
    ]) {
      await expect(policy.authorize(request({
        action,
        resource_id: "handoff-claimed",
      }))).resolves.toEqual({ kind: "allow" });
    }
  });

  it("does not grant Claim-holder commands to another Runtime or expose recovery expiry", async () => {
    const otherGrant = {
      ...grant,
      principal_id: "principal-other",
      actor_id: "actor-other",
      endpoint_id: "endpoint-other",
      subscription_id: "subscription-other",
    };
    const policy = new AgentRuntimeAuthorityPolicy([otherGrant], store([
      claimableSnapshot("handoff-claimable"),
      claimedSnapshot("handoff-claimed"),
    ]));
    const otherPrincipal: ResolvedPrincipal = {
      principal_id: otherGrant.principal_id,
      tenant_id: otherGrant.tenant_id,
      actor_claims: [{
        actor_id: otherGrant.actor_id,
        actor_type: "agent",
        endpoint_ids: [otherGrant.endpoint_id],
      }],
      attributes: {},
    };
    const otherRequest = (action: string, resource_id: string): AuthorityRequest => request({
      principal: otherPrincipal,
      actor_id: otherGrant.actor_id,
      endpoint_id: otherGrant.endpoint_id,
      action,
      resource_id,
    });

    await expect(policy.authorize(otherRequest(
      "workfabric.handoff.claim.v1",
      "handoff-claimable",
    ))).resolves.toEqual({ kind: "allow" });
    for (const action of [
      "workfabric.query.handoff.read.v1",
      "workfabric.handoff.renew_claim.v1",
      "workfabric.handoff.release_claim.v1",
      "workfabric.handoff.accept.v1",
      "workfabric.handoff.expire_claim.v1",
    ]) {
      await expect(policy.authorize(otherRequest(action, "handoff-claimed"))).resolves.toMatchObject({ kind: "deny" });
    }
  });

  it("allows status, Result, and terminal reads only for the accepted responsible Actor", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([acceptedSnapshot("handoff-accepted")]));

    for (const action of [
      "workfabric.query.handoff.read.v1",
      "workfabric.handoff.report_status.v1",
      "workfabric.handoff.return_result.v1",
    ]) {
      await expect(policy.authorize(request({ action, resource_id: "handoff-accepted" }))).resolves.toEqual({ kind: "allow" });
    }
    await expect(policy.authorize(request({
      action: "workfabric.handoff.return_result.v1",
      resource_id: "handoff-unassigned",
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("allows responsible commands only while the Handoff is accepted", async () => {
    const terminal = handoff("handoff-responsible-terminal", state("handoff-responsible-terminal", {
      lifecycle_state: "result_returned",
      package: { ...packageFor("handoff-responsible-terminal"), target: { actor_id: "actor-other" } },
      recipient: { actor_id: grant.actor_id, actor_type: "agent" },
      current_responsible_actor: { actor_id: grant.actor_id, actor_type: "agent" },
    }));
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([terminal]));

    await expect(policy.authorize(request({ resource_id: terminal.handoff_id }))).resolves.toEqual({ kind: "allow" });
    for (const action of ["workfabric.handoff.report_status.v1", "workfabric.handoff.return_result.v1"]) {
      await expect(policy.authorize(request({ action, resource_id: terminal.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
    }
  });

  it("allows a previously accepted recipient to read a terminal Handoff without granting further commands", async () => {
    const terminal = handoff("handoff-terminal", state("handoff-terminal", {
      package: { ...packageFor("handoff-terminal"), target: { actor_id: "actor-other" } },
      recipient: { actor_id: grant.actor_id, actor_type: "agent" },
      current_responsible_actor: null,
      lifecycle_state: "closed",
    }));
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([terminal]));

    await expect(policy.authorize(request({ resource_id: terminal.handoff_id }))).resolves.toEqual({ kind: "allow" });
    await expect(policy.authorize(request({
      action: "workfabric.handoff.return_result.v1",
      resource_id: terminal.handoff_id,
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("fails closed for a mismatched tenant, unrepresented Actor, malformed Handoff, and store failures", async () => {
    const crossTenant = targetedSnapshot("handoff-cross-tenant");
    const malformed = handoff("handoff-malformed", { package: null });
    const failingStore = store([crossTenant, malformed]);
    (failingStore.getHandoff as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "handoff-store-failure") throw new Error("store unavailable");
      return id === crossTenant.handoff_id
        ? { ...crossTenant, tenant_id: "tenant-other" }
        : id === malformed.handoff_id ? malformed : null;
    });
    const policy = new AgentRuntimeAuthorityPolicy([grant], failingStore);
    const unknown = await policy.authorize(request({ resource_id: "handoff-unknown" }));

    for (const input of [
      request({ principal: { ...principal, tenant_id: "tenant-other" } }),
      request({ principal: { ...principal, actor_claims: [] } }),
      request({ resource_id: "handoff-cross-tenant" }),
      request({ resource_id: "handoff-malformed" }),
      request({ resource_id: "handoff-store-failure" }),
      request({ resource_id: null }),
      request({ action: "workfabric.handoff.offer.v1" }),
    ]) {
      await expect(policy.authorize(input)).resolves.toEqual(unknown);
    }
  });

  it("denies a projection whose Handoff identity and state are inherited from its prototype", async () => {
    const prototypeBacked = Object.create(targetedSnapshot("handoff-prototype")) as HandoffReadModel;
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([prototypeBacked]));

    await expect(policy.authorize(request({ resource_id: "handoff-prototype" }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({
      action: "workfabric.handoff.accept.v1",
      resource_id: "handoff-prototype",
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies a read model with a custom prototype even when every field is own data", async () => {
    const model = Object.assign(Object.create({ untrusted: true }), targetedSnapshot("handoff-custom-prototype")) as HandoffReadModel;
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([model]));

    await expect(policy.authorize(request({ resource_id: model.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies a dual-discriminator target even when one discriminator matches", async () => {
    const malformed = handoff("handoff-dual-target", state("handoff-dual-target", {
      package: {
        ...packageFor("handoff-dual-target"),
        target: { actor_id: grant.actor_id, endpoint_id: "endpoint-other" },
      },
    }));
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([malformed]));

    await expect(policy.authorize(request({ resource_id: malformed.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({ action: "workfabric.handoff.accept.v1", resource_id: malformed.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies malformed recipient shapes and model-state identity mismatches", async () => {
    const malformedRecipient = handoff("handoff-malformed-recipient", state("handoff-malformed-recipient", {
      lifecycle_state: "accepted",
      recipient: { actor_id: grant.actor_id },
      current_responsible_actor: { actor_id: grant.actor_id, actor_type: "agent" },
    }));
    const mismatchedState = handoff("handoff-model-id", state("handoff-state-id"));
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([malformedRecipient, mismatchedState]));

    await expect(policy.authorize(request({ action: "workfabric.handoff.report_status.v1", resource_id: malformedRecipient.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
    await expect(policy.authorize(request({ resource_id: mismatchedState.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies a state with accessor-backed recipient data", async () => {
    const accessorState = structuredClone(acceptedSnapshot("handoff-accessor").state) as Record<string, unknown>;
    Object.defineProperty(accessorState, "recipient", {
      enumerable: true,
      get() { return { actor_id: grant.actor_id, actor_type: "agent" }; },
    });
    const model = handoff("handoff-accessor", accessorState as HandoffReadModel["state"]);
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([model]));

    await expect(policy.authorize(request({
      action: "workfabric.handoff.report_status.v1",
      resource_id: model.handoff_id,
    }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies a read model with a non-object latest status", async () => {
    const model = { ...targetedSnapshot("handoff-primitive-status"), latest_status: "invalid" } as unknown as HandoffReadModel;
    const policy = new AgentRuntimeAuthorityPolicy([grant], store([model]));

    await expect(policy.authorize(request({ resource_id: model.handoff_id }))).resolves.toMatchObject({ kind: "deny" });
  });

  it("does not derive authority from Capability declarations", async () => {
    const policy = new AgentRuntimeAuthorityPolicy([], store([targetedSnapshot("handoff-targeted")]));

    await expect(policy.authorize(request({
      principal: {
        ...principal,
        attributes: { capabilities: ["workfabric.handoff.accept.v1"] },
      },
      action: "workfabric.handoff.accept.v1",
    }))).resolves.toMatchObject({ kind: "deny" });
  });
});
