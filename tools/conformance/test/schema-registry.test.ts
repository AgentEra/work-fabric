import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findJsonFiles,
  loadSchemaRegistry,
} from "../src/schema-registry.js";

describe("findJsonFiles", () => {
  it("discovers nested JSON files in deterministic lexical order", async () => {
    const root = await mkdtemp(join(tmpdir(), "wfpp-schemas-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.schema.json"), "{}", "utf8");
    await writeFile(join(root, "nested", "a.schema.json"), "{}", "utf8");
    await writeFile(join(root, "ignored.txt"), "{}", "utf8");

    await expect(findJsonFiles(root)).resolves.toEqual([
      join(root, "nested", "a.schema.json"),
      join(root, "z.schema.json"),
    ]);
  });
});

describe("loadSchemaRegistry", () => {
  it("rejects a schema directory with no JSON schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "wfpp-empty-schemas-"));

    await expect(loadSchemaRegistry(root)).rejects.toThrow(
      "No JSON schemas found",
    );
  });
});
