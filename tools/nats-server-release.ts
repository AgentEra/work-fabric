import { spawn, type ChildProcess } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NATS_SERVER_VERSION = "2.12.1";
const releaseBase = `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}`;

export interface NatsServerAsset {
  readonly filename: string;
  readonly archive: "zip" | "tar.gz";
  readonly root_directory: string;
}

export function natsServerAsset(
  platform: NodeJS.Platform,
  architecture: string,
): NatsServerAsset {
  let target: string;
  let archive: NatsServerAsset["archive"];
  if (platform === "darwin" && architecture === "arm64") {
    target = "darwin-arm64";
    archive = "tar.gz";
  } else if (platform === "linux" && architecture === "x64") {
    target = "linux-amd64";
    archive = "tar.gz";
  } else if (platform === "linux" && architecture === "arm64") {
    target = "linux-arm64";
    archive = "tar.gz";
  } else {
    throw new Error("unsupported NATS Server release platform");
  }
  const root = `nats-server-v${NATS_SERVER_VERSION}-${target}`;
  return {
    filename: `${root}.tar.gz`,
    archive,
    root_directory: root,
  };
}

export function verifyReleaseChecksum(
  archive: Uint8Array,
  sums: string,
  filename: string,
): void {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^([a-fA-F0-9]{64})[ \\t]+\\*?${escaped}$`, "m")
    .exec(sums);
  if (match?.[1] === undefined) throw new Error("release checksum entry missing");
  const expected = Buffer.from(match[1].toLowerCase(), "hex");
  const actual = createHash("sha256").update(archive).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("release checksum mismatch");
  }
}

export interface RunningNatsServer {
  readonly url: string;
  stop(): Promise<void>;
}

export interface NatsServerReleaseDependencies {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  makeTempDirectory(): Promise<string>;
  download(url: string): Promise<Uint8Array>;
  writeArchive(
    temporaryDirectory: string,
    asset: NatsServerAsset,
    bytes: Uint8Array,
  ): Promise<void>;
  extract(temporaryDirectory: string, asset: NatsServerAsset): Promise<void>;
  startServer(
    temporaryDirectory: string,
    asset: NatsServerAsset,
  ): Promise<RunningNatsServer>;
  runCommand(
    command: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<number>;
  removeTempDirectory(path: string): Promise<void>;
}

async function download(url: string): Promise<Uint8Array> {
  const child = spawn("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--max-time",
    "180",
    url,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > 64 * 1_024 * 1_024) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  const code = await childExit(child);
  if (code !== 0 || size > 64 * 1_024 * 1_024) {
    throw new Error("official NATS Server download failed");
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error("process terminated by signal"));
      else resolve(code ?? 1);
    });
  });
}

async function spawnChecked(command: string, args: readonly string[]): Promise<void> {
  const code = await childExit(spawn(command, [...args], { stdio: "ignore" }));
  if (code !== 0) throw new Error("release archive extraction failed");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("ephemeral port allocation failed");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function ready(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("NATS Server failed during startup");
    try {
      const response = await fetch(`${url}/healthz?js-enabled-only=true`);
      if (response.ok) return;
    } catch { /* bounded readiness retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("NATS Server readiness timeout");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = childExit(child).catch(() => 0);
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 5_000);
  });
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL");
    await childExit(child).catch(() => 0);
  }
}

const defaultDependencies: NatsServerReleaseDependencies = {
  platform: process.platform,
  architecture: process.arch,
  makeTempDirectory: () => mkdtemp(join(tmpdir(), "work-fabric-nats-")),
  download,
  writeArchive: async (directory, asset, bytes) => {
    await writeFile(join(directory, asset.filename), bytes);
  },
  extract: async (directory, asset) => {
    const archive = join(directory, asset.filename);
    if (asset.archive === "zip") {
      await spawnChecked("unzip", ["-q", archive, "-d", directory]);
    } else {
      await spawnChecked("tar", ["-xzf", archive, "-C", directory]);
    }
  },
  startServer: async (directory, asset) => {
    const binary = join(directory, asset.root_directory, "nats-server");
    await chmod(binary, 0o755);
    const store = join(directory, "store");
    await mkdir(store, { recursive: true });
    const clientPort = await availablePort();
    const monitoringPort = await availablePort();
    const child = spawn(binary, [
      "-js",
      "-a", "127.0.0.1",
      "-p", String(clientPort),
      "-m", String(monitoringPort),
      "-sd", store,
    ], { stdio: "ignore" });
    try {
      await ready(`http://127.0.0.1:${monitoringPort}`, child);
    } catch (error) {
      await stopChild(child);
      throw error;
    }
    return {
      url: `nats://127.0.0.1:${clientPort}`,
      stop: () => stopChild(child),
    };
  },
  runCommand: async (command, environment) => {
    const executable = command[0];
    if (executable === undefined) throw new Error("release command is required");
    return await childExit(spawn(executable, command.slice(1), {
      stdio: "inherit",
      env: environment,
    }));
  },
  removeTempDirectory: (path) => rm(path, { recursive: true, force: true }),
};

export async function runOfficialNatsServerCommand(
  command: readonly string[],
  dependencies: NatsServerReleaseDependencies = defaultDependencies,
): Promise<number> {
  if (command.length === 0) throw new Error("release command is required");
  const asset = natsServerAsset(dependencies.platform, dependencies.architecture);
  const temporaryDirectory = await dependencies.makeTempDirectory();
  let server: RunningNatsServer | undefined;
  try {
    const sumsBytes = await dependencies.download(`${releaseBase}/SHA256SUMS`);
    const archive = await dependencies.download(`${releaseBase}/${asset.filename}`);
    const sums = new TextDecoder("utf-8", { fatal: true }).decode(sumsBytes);
    verifyReleaseChecksum(archive, sums, asset.filename);
    await dependencies.writeArchive(temporaryDirectory, asset, archive);
    await dependencies.extract(temporaryDirectory, asset);
    server = await dependencies.startServer(temporaryDirectory, asset);
    return await dependencies.runCommand(command, {
      ...process.env,
      NATS_TEST_URL: server.url,
    });
  } finally {
    await server?.stop().catch(() => undefined);
    await dependencies.removeTempDirectory(temporaryDirectory);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv.slice(2);
  const separator = input.indexOf("--");
  const command = separator >= 0 ? input.slice(separator + 1) : input;
  runOfficialNatsServerCommand(command).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "NATS release failed"}\n`);
    process.exitCode = 1;
  });
}
