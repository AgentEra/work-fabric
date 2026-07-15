import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Agent Gateway boundary", () => {
  it("depends only on the public TypeScript SDK", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies).toEqual({
      "@work-fabric/sdk-typescript": "0.1.0",
    });
  });

  it("contains no execution, model, tool, Codex, or Exchange internals", async () => {
    const sources = await Promise.all([
      "agent-endpoint-session.ts",
      "partition-multiplexer.ts",
      "bounded-async-queue.ts",
    ].map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));
    expect(sources.join("\n")).not.toMatch(
      /@work-fabric\/(?:exchange-core|exchange-runtime|adapter-)|fastify|openai|codex|executeTask|runTask|autoAccept/i,
    );
  });
});
