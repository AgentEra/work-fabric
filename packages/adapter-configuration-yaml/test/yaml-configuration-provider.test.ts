import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  YamlConfigurationError,
  YamlConfigurationProvider,
} from "../src/index.js";

async function fixture(source: string, options: { max_bytes?: number; max_depth?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wf-yaml-"));
  const path = join(directory, "work-fabric.yaml");
  await writeFile(path, source, "utf8");
  return new YamlConfigurationProvider({
    path,
    max_bytes: options.max_bytes ?? 4096,
    max_depth: options.max_depth ?? 8,
  });
}

describe("YamlConfigurationProvider", () => {
  it("loads YAML and returns a content-derived revision", async () => {
    const provider = await fixture("api_version: workfabric.config/v1\nservice:\n  role: all\n");
    const document = await provider.load();

    expect(document.value).toEqual({
      api_version: "workfabric.config/v1",
      service: { role: "all" },
    });
    expect(document.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(provider.load()).resolves.toEqual(document);
  });

  it("accepts JSON through the same YAML-compatible path", async () => {
    const provider = await fixture('{"api_version":"workfabric.config/v1","service":{}}');
    await expect(provider.load()).resolves.toMatchObject({
      value: { api_version: "workfabric.config/v1", service: {} },
    });
  });

  it.each([
    ["duplicate_key", "a: 1\na: 2\n"],
    ["multiple_documents", "a: 1\n---\nb: 2\n"],
    ["alias_forbidden", "base: &base {a: 1}\ncopy: *base\n"],
    ["custom_tag_forbidden", "value: !custom hello\n"],
    ["non_json_number", "value: .inf\n"],
  ])("rejects %s safely", async (code, source) => {
    const provider = await fixture(source);
    let error: unknown;
    try { await provider.load(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(YamlConfigurationError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(source.trim());
  });

  it("rejects the file byte boundary before parsing", async () => {
    const provider = await fixture("value: 123456789\n", { max_bytes: 8 });
    await expect(provider.load()).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("rejects structures deeper than the configured bound", async () => {
    const provider = await fixture("a:\n  b:\n    c:\n      d: value\n", { max_depth: 3 });
    await expect(provider.load()).rejects.toMatchObject({ code: "document_too_deep" });
  });

  it("reports only the normalized path and a stable code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-yaml-missing-"));
    const path = join(directory, "secret-name.yaml");
    const provider = new YamlConfigurationProvider({ path, max_bytes: 100, max_depth: 3 });
    let error: unknown;
    try { await provider.load(); } catch (caught) { error = caught; }

    expect(error).toMatchObject({ code: "file_unavailable", path });
    expect(String(error)).toBe(`YamlConfigurationError: file_unavailable at ${path}`);
  });
});
