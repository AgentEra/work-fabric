import type {
  CitizenSchemaReference,
} from "@work-fabric/network-citizen-spi";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import { feishuCalendarSchemaDocuments } from "./calendar-declarations.js";
import { feishuSchemaDocuments } from "./declarations.js";

export class FeishuCapabilitySchemaRegistry {
  private readonly documents = new Map([
    ...feishuSchemaDocuments(),
    ...feishuCalendarSchemaDocuments(),
  ]);

  async load(
    reference: CitizenSchemaReference,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const document = this.documents.get(reference.uri);
    if (
      document === undefined ||
      canonicalCitizenDigest(document) !== reference.digest
    ) throw new TypeError("Unknown or changed Feishu capability schema");
    return structuredClone(document);
  }
}
