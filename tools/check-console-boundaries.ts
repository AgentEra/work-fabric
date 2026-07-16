import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, resolve } from "node:path";

export interface ConsoleBoundaryReport {
  readonly source_files: number;
  readonly asset_bytes: number;
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

export async function checkConsoleBoundaries(root = resolve("packages/console-web")): Promise<ConsoleBoundaryReport> {
  const sourceRoot = join(root, "src");
  const sourceFiles = (await files(sourceRoot)).filter((path) => /\.(?:ts|tsx)$/.test(path));
  const violations: string[] = [];
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    const imports = [...source.matchAll(/from\s+["'](@work-fabric\/[^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      if (specifier !== "@work-fabric/sdk-typescript") {
        violations.push(`${relative(root, path)} imports ${specifier}`);
      }
    }
    if (/(?:indexedDB|localStorage|sessionStorage|WebSocket)\b/.test(source)) {
      violations.push(`${relative(root, path)} creates a second browser state/channel`);
    }
    if (/\bfetch\s*\(/.test(source) && !path.endsWith("config.ts")) {
      violations.push(`${relative(root, path)} bypasses the SDK transport`);
    }
  }
  let assetBytes = 0;
  const dist = join(root, "dist");
  try {
    for (const path of await files(dist)) {
      assetBytes += (await stat(path)).size;
      if (path.endsWith(".map")) violations.push(`${relative(root, path)} is an unexpected source map`);
    }
  } catch { /* build may not exist before the build gate */ }
  if (assetBytes > 250_000) violations.push(`production assets exceed 250000 bytes (${assetBytes})`);
  if (violations.length > 0) throw new Error(`Console boundary violations:\n${violations.join("\n")}`);
  return { source_files: sourceFiles.length, asset_bytes: assetBytes };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  const report = await checkConsoleBoundaries();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
