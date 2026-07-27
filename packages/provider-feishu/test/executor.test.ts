import { describe, expect, it, vi } from "vitest";

import {
  FeishuCapabilityExecutor,
  FeishuDocumentContextProvider,
  MemoryFeishuProviderStore,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
  type FeishuCapabilityBackend,
} from "../src/index.js";

function backend() {
  const documents = new Map<string, {
    title: string;
    text: string;
    revision: string;
  }>();
  let sequence = 0;
  const value: FeishuCapabilityBackend = {
    sendMessage: vi.fn(async (input) => ({
      message_id: `message-${++sequence}`,
      sent_at: "2026-07-27T10:00:00.000Z",
      target: input.target,
    })),
    createDocument: vi.fn(async (input) => {
      const token = `doc-${++sequence}`;
      const document = {
        title: input.title,
        text: input.content.text,
        revision: "1",
      };
      documents.set(token, document);
      return {
        document_token: token,
        url: `https://feishu.example/docx/${token}`,
        title: document.title,
        revision: document.revision,
      };
    }),
    readDocument: vi.fn(async (input) => {
      const document = documents.get(input.document_token);
      if (document === undefined) {
        const error = new Error("not found");
        Object.assign(error, { code: "document_not_found", retryable: false });
        throw error;
      }
      return {
        document_token: input.document_token,
        title: document.title,
        content: { media_type: "text/plain" as const, text: document.text },
        revision: document.revision,
      };
    }),
    replaceDocument: vi.fn(async (input) => {
      const document = documents.get(input.document_token)!;
      if (document.revision !== input.expected_revision) {
        const error = new Error("revision conflict");
        Object.assign(error, { code: "revision_conflict", retryable: false });
        throw error;
      }
      const revision = String(Number(document.revision) + 1);
      documents.set(input.document_token, {
        title: input.title ?? document.title,
        text: input.content.text,
        revision,
      });
      return {
        document_token: input.document_token,
        title: input.title ?? document.title,
        revision,
      };
    }),
    appendDocument: vi.fn(async (input) => {
      const document = documents.get(input.document_token)!;
      const revision = String(Number(document.revision) + 1);
      documents.set(input.document_token, {
        ...document,
        text: `${document.text}${input.content.text}`,
        revision,
      });
      return {
        document_token: input.document_token,
        title: document.title,
        revision,
      };
    }),
    deleteDocument: vi.fn(async (input) => {
      documents.delete(input.document_token);
      return {
        document_token: input.document_token,
        deleted_at: "2026-07-27T10:10:00.000Z",
      };
    }),
  };
  return value;
}

function executor(input: {
  backend?: FeishuCapabilityBackend;
  store?: MemoryFeishuProviderStore;
} = {}) {
  const store = input.store ?? new MemoryFeishuProviderStore();
  const api = input.backend ?? backend();
  const confirmation = {
    consume: vi.fn(async (input: { readonly proof_reference: string }) =>
      input.proof_reference === "proof-delete-1"
    ),
  };
  const targets = {
    resolveCurrentConversation: vi.fn(async () => ({
      kind: "chat_id" as const,
      id: "chat-current-1",
    })),
  };
  return {
    api,
    store,
    confirmation,
    targets,
    executor: new FeishuCapabilityExecutor({
      citizen_id: "feishu-document-actions",
      endpoint_id: "endpoint-feishu-provider",
      backend: api,
      executions: store,
      ownership: store,
      confirmation,
      targets,
      now: () => "2026-07-27T10:00:00.000Z",
    }),
  };
}

function request(
  capabilityId: string,
  input: Record<string, unknown>,
  idempotencyKey = `idempotency-${capabilityId}`,
) {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-original-1",
    initiating_actor_id: "actor-human-1",
    invocation_id: `invocation-${capabilityId}`,
    idempotency_key: idempotencyKey,
    capability_id: capabilityId,
    input,
    authority: {
      allowed_target_refs: ["feishu://chat/chat-current-1"],
      allowed_document_tokens: ["external-doc-1"],
      confirmation_proof_refs: ["proof-delete-1"],
    },
  };
}

describe("Feishu Capability Provider", () => {
  it("dynamically declares six bounded capabilities without credentials", () => {
    const declarations = feishuCapabilityDeclarations();

    expect(declarations.map((item) => item.declaration_id)).toEqual([
      "feishu.document.append",
      "feishu.document.create",
      "feishu.document.delete",
      "feishu.document.read",
      "feishu.document.update",
      "feishu.message.send",
    ]);
    expect(declarations.find((item) =>
      item.declaration_id === "feishu.document.delete"
    )).toMatchObject({
      risk: "destructive",
      confirmation: "explicit",
    });
    expect(JSON.stringify(declarations)).not.toMatch(
      /app_id|app_secret|credential_ref|access_token/i,
    );
    expect(feishuContextDeclarations()).toMatchObject([
      {
        declaration_id: "feishu.document.context",
        declaration_kind: "context",
      },
    ]);
  });

  it("sends one message to the authorized current conversation and returns facts only", async () => {
    const fixture = executor();

    const result = await fixture.executor.execute(request(
      "feishu.message.send",
      {
        target: { kind: "current_conversation" },
        content: { media_type: "text/plain", text: "项目已进入实施阶段" },
      },
    ));

    expect(result).toEqual({
      outcome: "succeeded",
      data: {
        message_id: "message-1",
        target: { kind: "chat_id", id: "chat-current-1" },
        sent_at: "2026-07-27T10:00:00.000Z",
      },
      artifacts: [],
    });
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("Work Fabric");
  });

  it("performs simple document CRUD while preserving Provider ownership", async () => {
    const fixture = executor();
    const created = await fixture.executor.execute(request(
      "feishu.document.create",
      {
        title: "客户项目需求",
        content: { media_type: "text/markdown", text: "# 需求\n\n初始内容" },
      },
      "create-1",
    ));
    if (created.outcome !== "succeeded") throw new Error("create failed");
    const token = created.data.document_token as string;

    const read = await fixture.executor.execute(request(
      "feishu.document.read",
      {
        document: { kind: "docx", token },
        max_bytes: 64_000,
      },
      "read-1",
    ));
    expect(read).toMatchObject({
      outcome: "succeeded",
      data: {
        document_token: token,
        title: "客户项目需求",
        revision: "1",
      },
    });

    const updated = await fixture.executor.execute(request(
      "feishu.document.update",
      {
        document: { kind: "docx", token },
        expected_revision: "1",
        title: "客户项目需求 v2",
        content: { media_type: "text/plain", text: "更新内容" },
      },
      "update-1",
    ));
    expect(updated).toMatchObject({
      outcome: "succeeded",
      data: { revision: "2" },
    });
    const appended = await fixture.executor.execute(request(
      "feishu.document.append",
      {
        document: { kind: "docx", token },
        expected_revision: "2",
        content: { media_type: "text/plain", text: "\n追加内容" },
      },
      "append-1",
    ));
    expect(appended).toMatchObject({
      outcome: "succeeded",
      data: { revision: "3" },
    });

    const deleted = await fixture.executor.execute(request(
      "feishu.document.delete",
      {
        document: { kind: "docx", token },
        expected_revision: "3",
        confirmation_proof: "proof-delete-1",
      },
      "delete-1",
    ));
    expect(deleted).toMatchObject({
      outcome: "succeeded",
      data: { document_token: token },
    });
    expect(fixture.confirmation.consume).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      human_actor_id: "actor-human-1",
      capability_id: "feishu.document.delete",
      document_token: token,
      normalized_input_digest: expect.stringMatching(/^sha256:/),
      proof_reference: "proof-delete-1",
    });
    expect(await fixture.store.getOwnership("tenant-1", token)).toMatchObject({
      citizen_id: "feishu-document-actions",
      deleted_at: "2026-07-27T10:00:00.000Z",
    });
  });

  it("rejects deletion of a document not owned by this tenant Provider before any vendor call", async () => {
    const fixture = executor();

    const result = await fixture.executor.execute(request(
      "feishu.document.delete",
      {
        document: { kind: "docx", token: "external-doc-1" },
        expected_revision: "7",
        confirmation_proof: "proof-delete-1",
      },
    ));

    expect(result).toMatchObject({
      outcome: "rejected",
      code: "document_not_owned",
    });
    expect(fixture.api.deleteDocument).not.toHaveBeenCalled();
    expect(fixture.confirmation.consume).not.toHaveBeenCalled();
  });

  it("replays the durable result and rejects an idempotency key reused for different input", async () => {
    const fixture = executor();
    const first = await fixture.executor.execute(request(
      "feishu.document.create",
      {
        title: "项目需求",
        content: { media_type: "text/plain", text: "初始内容" },
      },
      "same-key",
    ));
    const replay = await fixture.executor.execute(request(
      "feishu.document.create",
      {
        title: "项目需求",
        content: { media_type: "text/plain", text: "初始内容" },
      },
      "same-key",
    ));

    expect(replay).toEqual(first);
    expect(fixture.api.createDocument).toHaveBeenCalledTimes(1);
    await expect(fixture.executor.execute(request(
      "feishu.document.create",
      {
        title: "另一个文档",
        content: { media_type: "text/plain", text: "不同内容" },
      },
      "same-key",
    ))).rejects.toThrow(/idempotency conflict/i);
  });

  it("exposes document reads through a separate context-provider boundary", async () => {
    const api = backend();
    const store = new MemoryFeishuProviderStore();
    const capability = executor({ backend: api, store });
    const created = await capability.executor.execute(request(
      "feishu.document.create",
      {
        title: "项目资料",
        content: { media_type: "text/plain", text: "资料正文" },
      },
      "context-create",
    ));
    if (created.outcome !== "succeeded") throw new Error("create failed");
    const token = created.data.document_token as string;
    const context = new FeishuDocumentContextProvider({ backend: api });

    const resolved = await context.read({
      tenant_id: "tenant-1",
      document_token: token,
      max_bytes: 64_000,
      authority: { allowed_document_tokens: [token] },
    });

    expect(resolved).toMatchObject({
      document_token: token,
      content: { text: "资料正文" },
      provenance: {
        citizen_kind: "context-provider",
        source: "feishu.docx",
      },
    });
  });
});
