import { describe, expect, it, vi } from "vitest";

import type {
  DocumentAccessAuthorizer,
  DocumentPlacementResolver,
} from "@work-fabric/document-provider-spi";

import {
  FeishuCapabilityExecutor,
  MemoryFeishuProviderStore,
  type FeishuCapabilityBackend,
} from "../src/index.js";

function backend(): FeishuCapabilityBackend {
  return {
    sendMessage: vi.fn(),
    createDocument: vi.fn(async () => ({
      document_token: "doc-created",
      url: "https://feishu.example/docx/doc-created",
      title: "项目需求",
      revision: "1",
    })),
    readDocument: vi.fn(async () => ({
      document_token: "doc-existing",
      title: "已有文档",
      content: { media_type: "text/plain" as const, text: "正文" },
      revision: "4",
    })),
    replaceDocument: vi.fn(),
    appendDocument: vi.fn(),
    deleteDocument: vi.fn(async () => ({
      document_token: "doc-existing",
      deleted_at: "2026-07-28T10:30:00.000Z",
    })),
  };
}

function request(
  capabilityId: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-original-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-child-1",
    delegation_scopes: [
      "document:read",
      "document:write",
      "document:delete",
    ],
    delegation_expires_at: "2026-07-28T12:00:00.000Z",
    invocation_id: `invocation-${idempotencyKey}`,
    idempotency_key: idempotencyKey,
    capability_id: capabilityId,
    input,
    authority: {
      allowed_target_refs: [],
      confirmation_proof_refs: ["proof-delete-1"],
    },
  };
}

function fixture(input: {
  access?: DocumentAccessAuthorizer;
  placement?: DocumentPlacementResolver;
} = {}) {
  const api = backend();
  const store = new MemoryFeishuProviderStore();
  const access = input.access ?? {
    authorize: vi.fn(async () => ({
      decision: "allow" as const,
      evidence_ref: "acl-evidence-1",
      valid_until: "2026-07-28T11:00:00.000Z",
    })),
  };
  const placement = input.placement ?? {
    resolve: vi.fn(async () => ({
      resource_uri: "feishu://drive/folder/fld-project",
    })),
  };
  const confirmation = {
    consume: vi.fn(async () => true),
  };
  return {
    api,
    store,
    access,
    placement,
    confirmation,
    executor: new FeishuCapabilityExecutor({
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      backend: api,
      executions: store,
      ownership: store,
      confirmation,
      targets: {
        async resolveCurrentConversation() {
          return { kind: "chat_id" as const, id: "chat-1" };
        },
      },
      document_access: access,
      placement,
      now: () => "2026-07-28T10:00:00.000Z",
    }),
  };
}

describe("delegated document access enforcement", () => {
  it("resolves usage-owned placement and authorizes the container before create", async () => {
    const value = fixture();

    await expect(value.executor.execute(request(
      "feishu.document.create",
      {
        title: "项目需求",
        content: { media_type: "text/plain", text: "正文" },
        placement: {
          policy_ref: "customer.project.requirements.default",
        },
      },
      "create-1",
    ))).resolves.toMatchObject({ outcome: "succeeded" });

    expect(value.placement.resolve).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-child-1",
      placement: {
        policy_ref: "customer.project.requirements.default",
      },
      signal: undefined,
    });
    expect(value.access.authorize).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-child-1",
      operation: "create",
      resource: {
        resource_uri: "feishu://drive/folder/fld-project",
      },
      scopes: [
        "document:read",
        "document:write",
        "document:delete",
      ],
      expires_at: "2026-07-28T12:00:00.000Z",
    }, undefined);
    expect(value.api.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: {
          resource_uri: "feishu://drive/folder/fld-project",
        },
      }),
    );
  });

  it("denies before a vendor call even for a Provider-owned document", async () => {
    const access: DocumentAccessAuthorizer = {
      authorize: vi.fn(async () => ({
        decision: "deny" as const,
        reason: "permission_denied" as const,
      })),
    };
    const value = fixture({ access });
    await value.store.putOwnership({
      tenant_id: "tenant-1",
      document_token: "doc-existing",
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      original_handoff_id: "handoff-original-1",
      initiating_actor_id: "actor-human-1",
      create_idempotency_key: "create-original",
      created_at: "2026-07-28T09:00:00.000Z",
      last_known_revision: "4",
      deleted_at: null,
    });

    await expect(value.executor.execute(request(
      "feishu.document.read",
      {
        document: { resource_uri: "feishu://docx/doc-existing" },
        max_bytes: 64_000,
      },
      "read-denied",
    ))).resolves.toMatchObject({
      outcome: "rejected",
      code: "authority_denied",
    });

    expect(access.authorize).toHaveBeenCalledTimes(1);
    expect(value.api.readDocument).not.toHaveBeenCalled();
  });

  it("fails closed when native authorization is unavailable", async () => {
    const access: DocumentAccessAuthorizer = {
      authorize: vi.fn(async () => {
        throw new Error("identity broker unavailable");
      }),
    };
    const value = fixture({ access });

    await expect(value.executor.execute(request(
      "feishu.document.read",
      {
        document: { resource_uri: "feishu://docx/doc-existing" },
        max_bytes: 64_000,
      },
      "read-unavailable",
    ))).resolves.toMatchObject({
      outcome: "failed",
      code: "document_authorization_unavailable",
      retryable: true,
    });
    expect(value.api.readDocument).not.toHaveBeenCalled();
  });

  it("rejects an unsupported resource scheme before authorization or backend access", async () => {
    const value = fixture();

    await expect(value.executor.execute(request(
      "feishu.document.read",
      {
        document: { resource_uri: "notion://page/page-existing" },
        max_bytes: 64_000,
      },
      "read-unsupported-resource",
    ))).resolves.toMatchObject({
      outcome: "failed",
      code: "unsupported_resource_type",
      retryable: false,
    });

    expect(value.access.authorize).not.toHaveBeenCalled();
    expect(value.api.readDocument).not.toHaveBeenCalled();
  });

  it("rejects expired delegation and fails closed on a stale native ACL allow", async () => {
    const expiredDelegation = fixture();
    const expiredRequest = {
      ...request(
        "feishu.document.read",
        {
          document: { resource_uri: "feishu://docx/doc-existing" },
          max_bytes: 64_000,
        },
        "read-expired-delegation",
      ),
      delegation_expires_at: "2026-07-28T09:59:59.000Z",
    };
    await expect(
      expiredDelegation.executor.execute(expiredRequest),
    ).resolves.toMatchObject({
      outcome: "rejected",
      code: "authority_denied",
    });
    expect(expiredDelegation.access.authorize).not.toHaveBeenCalled();
    expect(expiredDelegation.api.readDocument).not.toHaveBeenCalled();

    const staleAccess: DocumentAccessAuthorizer = {
      authorize: vi.fn(async () => ({
        decision: "allow" as const,
        evidence_ref: "stale-acl-evidence",
        valid_until: "2026-07-28T09:59:59.000Z",
      })),
    };
    const stale = fixture({ access: staleAccess });
    await expect(stale.executor.execute(request(
      "feishu.document.read",
      {
        document: { resource_uri: "feishu://docx/doc-existing" },
        max_bytes: 64_000,
      },
      "read-stale-acl",
    ))).resolves.toMatchObject({
      outcome: "failed",
      code: "document_authorization_unavailable",
      retryable: true,
    });
    expect(stale.api.readDocument).not.toHaveBeenCalled();
  });
});
