import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
} from "@work-fabric/network-citizen-spi";

const schema = (
  name: string,
  body: Record<string, unknown>,
): { readonly uri: string; readonly digest: `sha256:${string}` } => ({
  uri: `urn:work-fabric:schema:feishu:${name}:1`,
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
  required: ["document_token"],
  properties: {
    document_token: { type: "string", minLength: 1, maxLength: 512 },
  },
};
const documentToken = { type: "string", minLength: 1, maxLength: 512 };
const revision = { type: "string", minLength: 1, maxLength: 128 };

const DEFINITIONS = Object.freeze({
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
});

function capability(input: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input: keyof typeof DEFINITIONS;
  readonly output: keyof typeof DEFINITIONS;
  readonly risk: CitizenDeclaration["risk"];
  readonly confirmation?: CitizenDeclaration["confirmation"];
}): CitizenDeclaration {
  return Object.freeze({
    declaration_id: input.id,
    declaration_kind: "capability",
    version: "1.0.0",
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
    },
    extensions: {},
  });
}

export function feishuCapabilityDeclarations(): readonly CitizenDeclaration[] {
  return Object.freeze([
    capability({
      id: "feishu.document.append",
      name: "Append simple Feishu document content",
      description: "Append bounded simple content at the end of one Docx.",
      input: "documentAppendInput",
      output: "documentUpdateOutput",
      risk: "medium",
    }),
    capability({
      id: "feishu.document.create",
      name: "Create simple Feishu document",
      description: "Create one bounded simple Docx document.",
      input: "documentCreateInput",
      output: "documentCreateOutput",
      risk: "medium",
    }),
    capability({
      id: "feishu.document.delete",
      name: "Delete Provider-owned Feishu document",
      description: "Delete one same-tenant Provider-owned Docx after confirmation.",
      input: "documentDeleteInput",
      output: "documentDeleteOutput",
      risk: "destructive",
      confirmation: "explicit",
    }),
    capability({
      id: "feishu.document.read",
      name: "Read simple Feishu document",
      description: "Read one authorized Docx as bounded simple content.",
      input: "documentReadInput",
      output: "documentReadOutput",
      risk: "low",
    }),
    capability({
      id: "feishu.document.update",
      name: "Replace simple Feishu document content",
      description: "Replace one authorized simple Docx at an expected revision.",
      input: "documentUpdateInput",
      output: "documentUpdateOutput",
      risk: "medium",
    }),
    capability({
      id: "feishu.message.send",
      name: "Send Feishu text message",
      description: "Send one text message to one explicitly authorized target.",
      input: "messageSendInput",
      output: "messageSendOutput",
      risk: "medium",
    }),
  ]);
}

export function feishuContextDeclarations(): readonly CitizenDeclaration[] {
  return Object.freeze([Object.freeze({
    declaration_id: "feishu.document.context",
    declaration_kind: "context",
    version: "1.0.0",
    name: "Feishu document context",
    description: "Resolve one authorized Docx as bounded simple content.",
    input_schema: schema("documentReadInput", DEFINITIONS.documentReadInput),
    output_schema: schema("documentReadOutput", DEFINITIONS.documentReadOutput),
    interaction_modes: ["synchronous"] as const,
    risk: "low",
    confirmation: "none",
    constraints: { maximum_content_bytes: 131_072 },
    extensions: {},
  })]);
}

export function feishuSchemaDocuments(): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(DEFINITIONS).map(([name, body]) => [
    schema(name, body).uri,
    structuredClone(body),
  ]));
}
