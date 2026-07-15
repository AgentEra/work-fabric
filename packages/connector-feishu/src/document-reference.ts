import type { ConnectorExternalReference } from "@work-fabric/connector-spi";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const REVISION = /^[1-9][0-9]{0,19}$/;

export interface FeishuDocxMetadata {
  readonly document_id: string;
  readonly revision_id: string;
  readonly title: string;
}

export type ParsedFeishuDocumentReference =
  | {
      readonly kind: "docx";
      readonly document_id: string;
      readonly revision_id: string;
    }
  | { readonly kind: "wiki"; readonly wiki_token: string };

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export function createFeishuDocxReference(
  metadata: FeishuDocxMetadata,
): ConnectorExternalReference {
  const documentId = identifier(metadata.document_id, "document_id");
  if (!REVISION.test(metadata.revision_id)) {
    throw new TypeError("revision_id is invalid");
  }
  if (
    typeof metadata.title !== "string" ||
    metadata.title.length === 0 ||
    metadata.title.length > 512
  ) {
    throw new TypeError("title is invalid");
  }
  return {
    uri: `feishu://docx/${documentId}?revision=${metadata.revision_id}`,
    external_type: "document",
    version: metadata.revision_id,
    media_type: "text/plain",
    metadata: { title: metadata.title, document_type: "docx" },
  };
}

export function createFeishuWikiReference(
  wikiToken: string,
): ConnectorExternalReference {
  const token = identifier(wikiToken, "wiki_token");
  return {
    uri: `feishu://wiki/${token}`,
    external_type: "document",
    metadata: { document_type: "wiki" },
  };
}

export function parseFeishuDocumentReference(
  reference: ConnectorExternalReference,
): ParsedFeishuDocumentReference {
  if (reference.external_type !== "document") {
    throw new TypeError("Feishu reference must be a document");
  }
  const docx = /^feishu:\/\/docx\/([A-Za-z0-9_-]{1,128})\?revision=([1-9][0-9]{0,19})$/.exec(
    reference.uri,
  );
  if (docx !== null) {
    return {
      kind: "docx",
      document_id: docx[1]!,
      revision_id: docx[2]!,
    };
  }
  const wiki = /^feishu:\/\/wiki\/([A-Za-z0-9_-]{1,128})$/.exec(
    reference.uri,
  );
  if (wiki !== null) {
    return { kind: "wiki", wiki_token: wiki[1]! };
  }
  throw new TypeError("Feishu document reference is invalid or mutable");
}
