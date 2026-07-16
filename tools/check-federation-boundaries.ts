import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FederationBoundaryReport {
  readonly source_files: number;
  readonly federation_imports: number;
  readonly telemetry_calls: number;
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT"
    ) return result;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (path.endsWith(".ts")) result.push(path);
  }
  return result;
}

const isolatedPackagePrefixes = [
  "packages/exchange-core/",
  "packages/exchange-runtime/",
  "packages/exchange-spi/",
  "packages/cluster-runtime/",
  "packages/cluster-spi/",
  "packages/transport-http/",
  "packages/sdk-typescript/",
];

export async function checkFederationBoundaries(
  root = resolve("."),
): Promise<FederationBoundaryReport> {
  const sourceFiles = await files(join(root, "packages"));
  const violations: string[] = [];
  let federationImports = 0;
  let telemetryCalls = 0;
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    const repositoryPath = relative(root, path);
    const production = !repositoryPath.includes("/test/") &&
      !repositoryPath.endsWith(".test.ts");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    for (const specifier of specifiers) {
      if (!specifier.startsWith("@work-fabric/federation-")) continue;
      federationImports += 1;
      if (isolatedPackagePrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
        violations.push(`${repositoryPath} imports Federation across an isolated boundary`);
      }
    }
    if (
      production && repositoryPath.startsWith("packages/federation-spi/") &&
      specifiers.some((specifier) => /^(?:node:|pg$|postgres|nats|fastify|ws$)/i.test(specifier))
    ) {
      violations.push(`${repositoryPath} couples the technology-neutral Federation SPI`);
    }
    if (
      production && repositoryPath.startsWith("packages/federation-") &&
      /\b(?:candidate\s+(?:rank|score)|target\s+(?:rank|selection)|workflow\s+schedul|agent\s+brain|model\s+inference|tool\s+execution)\b/i.test(source)
    ) {
      violations.push(`${repositoryPath} contains scheduling or execution responsibility`);
    }
    if (production && repositoryPath.startsWith("packages/federation-")) {
      const blocks = source.split(/observe(?:SemanticSafely|Federation)?\s*\(/).slice(1)
        .map((value) => value.split(");", 1)[0] ?? value);
      telemetryCalls += blocks.length;
      for (const block of blocks) {
        if (/\b(?:peer|exchange|transfer|message|handoff|tenant|url|signature|content|credential)[_-]?(?:id|uri|value)?\s*:/.test(block)) {
          violations.push(`${repositoryPath} exposes Federation identity or content in telemetry`);
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Federation boundary violations:\n${violations.join("\n")}`);
  }
  return {
    source_files: sourceFiles.length,
    federation_imports: federationImports,
    telemetry_calls: telemetryCalls,
  };
}

const invoked = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await checkFederationBoundaries())}\n`);
}
