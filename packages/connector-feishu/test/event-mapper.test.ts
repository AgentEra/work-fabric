import { describe, expect, it } from "vitest";

import type {
  ConnectorIdentityQuery,
  ConnectorIdentityResolver,
  ConnectorIngressClaim,
  ConnectorResolvedIdentity,
} from "@work-fabric/connector-spi";

import {
  FeishuActionReferenceCodec,
  FeishuEventMapper,
  FeishuIdentityMapper,
} from "../src/index.js";

const manifest = (profile: string) => ({
  profile,
  adapter: "test",
  capabilities: {},
});

function claim(
  eventType: "card.action.trigger" | "im.message.receive_v1",
  payload: Record<string, string>,
): ConnectorIngressClaim {
  return {
    ingress_id: "ingress-1",
    envelope: {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      source_system: "feishu",
      external_tenant_id: "tenant-key-1",
      external_event_id: "event-1",
      dedupe_key: "card:event-1:action-1",
      event_type: eventType,
      occurred_at: "2026-07-16T00:00:00Z",
      received_at: "2026-07-16T00:00:01Z",
      payload,
    },
    state: "processing",
    attempt: 1,
    available_at: "2026-07-16T00:00:01Z",
    accepted_at: "2026-07-16T00:00:01Z",
    updated_at: "2026-07-16T00:00:02Z",
    claim_owner: "worker-1",
    claim_token: "claim-1",
    fencing_token: 1,
    lease_expires_at: "2026-07-16T00:01:02Z",
  };
}

describe("Feishu identity and action mapping", () => {
  it("resolves only configured identities and defensively clones them", async () => {
    const identity = { actor_id: "human-1", actor_type: "agent" as const, endpoint_id: "feishu-endpoint-1" };
    const mapper = new FeishuIdentityMapper(async (query) =>
      query.external_subject_id === "ou-known" ? identity : null,
    );
    const query: ConnectorIdentityQuery = {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      source_system: "feishu",
      external_tenant_id: "tenant-key-1",
      external_subject_type: "user",
      external_subject_id: "ou-known",
    };
    const resolved = await mapper.resolve(query);
    expect(resolved).toEqual(identity);
    (identity as { actor_id: string }).actor_id = "mutated";
    expect(resolved?.actor_id).toBe("human-1");
    await expect(mapper.resolve({
      ...query,
      external_subject_id: "ou-unknown",
    })).resolves.toBeNull();
  });

  it("encrypts scoped action data and rejects tampering, expiry, or another user", () => {
    const codec = new FeishuActionReferenceCodec({
      encryption_key: new Uint8Array(32).fill(7),
      nonce_factory: () => new Uint8Array(12).fill(3),
      max_reference_length: 2_048,
    });
    const reference = codec.issue({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      identity: { actor_id: "human-1", actor_type: "human" as const, endpoint_id: "feishu-endpoint-1" },
      operation: "handoff.accept",
      expected_version: 4,
      input: { handoff_id: "handoff-1" },
      expires_at: "2026-07-16T00:10:00Z",
    });

    expect(reference).toMatch(/^wfaf2\./);
    expect(reference).not.toContain("handoff-1");
    expect(codec.resolve(reference, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      now: "2026-07-16T00:05:00Z",
    })).toMatchObject({
      operation: "handoff.accept",
      expected_version: 4,
      identity: { actor_type: "human" },
    });
    expect(() => codec.resolve(`${reference.slice(0, -1)}x`, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      now: "2026-07-16T00:05:00Z",
    })).toThrow(/invalid/i);
    expect(() => codec.resolve(`wfaf1.${reference.slice("wfaf2.".length)}`, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      now: "2026-07-16T00:05:00Z",
    })).toThrow(/invalid/i);
    expect(() => codec.resolve(reference, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-other",
      now: "2026-07-16T00:05:00Z",
    })).toThrow(/scope/i);
    expect(() => codec.resolve(reference, {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      now: "2026-07-16T00:10:00Z",
    })).toThrow(/expired/i);
  });

  it("rejects nonce reuse for action-reference encryption", () => {
    const codec = new FeishuActionReferenceCodec({
      encryption_key: new Uint8Array(32).fill(7),
      nonce_factory: () => new Uint8Array(12).fill(3),
    });
    const claims = {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      identity: { actor_id: "human-1", actor_type: "human" as const, endpoint_id: "feishu-endpoint-1" },
      operation: "handoff.accept",
      expected_version: 4,
      input: { handoff_id: "handoff-1" },
      expires_at: "2026-07-16T00:10:00Z",
    };
    codec.issue(claims);
    expect(() => codec.issue(claims)).toThrow(/nonce/i);
  });

  it("maps a generated card action to one explicit command", async () => {
    const codec = new FeishuActionReferenceCodec({
      encryption_key: new Uint8Array(32).fill(7),
      nonce_factory: () => new Uint8Array(12).fill(3),
      max_reference_length: 2_048,
    });
    const actionRef = codec.issue({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      identity: { actor_id: "human-1", actor_type: "human", endpoint_id: "feishu-endpoint-1" },
      operation: "handoff.accept",
      expected_version: 4,
      input: { handoff_id: "handoff-1" },
      expires_at: "2026-07-16T00:10:00Z",
    });
    const resolver: ConnectorIdentityResolver = {
      manifest: manifest("connector.identity.v1"),
      async resolve(): Promise<ConnectorResolvedIdentity> {
        return { actor_id: "human-1", actor_type: "human", endpoint_id: "feishu-endpoint-1" };
      },
    };
    const mapper = new FeishuEventMapper({
      identity_resolver: resolver,
      action_codec: codec,
      clock: { now: () => "2026-07-16T00:05:00Z" },
    });

    await expect(mapper.map(claim("card.action.trigger", {
      operator_open_id: "ou-human-1",
      action_ref: actionRef,
      message_id: "om-card-1",
      action_tag: "button",
    }))).resolves.toMatchObject({
      kind: "command",
      command: {
        operation: "handoff.accept",
        expected_version: 4,
        identity: { actor_id: "human-1", actor_type: "human", endpoint_id: "feishu-endpoint-1" },
        input: { handoff_id: "handoff-1" },
      },
    });
  });

  it("rejects an action when the external identity mapping changed after issue", async () => {
    const codec = new FeishuActionReferenceCodec({
      encryption_key: new Uint8Array(32).fill(7),
      nonce_factory: () => new Uint8Array(12).fill(4),
    });
    const actionRef = codec.issue({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      identity: { actor_id: "human-original", actor_type: "human", endpoint_id: "endpoint-original" },
      operation: "handoff.accept",
      expected_version: 4,
      input: { handoff_id: "handoff-1" },
      expires_at: "2026-07-16T00:10:00Z",
    });
    const mapper = new FeishuEventMapper({
      identity_resolver: new FeishuIdentityMapper(async () => ({
        actor_id: "human-reassigned",
        actor_type: "human",
        endpoint_id: "endpoint-reassigned",
      })),
      action_codec: codec,
      clock: { now: () => "2026-07-16T00:05:00Z" },
    });

    await expect(mapper.map(claim("card.action.trigger", {
      operator_open_id: "ou-human-1",
      action_ref: actionRef,
      message_id: "om-card-1",
      action_tag: "button",
    }))).resolves.toEqual({
      kind: "rejected",
      reason_code: "identity_mapping_changed",
      retryable: false,
    });
  });

  it("rejects an action when only the resolved actor type changed", async () => {
    const codec = new FeishuActionReferenceCodec({
      encryption_key: new Uint8Array(32).fill(7),
      nonce_factory: () => new Uint8Array(12).fill(5),
    });
    const actionRef = codec.issue({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      external_subject_id: "ou-human-1",
      identity: { actor_id: "shared-actor", actor_type: "human", endpoint_id: "shared-endpoint" },
      operation: "handoff.accept",
      expected_version: 4,
      input: { handoff_id: "handoff-1" },
      expires_at: "2026-07-16T00:10:00Z",
    });
    const mapper = new FeishuEventMapper({
      identity_resolver: new FeishuIdentityMapper(async () => ({
        actor_id: "shared-actor",
        actor_type: "agent",
        endpoint_id: "shared-endpoint",
      })),
      action_codec: codec,
      clock: { now: () => "2026-07-16T00:05:00Z" },
    });

    await expect(mapper.map(claim("card.action.trigger", {
      operator_open_id: "ou-human-1",
      action_ref: actionRef,
      message_id: "om-card-1",
      action_tag: "button",
    }))).resolves.toEqual({
      kind: "rejected",
      reason_code: "identity_mapping_changed",
      retryable: false,
    });
  });

  it("rejects an unmapped card user and ignores arbitrary chat by default", async () => {
    const resolver: ConnectorIdentityResolver = {
      manifest: manifest("connector.identity.v1"),
      async resolve() { return null; },
    };
    const mapper = new FeishuEventMapper({
      identity_resolver: resolver,
      action_codec: new FeishuActionReferenceCodec({
        encryption_key: new Uint8Array(32).fill(7),
      }),
      clock: { now: () => "2026-07-16T00:05:00Z" },
    });
    await expect(mapper.map(claim("card.action.trigger", {
      operator_open_id: "ou-unknown",
      action_ref: "opaque",
      message_id: "om-card-1",
      action_tag: "button",
    }))).resolves.toEqual({
      kind: "rejected",
      reason_code: "identity_unmapped",
      retryable: false,
    });
    await expect(mapper.map(claim("im.message.receive_v1", {
      message_id: "om-1",
      content: "please accept everything",
    }))).resolves.toEqual({
      kind: "ignored",
      reason_code: "unconfigured_message",
    });
  });
});
