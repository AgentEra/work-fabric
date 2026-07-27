import { describe, expect, it, vi } from "vitest";

import { CatalogCapabilityDisclosure } from "../src/index.js";

function descriptor(citizenId: string) {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider" as const,
    version: "1.0.0",
    identity: null,
    protocol: { versions: ["1"], bindings: ["workfabric+https"] },
    declarations: {
      count: 2,
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    },
    availability: "available" as const,
    extensions: {},
  };
}

describe("CatalogCapabilityDisclosure", () => {
  it("returns only allowed capability summaries in deterministic order", async () => {
    const list = vi.fn(async () => ({
      items: [descriptor("provider-z"), descriptor("provider-a")],
    }));
    const listDeclarations = vi.fn(async (citizenId: string) => ({
      items: [
        {
          declaration_id: "mail.message.send",
          declaration_kind: "capability" as const,
          version: "1.0.0",
          name: "Send mail",
          description: "Send one message.",
        },
        {
          declaration_id: "feishu.document.create",
          declaration_kind: "capability" as const,
          version: citizenId === "provider-a" ? "1.0.0" : "1.1.0",
          name: "Create document",
          description: "Create one simple Docx document.",
        },
      ],
    }));
    const disclosure = new CatalogCapabilityDisclosure({
      list,
      listDeclarations,
    });

    const summaries = await disclosure.list(
      ["feishu."],
      new AbortController().signal,
    );

    expect(list).toHaveBeenCalledWith({
      citizen_kind: "capability-provider",
      availability: ["available"],
      executable_only: true,
      limit: 32,
    }, { signal: expect.any(AbortSignal) });
    expect(summaries).toEqual([
      {
        citizen_id: "provider-a",
        capability_id: "feishu.document.create",
        version: "1.0.0",
        name: "Create document",
        description: "Create one simple Docx document.",
      },
      {
        citizen_id: "provider-z",
        capability_id: "feishu.document.create",
        version: "1.1.0",
        name: "Create document",
        description: "Create one simple Docx document.",
      },
    ]);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(summaries[0]).not.toHaveProperty("endpoint_id");
    expect(summaries[0]).not.toHaveProperty("input_schema");
    expect(summaries[0]).not.toHaveProperty("risk");
    expect(summaries[0]).not.toHaveProperty("folder_token");
  });

  it("rejects duplicate summaries and bounded-pagination overflow", async () => {
    const duplicate = new CatalogCapabilityDisclosure({
      async list() {
        return { items: [descriptor("provider-a")] };
      },
      async listDeclarations() {
        const item = {
          declaration_id: "feishu.document.create",
          declaration_kind: "capability" as const,
          version: "1.0.0",
          name: "Create document",
          description: "Create.",
        };
        return { items: [item, item] };
      },
    });
    await expect(duplicate.list(
      ["feishu."],
      new AbortController().signal,
    )).rejects.toThrow(/duplicate/i);

    const overflow = new CatalogCapabilityDisclosure({
      async list() {
        return {
          items: Array.from({ length: 32 }, (_, index) =>
            descriptor(`provider-${index}`)),
          next_cursor: "more",
        };
      },
      async listDeclarations() {
        return { items: [] };
      },
    });
    await expect(overflow.list(
      ["feishu."],
      new AbortController().signal,
    )).rejects.toThrow(/bound/i);
  });

  it("does not hide Catalog failures as an empty capability list", async () => {
    const unavailable = new Error("catalog unavailable");
    const disclosure = new CatalogCapabilityDisclosure({
      async list() {
        throw unavailable;
      },
      async listDeclarations() {
        return { items: [] };
      },
    });

    await expect(disclosure.list(
      ["feishu."],
      new AbortController().signal,
    )).rejects.toBe(unavailable);
  });
});
