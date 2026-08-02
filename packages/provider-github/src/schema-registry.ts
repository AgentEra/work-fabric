import {
  canonicalCitizenDigest,
  type CitizenSchemaReference,
} from "@work-fabric/network-citizen-spi";

import { githubSchemaDocuments } from "./declarations.js";

export class GitHubCapabilitySchemaRegistry {
  private readonly documents = new Map(githubSchemaDocuments());

  async load(
    reference: CitizenSchemaReference,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const document = this.documents.get(reference.uri);
    if (
      document === undefined ||
      canonicalCitizenDigest(document) !== reference.digest
    ) throw new TypeError("Unknown or changed GitHub capability schema");
    return structuredClone(document);
  }
}
