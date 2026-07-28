import { describe, expect, it, vi } from "vitest";

import {
  BrokeredDocumentAccessAuthorizer,
  validateDocumentAccessRequest,
  validateDocumentPlacementRequest,
  validateDocumentResourceReference,
} from "../src/index.js";

describe("document provider SPI", () => {
  it("accepts vendor-neutral resource URIs and placement policy references", () => {
    expect(validateDocumentResourceReference({
      resource_uri: "feishu://docx/doc_123",
    })).toEqual({
      resource_uri: "feishu://docx/doc_123",
    });
    expect(validateDocumentPlacementRequest({
      resource_uri: "feishu://drive/folder/fld_123",
    })).toEqual({
      resource_uri: "feishu://drive/folder/fld_123",
    });
    expect(validateDocumentPlacementRequest({
      policy_ref: "customer.project.requirements.default",
    })).toEqual({
      policy_ref: "customer.project.requirements.default",
    });
  });

  it("rejects embedded credentials, ambiguous placement and vendor identity assertions", () => {
    expect(() => validateDocumentResourceReference({
      resource_uri: "https://user:secret@example.test/document/1",
    })).toThrow(/resource_uri/i);
    expect(() => validateDocumentPlacementRequest({
      resource_uri: "feishu://drive/folder/fld_123",
      policy_ref: "customer.default",
    })).toThrow(/placement/i);
    expect(() => validateDocumentAccessRequest({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      operation: "read",
      resource: { resource_uri: "feishu://docx/doc_123" },
      scopes: ["document:read"],
      expires_at: "2026-07-28T12:00:00.000Z",
      external_open_id: "ou-forbidden",
    })).toThrow(/access request/i);
  });

  it("normalizes bounded delegation facts without document ACL data", () => {
    const result = validateDocumentAccessRequest({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      operation: "update",
      resource: { resource_uri: "feishu://docx/doc_123" },
      scopes: ["document:write"],
      expires_at: "2026-07-28T12:00:00.000Z",
    });

    expect(result).toEqual({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      operation: "update",
      resource: { resource_uri: "feishu://docx/doc_123" },
      scopes: ["document:write"],
      expires_at: "2026-07-28T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /open_id|user_access_token|permission_members|credential/i,
    );
  });

  it("keeps native subject identity inside the authorization boundary", async () => {
    const resolve = vi.fn(async () => ({
      native_subject_ref: "private:feishu:ou-human-1",
      valid_until: "2026-07-28T11:30:00.000Z",
    }));
    const check = vi.fn(async () => ({
      decision: "allow" as const,
      evidence_ref: "acl-check-1",
      valid_until: "2026-07-28T11:00:00.000Z",
    }));
    const authorizer = new BrokeredDocumentAccessAuthorizer({
      subjects: { resolve },
      permissions: { check },
      now: () => "2026-07-28T10:00:00.000Z",
    });
    const input = validateDocumentAccessRequest({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      operation: "read",
      resource: { resource_uri: "feishu://docx/doc-1" },
      scopes: ["document:read"],
      expires_at: "2026-07-28T12:00:00.000Z",
    });

    await expect(authorizer.authorize(input)).resolves.toEqual({
      decision: "allow",
      evidence_ref: "acl-check-1",
      valid_until: "2026-07-28T11:00:00.000Z",
    });
    expect(resolve).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
    }, undefined);
    expect(check).toHaveBeenCalledWith({
      native_subject_ref: "private:feishu:ou-human-1",
      operation: "read",
      resource: { resource_uri: "feishu://docx/doc-1" },
    }, undefined);
    expect(JSON.stringify(await authorizer.authorize(input))).not.toContain(
      "ou-human-1",
    );
  });

  it("fails closed for expired delegation, unresolved identity, and native ACL denial", async () => {
    const base = validateDocumentAccessRequest({
      tenant_id: "tenant-1",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      operation: "read",
      resource: { resource_uri: "feishu://docx/doc-1" },
      scopes: ["document:read"],
      expires_at: "2026-07-28T12:00:00.000Z",
    });
    const expired = new BrokeredDocumentAccessAuthorizer({
      subjects: { resolve: vi.fn() },
      permissions: { check: vi.fn() },
      now: () => "2026-07-28T13:00:00.000Z",
    });
    await expect(expired.authorize(base)).resolves.toEqual({
      decision: "deny",
      reason: "delegation_invalid",
    });

    const unresolved = new BrokeredDocumentAccessAuthorizer({
      subjects: { resolve: vi.fn(async () => null) },
      permissions: { check: vi.fn() },
      now: () => "2026-07-28T10:00:00.000Z",
    });
    await expect(unresolved.authorize(base)).resolves.toEqual({
      decision: "deny",
      reason: "identity_unavailable",
    });

    const denied = new BrokeredDocumentAccessAuthorizer({
      subjects: {
        resolve: vi.fn(async () => ({
          native_subject_ref: "private:subject",
          valid_until: "2026-07-28T11:30:00.000Z",
        })),
      },
      permissions: {
        check: vi.fn(async () => ({
          decision: "deny" as const,
          evidence_ref: "acl-deny-1",
        })),
      },
      now: () => "2026-07-28T10:00:00.000Z",
    });
    await expect(denied.authorize(base)).resolves.toEqual({
      decision: "deny",
      reason: "permission_denied",
    });
  });
});
