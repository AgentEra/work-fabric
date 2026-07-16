import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ClusterBoundaryReport {
  readonly source_files: number;
  readonly imports: number;
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

export async function checkClusterBoundaries(root = resolve(".")): Promise<ClusterBoundaryReport> {
  const clusterRoots = [
    join(root, "packages/cluster-spi/src"),
    join(root, "packages/cluster-runtime/src"),
  ];
  const sourceFiles = [
    ...await files(join(root, "packages")),
    ...await files(join(root, "tools")),
  ];
  const clusterFiles = new Set<string>();
  for (const sourceRoot of clusterRoots) {
    for (const path of await files(sourceRoot)) clusterFiles.add(path);
  }
  const violations: string[] = [];
  let imports = 0;
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    const repositoryPath = relative(root, path);
    const testSource = repositoryPath.endsWith(".test.ts");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    imports += specifiers.length;
    for (const specifier of specifiers) {
      const natsImport = /^(?:@nats-io\/|nats(?:$|\/))/i.test(specifier);
      const natsAllowed = repositoryPath.startsWith("packages/adapter-cluster-nats/") ||
        repositoryPath === "tools/nats-wakeup-topology.ts" ||
        repositoryPath === "tools/benchmark-nats-wakeup.ts";
      if (natsImport && !natsAllowed && !testSource) {
        violations.push(`${repositoryPath} imports NATS outside the deployment adapter`);
      }
      if (
        clusterFiles.has(path) &&
        /^(?:pg|postgres|postgresql|nats|@nats-io|fastify)(?:$|\/)/i.test(specifier)
      ) {
        violations.push(`${repositoryPath} imports deployment technology ${specifier}`);
      }
      if (specifier === "@work-fabric/service-node") {
        violations.push(`${repositoryPath} imports the composition root`);
      }
    }
    if (
      clusterFiles.has(path) &&
      /\b(?:agent runtime|workflow scheduler|candidate ranking|model inference|execute participant)\b/i.test(source)
    ) {
      violations.push(`${repositoryPath} contains participant-execution responsibility`);
    }
    if (clusterFiles.has(path) && /Promise\.all\s*\([\s\S]{0,300}scanReady\s*\(/m.test(source)) {
      violations.push(`${repositoryPath} fans out catalog scans without a local bound`);
    }
    if (
      !testSource && !repositoryPath.includes("/test/") &&
      /Promise\.all\s*\([\s\S]{0,300}\.(?:publish|pull)\s*\(/m.test(source)
    ) {
      violations.push(`${repositoryPath} batches Broker operations without a local bound`);
    }
    if (
      repositoryPath.startsWith("packages/cluster-spi/src/") &&
      /\b(?:Nats|JetStream|Broker)[A-Za-z0-9_]*\b/.test(source)
    ) {
      violations.push(`${repositoryPath} exposes Broker vocabulary in the public cluster SPI`);
    }
    if (
      repositoryPath === "packages/adapter-cluster-nats/src/wakeup-codec.ts" &&
      /\b(?:Handoff|Context|Result|Artifact|Evidence)(?:[A-Za-z0-9_]*)\b/.test(source)
    ) {
      violations.push(`${repositoryPath} imports or encodes participant domain content`);
    }
    const telemetryBlocks = source.split("observeCluster(").slice(1)
      .map((value) => value.split(");", 1)[0] ?? value);
    for (const block of telemetryBlocks) {
      if (/\b(?:tenant_id|partition_id|owner|fencing_token|event_id|handoff_id|actor_id)\s*:/.test(block)) {
        violations.push(`${repositoryPath} exposes high-cardinality telemetry labels`);
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
