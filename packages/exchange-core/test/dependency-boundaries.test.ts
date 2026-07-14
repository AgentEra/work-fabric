import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const packageRoots = [
  "packages/exchange-spi",
  "packages/exchange-core",
] as const;

const forbidden = [
  "adapter-storage",
  "adapter-identity",
  "adapter-context",
  "adapter-signal",
  "pg",
  "postgres",
  "kafka",
  "nats",
  "feishu",
  "express",
  "fastify",
  "@modelcontextprotocol",
] as const;

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

function importSpecifiers(source: string): readonly string[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: {
    readonly kind: SyntaxKind;
    readonly value: string;
  }[] = [];
  for (;;) {
    const kind = scanner.scan();
    tokens.push({ kind, value: scanner.getTokenValue() });
    if (kind === SyntaxKind.EndOfFile) break;
  }
  const specifiers: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const argument = tokens[index + 2];
    if (
      (token.kind === SyntaxKind.ImportKeyword || token.value === "require") &&
      next?.kind === SyntaxKind.OpenParenToken &&
      argument?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.push(argument.value);
      continue;
    }
    if (
      token.kind === SyntaxKind.ImportKeyword &&
      next?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.push(next.value);
      continue;
    }
    if (
      token.kind !== SyntaxKind.ImportKeyword &&
      token.kind !== SyntaxKind.ExportKeyword
    ) {
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (
        candidate === undefined ||
        candidate.kind === SyntaxKind.SemicolonToken ||
        candidate.kind === SyntaxKind.EndOfFile
      ) {
        break;
      }
      const module = tokens[cursor + 1];
      if (
        candidate.kind === SyntaxKind.FromKeyword &&
        module?.kind === SyntaxKind.StringLiteral
      ) {
        specifiers.push(module.value);
        break;
      }
    }
  }
  return specifiers;
}

describe("Exchange Core dependency boundaries", () => {
  it("extracts module specifiers without treating comments or strings as imports", () => {
    expect(
      importSpecifiers(`
        // import "postgres-comment";
        const documentation = 'import "feishu-doc-example"';
        import type { Clock } from "@work-fabric/exchange-core";
        export * from "./public.js";
        const lazy = import("./lazy.js");
        const legacy = require("./legacy.cjs");
      `),
    ).toEqual([
      "@work-fabric/exchange-core",
      "./public.js",
      "./lazy.js",
      "./legacy.cjs",
    ]);
  });

  it("keeps SPI and Core imports and package dependencies technology-neutral", async () => {
    const violations: string[] = [];
    for (const packageRoot of packageRoots) {
      for (const file of await sourceFiles(join(packageRoot, "src"))) {
        const source = await readFile(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          const normalized = specifier.toLowerCase();
          for (const token of forbidden) {
            if (normalized.includes(token)) {
              violations.push(
                `${relative(process.cwd(), file)} imports ${specifier} (${token})`,
              );
            }
          }
        }
      }

      const manifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const dependencies = manifest[section];
        if (
          dependencies === null ||
          typeof dependencies !== "object" ||
          Array.isArray(dependencies)
        ) {
          continue;
        }
        for (const dependency of Object.keys(dependencies)) {
          const normalized = dependency.toLowerCase();
          for (const token of forbidden) {
            if (normalized.includes(token)) {
              violations.push(
                `${packageRoot}/package.json ${section} includes ${dependency} (${token})`,
              );
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
