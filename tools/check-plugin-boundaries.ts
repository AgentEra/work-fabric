import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PluginBoundaryReport {
  readonly source_files: number;
  readonly isolated_imports: number;
  readonly sdk_imports: number;
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
  "packages/adapter-feishu-long-connection-node/",
];
const feishuSdk = /^@larksuiteoapi\/node-sdk(?:$|\/)/;
const feishuSdkAdapter = "packages/adapter-feishu-long-connection-node/";
const transportIsolatedPrefixes = [
  "packages/protocol-runtime/",
  "packages/exchange-core/",
  "packages/exchange-spi/",
  "packages/adapter-storage-",
  "packages/connector-runtime/",
  "packages/transport-http/",
  "packages/sdk-typescript/",
];

function moduleSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
}

function containsFeishuTransportConditional(source: string): boolean {
  const comparison = (value: string, flags = "i") => new RegExp(
    `(?:===|!==|==|!=)\\s*["']${value}["']|["']${value}["']\\s*(?:===|!==|==|!=)|\\bcase\\s+["']${value}["']`,
    flags,
  );
  if (comparison("long_connection").test(source) || comparison("websocket").test(source)) return true;
  const feishuContext = /\b(?:feishu(?:[_ -](?:transport|webhook))?|websocket|long[_ -]?connection)\b/i;
  for (const match of source.matchAll(comparison("webhook", "gi"))) {
    const index = match.index;
    const context = source.slice(Math.max(0, index - 160), index + match[0].length + 160);
    if (feishuContext.test(context)) return true;
  }
  return false;
}

export async function checkPluginBoundaries(root = resolve(".")): Promise<PluginBoundaryReport> {
  const sourceFiles = await files(join(root, "packages"));
  const violations: string[] = [];
  let isolatedImports = 0;
  let sdkImports = 0;
  let responsibilityViolations = 0;
  for (const path of sourceFiles) {
    const repositoryPath = relative(root, path);
    const production = !repositoryPath.includes("/test/") && !repositoryPath.endsWith(".test.ts");
    if (!production) continue;
    const source = await readFile(path, "utf8");
    const specifiers = moduleSpecifiers(source);
    for (const specifier of specifiers) {
      if (!feishuSdk.test(specifier)) continue;
      sdkImports += 1;
      if (!repositoryPath.startsWith(feishuSdkAdapter)) {
        violations.push(`${repositoryPath} imports the Feishu Node SDK outside ${feishuSdkAdapter}`);
      }
    }
    if (isolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
      for (const specifier of specifiers) {
        if (/^@work-fabric\/(?:configuration-|plugin-|channel-|adapter-configuration-yaml|plugin-channel-feishu)/.test(specifier) || specifier === "yaml") {
          isolatedImports += 1;
          violations.push(`${repositoryPath} imports configuration or plugin infrastructure across the Core boundary`);
        }
      }
    }
    if (edgePackages.some((prefix) => repositoryPath.startsWith(prefix)) && /\b(?:agent\s+brain|model\s+inference|prompt\s+execution|tool\s+invocation|target\s+(?:ranking|selection)|workflow\s+(?:planning|automation)|requirement\s+creation|executeTask|runTask|autoAccept)\b/i.test(source)) {
      responsibilityViolations += 1;
      violations.push(`${repositoryPath} contains Agent-brain, workflow or participant-execution responsibility`);
    }
    if (
      transportIsolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix)) &&
      containsFeishuTransportConditional(source)
    ) {
      violations.push(`${repositoryPath} contains Feishu-specific transport selection across an isolated boundary`);
    }
  }
  if (sdkImports !== 1) {
    violations.push(`expected exactly one production Feishu SDK import, found ${sdkImports}`);
  }
  if (violations.length > 0) throw new Error(`Plugin boundary violations:\n${violations.join("\n")}`);
  return {
    source_files: sourceFiles.length,
    isolated_imports: isolatedImports,
    sdk_imports: sdkImports,
    responsibility_violations: responsibilityViolations,
  };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) process.stdout.write(`${JSON.stringify(await checkPluginBoundaries())}\n`);
