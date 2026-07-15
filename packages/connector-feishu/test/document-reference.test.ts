import { describe, expect, it } from "vitest";

import {
  createFeishuDocxReference,
  createFeishuWikiReference,
  parseFeishuDocumentReference,
} from "../src/index.js";

describe("Feishu document references", () => {
  it("canonicalizes immutable Docx references without content", () => {
    const reference = createFeishuDocxReference({
      document_id: "doccnA1b2",
      revision_id: "7",
      title: "Delivery plan",
    });
    expect(reference).toEqual({
      uri: "feishu://docx/doccnA1b2?revision=7",
      external_type: "document",
      version: "7",
      media_type: "text/plain",
      metadata: { title: "Delivery plan", document_type: "docx" },
    });
    expect(parseFeishuDocumentReference(reference)).toEqual({
      kind: "docx",
      document_id: "doccnA1b2",
      revision_id: "7",
    });
  });

  it("keeps wiki tokens distinct until resolution", () => {
    const reference = createFeishuWikiReference("wikcnA1b2");
    expect(reference.uri).toBe("feishu://wiki/wikcnA1b2");
    expect(parseFeishuDocumentReference(reference)).toEqual({
      kind: "wiki",
      wiki_token: "wikcnA1b2",
    });
  });

  it.each([
    "feishu://docx/../secret?revision=7",
    "feishu://docx/doc-1",
    "https://example.test/doc",
  ])("rejects an unsafe or mutable reference: %s", (uri) => {
    expect(() => parseFeishuDocumentReference({
      uri,
      external_type: "document",
      metadata: {},
    })).toThrow();
  });
});
