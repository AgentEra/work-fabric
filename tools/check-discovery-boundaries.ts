import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface DiscoveryBoundaryReport {
  readonly source_files: number;
  readonly discovery_imports: number;
  readonly responsibility_violations: number;
  readonly schema_violations: number;
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
    else if (path.endsWith(".ts") || path.endsWith(".json")) result.push(path);
  }
  return result;
}

function production(repositoryPath: string): boolean {
  return !repositoryPath.includes("/test/") &&
    !repositoryPath.endsWith(".test.ts") &&
    !repositoryPath.includes("/dist/") &&
    !repositoryPath.includes("/node_modules/");
}

function moduleSpecifiers(source: string): readonly string[] {
  return [
    ...source.matchAll(/(?:from\s+|import\s*\(|import\s+|require\s*\()\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
}

const isolated = [
  "packages/exchange-core/src/",
  "packages/exchange-runtime/src/",
  "packages/federation-runtime/src/",
  "packages/cluster-runtime/src/",
  "packages/protocol-runtime/src/",
];

const forbiddenRuntimeModule = /(?:^|[/@-])(?:fastify|better-sqlite3|sqlite3?|postgres|pg|nats|agent(?:-gateway|-runtime)?|model(?:-runtime)?|tool(?:-runtime)?)(?:$|[/@-])/i;
const crossExchangeSchema = new Set([
  "packages/discovery-spi/src/records.ts",
  "packages/discovery-spi/src/messages.ts",
]);
const sensitiveField = /\b(?:fencing_token|heartbeat_sequence|session_id|tenant_id|credential|(?:access|refresh|bearer|auth)_token|private_key)\b\s*[?:]/i;
const sdkResponsibility = /\b(?:rank|score|recommend|selectTarget|invokeDiscovered|autoInvoke|automaticInvocation)\s*(?:[?:=]|\()/;

export async function checkDiscoveryBoundaries(
  root = resolve("."),
): Promise<DiscoveryBoundaryReport> {
  const paths = [
    ...await files(join(root, "packages")),
    ...await files(join(root, "protocol", "schemas")),
  ];
  const violations: string[] = [];
  let discoveryImports = 0;
  let responsibilityViolations = 0;
  let schemaViolations = 0;

  for (const path of paths) {
    const repositoryPath = relative(root, path).replaceAll("\\", "/");
    if (!production(repositoryPath)) continue;
    const source = await readFile(path, "utf8");
    const specifiers = path.endsWith(".ts") ? moduleSpecifiers(source) : [];

    for (const specifier of specifiers) {
      if (!specifier.includes("discovery")) continue;
      discoveryImports += 1;
      if (isolated.some((prefix) => repositoryPath.startsWith(prefix))) {
        responsibilityViolations += 1;
        violations.push(`${repositoryPath} imports Discovery across an isolated boundary`);
      }
    }

    if (repositoryPath.startsWith("packages/discovery-runtime/src/")) {
      for (const specifier of specifiers) {
        if (forbiddenRuntimeModule.test(specifier)) {
          responsibilityViolations += 1;
          violations.push(`${repositoryPath} couples Discovery Runtime to ${specifier}`);
        }
        if (specifier.startsWith("@work-fabric/federation-")) {
          responsibilityViolations += 1;
          violations.push(`${repositoryPath} couples Discovery Runtime to Federation`);
        }
      }
    }

    if (
      repositoryPath.startsWith("protocol/schemas/") &&
      /workfabric\.discovery\.v1|@work-fabric\/discovery-/i.test(source)
    ) {
      schemaViolations += 1;
      violations.push(`${repositoryPath} couples a core protocol schema to Discovery`);
    }

    if (crossExchangeSchema.has(repositoryPath) && sensitiveField.test(source)) {
      schemaViolations += 1;
      violations.push(`${repositoryPath} contains a forbidden cross-Exchange field`);
    }

    if (
      repositoryPath === "packages/sdk-typescript/src/discovery-client.ts" &&
      sdkResponsibility.test(source)
    ) {
      responsibilityViolations += 1;
      violations.push(`${repositoryPath} contains ranking, selection, or invocation responsibility`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Discovery boundary violations:\n${violations.join("\n")}`);
  }
  return {
    source_files: paths.length,
    discovery_imports: discoveryImports,
    responsibility_violations: responsibilityViolations,
    schema_violations: schemaViolations,
  };
}

const invoked = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await checkDiscoveryBoundaries())}\n`);
}
