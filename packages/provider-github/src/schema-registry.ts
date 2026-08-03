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
    // Invocation contracts cross a JSON boundary. Materialize repeated schema
    // fragments as independent JSON tree nodes so consumers never receive a
    // shared object graph that can be mistaken for a cyclic value.
    return JSON.parse(JSON.stringify(document)) as unknown;
  }
}
