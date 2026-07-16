import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ClusterBoundaryReport {
  readonly source_files: number;
  readonly imports: number;
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

export async function checkClusterBoundaries(root = resolve(".")): Promise<ClusterBoundaryReport> {
  const roots = [
    join(root, "packages/cluster-spi/src"),
    join(root, "packages/cluster-runtime/src"),
  ];
  const sourceFiles: string[] = [];
  for (const sourceRoot of roots) sourceFiles.push(...await files(sourceRoot));
  const violations: string[] = [];
  let imports = 0;
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    imports += specifiers.length;
    for (const specifier of specifiers) {
      if (/^(?:pg|postgres|postgresql|nats|fastify)(?:$|\/)/i.test(specifier)) {
        violations.push(`${relative(root, path)} imports deployment technology ${specifier}`);
      }
      if (specifier === "@work-fabric/service-node") {
        violations.push(`${relative(root, path)} imports the composition root`);
      }
    }
    if (/\b(?:agent runtime|workflow scheduler|candidate ranking|model inference|execute participant)\b/i.test(source)) {
      violations.push(`${relative(root, path)} contains participant-execution responsibility`);
    }
    if (/Promise\.all\s*\([\s\S]{0,300}scanReady\s*\(/m.test(source)) {
      violations.push(`${relative(root, path)} fans out catalog scans without a local bound`);
    }
    const telemetryBlocks = source.split("observeCluster(").slice(1)
      .map((value) => value.split(");", 1)[0] ?? value);
    for (const block of telemetryBlocks) {
      if (/\b(?:tenant_id|partition_id|owner|fencing_token|event_id|handoff_id|actor_id)\s*:/.test(block)) {
        violations.push(`${relative(root, path)} exposes high-cardinality telemetry labels`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Cluster boundary violations:\n${violations.join("\n")}`);
  }
  return { source_files: sourceFiles.length, imports };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await checkClusterBoundaries())}\n`);
}
