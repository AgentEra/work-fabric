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

function implementationMatches(
  packageRoot: (typeof packageRoots)[number],
  candidate: string,
): readonly string[] {
  const normalized = candidate.toLowerCase();
  const isBoundaryPackage = packageRoots.includes(packageRoot);
  return [
    ...(isBoundaryPackage && normalized.includes("@work-fabric/adapter-")
      ? ["adapter-package"]
      : []),
    ...forbidden.filter((token) => normalized.includes(token)),
  ];
}

function packageDependencyViolations(
  packageRoot: (typeof packageRoots)[number],
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const violations: string[] = [];
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
      const declared = (dependencies as Record<string, unknown>)[dependency];
      const candidates = [
        dependency,
        ...(typeof declared === "string" ? [declared] : []),
      ];
      for (const candidate of candidates) {
        for (const match of implementationMatches(packageRoot, candidate)) {
          violations.push(
            `${packageRoot}/package.json ${section} includes ${dependency} as ${candidate} (${match})`,
          );
        }
      }
    }
  }
  return violations;
}

describe("Exchange Core dependency boundaries", () => {
  it("extracts module specifiers without treating comments or strings as imports", () => {
    expect(
      importSpecifiers(`
        // import "postgres-comment";
        const documentation = 'import "feishu-doc-example"';
        import type {
          Clock as RenamedClock,
        } from "@work-fabric/exchange-core";
        export {
          publicValue as renamedPublicValue,
        } from "./public.js";
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

  it("rejects every Core or SPI Adapter package and implementation aliases", () => {
    const genericImport = importSpecifiers(`
      import {
        Cache as RenamedCache,
      } from "@work-fabric/adapter-cache-redis";
    `)[0];
    expect(genericImport).toBe("@work-fabric/adapter-cache-redis");
    expect(
      implementationMatches(
        "packages/exchange-core",
        genericImport!,
      ),
    ).toContain("adapter-package");
    expect(
      implementationMatches(
        "packages/exchange-spi",
        "@work-fabric/adapter-future-implementation",
      ),
    ).toContain("adapter-package");
    const dependencyViolations = packageDependencyViolations(
      "packages/exchange-spi",
      {
        dependencies: {
          "@work-fabric/adapter-cache-redis": "1.0.0",
          "neutral-name":
            "npm:@work-fabric/adapter-storage-memory@0.1.0",
        },
      },
    ).join("\n");
    expect(dependencyViolations).toContain(
      "@work-fabric/adapter-cache-redis as @work-fabric/adapter-cache-redis",
    );
    expect(dependencyViolations).toContain(
      "neutral-name as npm:@work-fabric/adapter-storage-memory@0.1.0",
    );
    expect(dependencyViolations).toContain("adapter-package");
    expect(dependencyViolations).toContain("adapter-storage");
  });

  it("keeps SPI and Core imports and package dependencies technology-neutral", async () => {
    const violations: string[] = [];
    for (const packageRoot of packageRoots) {
      for (const file of await sourceFiles(join(packageRoot, "src"))) {
        const source = await readFile(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          for (const match of implementationMatches(packageRoot, specifier)) {
            violations.push(
              `${relative(process.cwd(), file)} imports ${specifier} (${match})`,
            );
          }
        }
      }

      const manifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      violations.push(...packageDependencyViolations(packageRoot, manifest));
    }

    expect(violations).toEqual([]);
  });
});
