import {
  validateDocumentResourceReference,
  type DocumentResourceAdapter,
  type DocumentResourceReference,
} from "@work-fabric/document-provider-spi";

export type ResolvedFeishuDocumentResource =
  | {
      readonly kind: "document";
      readonly document_token: string;
    }
  | {
      readonly kind: "container";
      readonly folder_token: string | null;
    };

function token(value: string, path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError(`${path} is invalid`);
  }
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    decoded.trim() !== decoded ||
    decoded.includes("/")
  ) throw new TypeError(`${path} is invalid`);
  return decoded;
}

export class FeishuDocumentResourceAdapter
  implements DocumentResourceAdapter<ResolvedFeishuDocumentResource> {
  supports(reference: DocumentResourceReference): boolean {
    try {
      this.resolve(reference);
      return true;
    } catch {
      return false;
    }
  }

  resolve(
    input: DocumentResourceReference,
  ): ResolvedFeishuDocumentResource {
    const reference = validateDocumentResourceReference(input);
    const parsed = new URL(reference.resource_uri);
    if (parsed.protocol !== "feishu:") {
      throw new TypeError("unsupported_resource_type");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "docx" && parts.length === 1) {
      return Object.freeze({
        kind: "document" as const,
        document_token: token(parts[0]!, "document token"),
      });
    }
    if (
      parsed.hostname === "drive" &&
      parts.length === 1 &&
      parts[0] === "root"
    ) {
      return Object.freeze({
        kind: "container" as const,
        folder_token: null,
      });
    }
    if (
      parsed.hostname === "drive" &&
      parts.length === 2 &&
      parts[0] === "folder"
    ) {
      return Object.freeze({
        kind: "container" as const,
        folder_token: token(parts[1]!, "folder token"),
      });
    }
    throw new TypeError("unsupported_resource_type");
  }
}

