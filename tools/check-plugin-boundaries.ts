import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PluginBoundaryReport {
  readonly source_files: number;
  readonly isolated_imports: number;
  readonly responsibility_violations: number;
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (path.endsWith(".ts")) result.push(path);
  }
  return result;
}

const isolatedPrefixes = [
  "packages/exchange-core/",
  "packages/exchange-spi/",
  "packages/protocol-runtime/",
];
const edgePackages = [
  "packages/plugin-spi/",
  "packages/plugin-runtime/",
  "packages/channel-spi/",
  "packages/plugin-channel-feishu/",
];

export async function checkPluginBoundaries(root = resolve(".")): Promise<PluginBoundaryReport> {
  const sourceFiles = await files(join(root, "packages"));
  const violations: string[] = [];
  let isolatedImports = 0;
  let responsibilityViolations = 0;
  for (const path of sourceFiles) {
    const repositoryPath = relative(root, path);
    const production = !repositoryPath.includes("/test/") && !repositoryPath.endsWith(".test.ts");
    if (!production) continue;
    const source = await readFile(path, "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
    if (isolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
      for (const specifier of specifiers) {
        if (/^@work-fabric\/(?:configuration-|plugin-|channel-|adapter-configuration-yaml|plugin-channel-feishu)/.test(specifier) || specifier === "yaml") {
          isolatedImports += 1;
          violations.push(`${repositoryPath} imports configuration or plugin infrastructure across the Core boundary`);
        }
      }
    }
    if (edgePackages.some((prefix) => repositoryPath.startsWith(prefix)) && /\b(?:model\s+inference|prompt\s+execution|tool\s+invocation|target\s+(?:ranking|selection)|workflow\s+(?:planning|automation)|requirement\s+creation|executeTask|runTask|autoAccept)\b/i.test(source)) {
      responsibilityViolations += 1;
      violations.push(`${repositoryPath} contains Agent-brain, workflow or participant-execution responsibility`);
    }
  }
  if (violations.length > 0) throw new Error(`Plugin boundary violations:\n${violations.join("\n")}`);
  return { source_files: sourceFiles.length, isolated_imports: isolatedImports, responsibility_violations: responsibilityViolations };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) process.stdout.write(`${JSON.stringify(await checkPluginBoundaries())}\n`);
