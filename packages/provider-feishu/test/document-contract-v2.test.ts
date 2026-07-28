import { describe, expect, it } from "vitest";

import {
  feishuCapabilityDeclarations,
  feishuSchemaDocuments,
  normalizeFeishuInput,
} from "../src/index.js";

function request(capabilityId: string, input: Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-1",
    delegation_scopes: ["document:read", "document:write"],
    delegation_expires_at: "2026-07-28T12:00:00.000Z",
    invocation_id: "invocation-1",
    idempotency_key: "idempotency-1",
    capability_id: capabilityId,
    input,
    authority: {
      allowed_target_refs: [],
      confirmation_proof_refs: [],
    },
  };
}

describe("Feishu document Contract v2", () => {
  it("accepts opaque document resource URIs and dynamic create placement", () => {
    expect(normalizeFeishuInput(request(
      "feishu.document.create",
      {
        title: "项目需求",
        content: { media_type: "text/plain", text: "正文" },
        placement: {
          policy_ref: "customer.project.requirements.default",
        },
      },
    ))).toEqual({
      kind: "document_create",
      title: "项目需求",
      content: { media_type: "text/plain", text: "正文" },
      placement: {
        policy_ref: "customer.project.requirements.default",
      },
    });

    expect(normalizeFeishuInput(request(
      "feishu.document.read",
      {
        document: { resource_uri: "feishu://docx/doc_123" },
        max_bytes: 64_000,
      },
    ))).toEqual({
      kind: "document_read",
      document: { resource_uri: "feishu://docx/doc_123" },
      max_bytes: 64_000,
    });
  });

  it("publishes a new major Contract without identity, ACL or vendor token fields", () => {
    const declarations = feishuCapabilityDeclarations();
    expect(declarations.filter((item) =>
      item.declaration_id.startsWith("feishu.document.")
    ).every((item) => item.version === "2.0.0")).toBe(true);
    expect(declarations.find((item) =>
      item.declaration_id === "feishu.message.send"
    )?.version).toBe("1.0.0");
    const documents = feishuSchemaDocuments();
    const documentSchemaUris = declarations
      .filter((item) => item.declaration_id.startsWith("feishu.document."))
      .flatMap((item) => [item.input_schema?.uri, item.output_schema?.uri])
      .filter((uri): uri is string => uri !== undefined);
    const schemas = JSON.stringify(
      documentSchemaUris.map((uri) => documents.get(uri)),
    );
    expect(schemas).toContain("resource_uri");
    expect(schemas).toContain("policy_ref");
    expect(schemas).not.toMatch(
      /folder_token|space_id|represented_actor|delegation_id|access_token/i,
    );
  });

  it("rejects legacy document kinds and identity assertions from Agent input", () => {
    expect(() => normalizeFeishuInput(request(
      "feishu.document.read",
      {
        document: { kind: "docx", token: "doc_123" },
        max_bytes: 64_000,
      },
    ))).toThrow(/resource reference/i);
    expect(() => normalizeFeishuInput(request(
      "feishu.document.create",
      {
        title: "项目需求",
        content: { media_type: "text/plain", text: "正文" },
        represented_actor_id: "actor-forged",
      },
    ))).toThrow(/fields/i);
  });
});
