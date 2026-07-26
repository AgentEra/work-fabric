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

function handoff(id: string, state: HandoffReadModel["state"], tenantId = grant.tenant_id): HandoffReadModel {
  return {
    tenant_id: tenantId,
    partition_id: `handoff:${id}`,
    handoff_id: id,
    stream_version: 1,
    state,
    latest_status: null,
  };
}

function targetedSnapshot(id: string, target: Pick<AgentRuntimeAuthorityGrant, "actor_id" | "endpoint_id"> = grant): HandoffReadModel {
  return handoff(id, {
    package: { target: { actor_id: target.actor_id } },
    target_binding: null,
    recipient: null,
    current_responsible_actor: null,
  });
}

function acceptedSnapshot(id: string): HandoffReadModel {
  return handoff(id, {
    package: { target: { endpoint_id: grant.endpoint_id } },
    target_binding: null,
    recipient: { actor_id: grant.actor_id, actor_type: "agent" },
    current_responsible_actor: { actor_id: grant.actor_id, actor_type: "agent" },
  });
}

function store(models: readonly HandoffReadModel[] = []): HandoffReadModelStore {
  const byId = new Map(models.map((model) => [model.handoff_id, model]));
  return {
    getHandoff: vi.fn(async (id: string) => byId.get(id) ?? null),
  } as unknown as HandoffReadModelStore;
}

describe("AgentRuntimeAuthorityPolicy", () => {
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

  it("allows a previously accepted recipient to read a terminal Handoff without granting further commands", async () => {
    const terminal = handoff("handoff-terminal", {
      package: { target: { actor_id: "actor-other" } },
      target_binding: null,
      recipient: { actor_id: grant.actor_id, actor_type: "agent" },
      current_responsible_actor: null,
      lifecycle_state: "closed",
    });
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
