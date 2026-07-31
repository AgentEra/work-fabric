import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
} from "@work-fabric/network-citizen-spi";

const schema = (
  name: string,
  body: Record<string, unknown>,
): { readonly uri: string; readonly digest: `sha256:${string}` } => ({
  uri: `urn:work-fabric:schema:feishu:${name}:${
    name === "documentCreateInput"
      ? "3"
      : name.startsWith("document") ? "2" : "1"
  }`,
  digest: canonicalCitizenDigest(body),
});

const objectSchema = (
  required: readonly string[],
  properties: Record<string, unknown>,
) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const content = {
  type: "object",
  additionalProperties: false,
  required: ["media_type", "text"],
  properties: {
    media_type: { enum: ["text/plain", "text/markdown"] },
    text: { type: "string", minLength: 1, maxLength: 131_072 },
  },
};
const documentReference = {
  type: "object",
  additionalProperties: false,
  required: ["resource_uri"],
  properties: {
    resource_uri: {
      type: "string",
      minLength: 1,
      maxLength: 2_048,
      format: "uri",
    },
  },
};
const placement = {
  description:
    "Optional. Omit to use the Provider-owned default placement. Supply only an explicit resource URI or a qualified usage policy reference.",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["resource_uri"],
      properties: {
        resource_uri: {
          type: "string",
          minLength: 1,
          maxLength: 2_048,
          format: "uri",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["policy_ref"],
      properties: {
        policy_ref: {
          type: "string",
          minLength: 3,
          maxLength: 256,
          pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$",
        },
      },
    },
  ],
};
const documentToken = { type: "string", minLength: 1, maxLength: 512 };
const revision = { type: "string", minLength: 1, maxLength: 128 };

const DEFINITIONS = Object.freeze({
  conversationMembersInput: objectSchema([
    "conversation",
    "page_size",
  ], {
    conversation: {
      oneOf: [
        objectSchema(["kind"], {
          kind: { const: "current_conversation" },
        }),
        objectSchema(["kind", "resource_uri"], {
          kind: { const: "resource_reference" },
          resource_uri: {
            type: "string",
            pattern: "^feishu://chat/[^/]+$",
            maxLength: 2_048,
          },
        }),
      ],
    },
    page_size: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string", minLength: 1, maxLength: 4_096 },
  }),
  conversationMembersOutput: objectSchema([
    "members",
    "has_more",
    "provenance",
  ], {
    members: {
      type: "array",
      maxItems: 100,
      items: objectSchema(["resource_uri"], {
        resource_uri: {
          type: "string",
          pattern: "^feishu://user/open-id/[^/]+$",
        },
        display_name: { type: "string", maxLength: 255 },
      }),
    },
    has_more: { type: "boolean" },
    next_cursor: { type: "string", minLength: 1, maxLength: 4_096 },
    provenance: objectSchema([
      "provider_family",
      "source",
      "source_reference",
    ], {
      provider_family: { const: "feishu" },
      source: { const: "im.chat.members" },
      source_reference: { type: "string", format: "uri" },
    }),
  }),
  conversationHistoryInput: objectSchema([
    "conversation",
    "maximum_messages",
  ], {
    conversation: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { const: "current_conversation" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "resource_uri"],
          properties: {
            kind: { const: "resource_reference" },
            resource_uri: {
              type: "string",
              minLength: 1,
              maxLength: 2_048,
              format: "uri",
            },
          },
        },
      ],
    },
    cursor: { type: "string", minLength: 1, maxLength: 4_096 },
    maximum_messages: { type: "integer", minimum: 1, maximum: 50 },
  }),
  conversationHistoryOutput: objectSchema([
    "messages",
    "has_more",
    "coverage",
    "provenance",
  ], {
    messages: {
      type: "array",
      maxItems: 50,
      items: objectSchema([
        "message_id",
        "sender",
        "created_at",
        "content",
        "provenance",
      ], {
        message_id: { type: "string", minLength: 1, maxLength: 255 },
        sender: objectSchema(["external_id", "sender_type"], {
          external_id: { type: "string", minLength: 1, maxLength: 255 },
          sender_type: { type: "string", minLength: 1, maxLength: 64 },
        }),
        created_at: { type: "string", format: "date-time" },
        content: objectSchema(["media_type", "text"], {
          media_type: { const: "text/plain" },
          text: { type: "string", minLength: 1, maxLength: 131_072 },
        }),
        provenance: objectSchema([
          "provider_family",
          "source",
          "updated",
        ], {
          provider_family: { const: "feishu" },
          source: { const: "im.message" },
          updated: { type: "boolean" },
        }),
      }),
    },
    has_more: { type: "boolean" },
    next_cursor: { type: "string", minLength: 1, maxLength: 4_096 },
    coverage: objectSchema([], {
      newest_at: { type: "string", format: "date-time" },
      oldest_at: { type: "string", format: "date-time" },
    }),
    provenance: objectSchema([
      "provider_family",
      "source",
      "source_reference",
    ], {
      provider_family: { const: "feishu" },
      source: { const: "im.message" },
      source_reference: {
        type: "string",
        minLength: 1,
        maxLength: 2_048,
        format: "uri",
      },
    }),
  }),
  messageSendInput: objectSchema(["target", "content"], {
    target: {
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["kind"], properties: { kind: { const: "current_conversation" } },
        },
        {
          type: "object", additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { enum: ["open_id", "chat_id"] },
            id: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      ],
    },
    content,
  }),
  messageSendOutput: objectSchema(["message_id", "target", "sent_at"], {
    message_id: { type: "string", minLength: 1 },
    target: { type: "object" },
    sent_at: { type: "string", minLength: 1 },
  }),
  documentCreateInput: objectSchema(["title", "content"], {
    title: { type: "string", minLength: 1, maxLength: 512 },
    content,
    placement,
  }),
  documentCreateOutput: objectSchema([
    "document_token", "url", "title", "revision",
  ], {
    document_token: documentToken,
    url: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    revision,
  }),
  documentReadInput: objectSchema(["document", "max_bytes"], {
    document: documentReference,
    max_bytes: { type: "integer", minimum: 1, maximum: 131_072 },
  }),
  documentReadOutput: objectSchema([
    "document_token", "title", "content", "revision", "provenance",
  ], {
    document_token: documentToken,
    title: { type: "string" },
    content,
    revision,
    provenance: { type: "object" },
  }),
  documentUpdateInput: objectSchema([
    "document", "expected_revision", "content",
  ], {
    document: documentReference,
    expected_revision: revision,
    title: { type: "string", minLength: 1, maxLength: 512 },
    content,
  }),
  documentUpdateOutput: objectSchema([
    "document_token", "title", "revision",
  ], {
    document_token: documentToken,
    title: { type: "string" },
    revision,
  }),
  documentAppendInput: objectSchema([
    "document", "expected_revision", "content",
  ], {
    document: documentReference,
    expected_revision: revision,
    content,
  }),
  documentDeleteInput: objectSchema([
    "document", "expected_revision", "confirmation_proof",
  ], {
    document: documentReference,
    expected_revision: revision,
    confirmation_proof: { type: "string", minLength: 1, maxLength: 512 },
  }),
  documentDeleteOutput: objectSchema(["document_token", "deleted_at"], {
    document_token: documentToken,
    deleted_at: { type: "string", minLength: 1 },
  }),
  messageConversationContextInput: objectSchema([
    "tenant_id",
    "provider_family",
    "external_tenant_id",
    "conversation_id",
    "trigger_message_id",
    "triggered_at",
    "represented_actor_id",
    "recipient_actor_id",
    "recipient_endpoint_id",
    "delegation_id",
    "delegation_scopes",
    "delegation_expires_at",
    "policy",
  ], {
    tenant_id: { type: "string", minLength: 1, maxLength: 128 },
    provider_family: { const: "feishu" },
    external_tenant_id: { type: "string", minLength: 1, maxLength: 255 },
    conversation_id: { type: "string", minLength: 1, maxLength: 255 },
    trigger_message_id: { type: "string", minLength: 1, maxLength: 255 },
    thread_id: { type: "string", minLength: 1, maxLength: 255 },
    root_message_id: { type: "string", minLength: 1, maxLength: 255 },
    triggered_at: { type: "string", format: "date-time" },
    represented_actor_id: { type: "string", minLength: 1, maxLength: 128 },
    recipient_actor_id: { type: "string", minLength: 1, maxLength: 128 },
    recipient_endpoint_id: { type: "string", minLength: 1, maxLength: 128 },
    delegation_id: { type: "string", minLength: 1, maxLength: 128 },
    delegation_scopes: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    delegation_expires_at: { type: "string", format: "date-time" },
    policy: objectSchema([
      "lookback_seconds", "maximum_messages", "maximum_bytes",
    ], {
      lookback_seconds: {
        type: "integer", minimum: 60, maximum: 604_800,
      },
      maximum_messages: { type: "integer", minimum: 1, maximum: 50 },
      maximum_bytes: {
        type: "integer", minimum: 1_024, maximum: 131_072,
      },
    }),
  }),
  messageConversationContextOutput: objectSchema([
    "context_id",
    "version",
    "created_at",
    "items",
    "visibility_scope",
    "extensions",
    "digest",
  ], {
    context_id: { type: "string", minLength: 1, maxLength: 128 },
    version: { const: 1 },
    created_at: { type: "string", format: "date-time" },
    items: { type: "array", maxItems: 51, items: { type: "object" } },
    visibility_scope: { type: "object" },
    extensions: { type: "object" },
    digest: objectSchema(["algorithm", "value"], {
      algorithm: { const: "sha-256" },
      value: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
  }),
});

function capability(input: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input: keyof typeof DEFINITIONS;
  readonly output: keyof typeof DEFINITIONS;
  readonly risk: CitizenDeclaration["risk"];
  readonly operation_kind: "query" | "command" | "destructive";
  readonly confirmation?: CitizenDeclaration["confirmation"];
  readonly version?: string;
}): CitizenDeclaration {
  return Object.freeze({
    declaration_id: input.id,
    declaration_kind: "capability",
    version: input.version ?? "2.0.0",
    name: input.name,
    description: input.description,
    input_schema: schema(input.input, DEFINITIONS[input.input]),
    output_schema: schema(input.output, DEFINITIONS[input.output]),
    interaction_modes: ["asynchronous"] as const,
    risk: input.risk,
    confirmation: input.confirmation ?? "none",
    constraints: {
      single_target: true,
      maximum_content_bytes: 131_072,
      provider_output: "typed_facts_only",
      operation_kind: input.operation_kind,
    },
    extensions: {},
  });
}

function allCapabilityDeclarations(): readonly CitizenDeclaration[] {
  return Object.freeze([
    capability({
      id: "feishu.conversation.members.list",
      name: "List Feishu conversation members",
      description:
        "Read one bounded page of authorized conversation members as typed facts.",
      input: "conversationMembersInput",
      output: "conversationMembersOutput",
      risk: "low",
      operation_kind: "query",
      version: "1.0.0",
    }),
    capability({
      id: "feishu.conversation.history.read",
      name: "Read Feishu conversation history",
      description:
        "Read one bounded page of authorized conversation messages as typed evidence.",
      input: "conversationHistoryInput",
      output: "conversationHistoryOutput",
      risk: "low",
      operation_kind: "query",
      version: "1.0.0",
    }),
    capability({
      id: "feishu.document.append",
      name: "Append simple Feishu document content",
      description: "Append bounded simple content at the end of one Docx.",
      input: "documentAppendInput",
      output: "documentUpdateOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.document.create",
      name: "Create simple Feishu document",
      description: "Create one bounded simple Docx document.",
      input: "documentCreateInput",
      output: "documentCreateOutput",
      risk: "medium",
      operation_kind: "command",
      version: "2.0.1",
    }),
    capability({
      id: "feishu.document.delete",
      name: "Delete Provider-owned Feishu document",
      description: "Delete one same-tenant Provider-owned Docx after confirmation.",
      input: "documentDeleteInput",
      output: "documentDeleteOutput",
      risk: "destructive",
      operation_kind: "destructive",
      confirmation: "explicit",
    }),
    capability({
      id: "feishu.document.read",
      name: "Read simple Feishu document",
      description: "Read one authorized Docx as bounded simple content.",
      input: "documentReadInput",
      output: "documentReadOutput",
      risk: "low",
      operation_kind: "query",
    }),
    capability({
      id: "feishu.document.update",
      name: "Replace simple Feishu document content",
      description: "Replace one authorized simple Docx at an expected revision.",
      input: "documentUpdateInput",
      output: "documentUpdateOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.message.send",
      name: "Send Feishu text message",
      description: "Send one text message to one explicitly authorized target.",
      input: "messageSendInput",
      output: "messageSendOutput",
      risk: "medium",
      operation_kind: "command",
      version: "1.0.0",
    }),
  ]);
}

export function feishuMessageCapabilityDeclarations():
  readonly CitizenDeclaration[] {
  return Object.freeze(
    allCapabilityDeclarations().filter((declaration) =>
      declaration.declaration_id === "feishu.conversation.history.read" ||
      declaration.declaration_id === "feishu.conversation.members.list" ||
      declaration.declaration_id === "feishu.message.send"
    ),
  );
}

export function feishuDocumentCapabilityDeclarations():
  readonly CitizenDeclaration[] {
  return Object.freeze(
    allCapabilityDeclarations().filter((declaration) =>
      declaration.declaration_id.startsWith("feishu.document.")
    ),
  );
}

/**
 * Compatibility declaration set for deployments that still register one
 * aggregate Feishu capability Citizen.
 */
export function feishuCapabilityDeclarations(): readonly CitizenDeclaration[] {
  return allCapabilityDeclarations();
}

export function feishuContextDeclarations(): readonly CitizenDeclaration[] {
  return Object.freeze([
    Object.freeze({
      declaration_id: "feishu.document.context",
      declaration_kind: "context",
      version: "2.0.0",
      name: "Feishu document context",
      description: "Resolve one authorized Docx as bounded simple content.",
      input_schema: schema("documentReadInput", DEFINITIONS.documentReadInput),
      output_schema: schema("documentReadOutput", DEFINITIONS.documentReadOutput),
      interaction_modes: ["synchronous"] as const,
      risk: "low",
      confirmation: "none",
      constraints: { maximum_content_bytes: 131_072 },
      extensions: {},
    }),
    Object.freeze({
      declaration_id: "feishu.conversation.context",
      declaration_kind: "context",
      version: "1.0.0",
      name: "Feishu conversation context",
      description:
        "Resolve authorized bounded Feishu conversation history as immutable context.",
      input_schema: schema(
        "messageConversationContextInput",
        DEFINITIONS.messageConversationContextInput,
      ),
      output_schema: schema(
        "messageConversationContextOutput",
        DEFINITIONS.messageConversationContextOutput,
      ),
      interaction_modes: ["synchronous"] as const,
      risk: "low",
      confirmation: "none",
      constraints: {
        maximum_content_bytes: 131_072,
        maximum_messages: 50,
        provider_output: "typed_context_only",
      },
      extensions: {},
    }),
  ]);
}

export function feishuSchemaDocuments(): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(DEFINITIONS).map(([name, body]) => [
    schema(name, body).uri,
    structuredClone(body),
  ]));
}
