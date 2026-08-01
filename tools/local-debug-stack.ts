import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";

import {
  LOCAL_DEBUG_STATE_FILE,
  prepareLocalDebugEnvironment,
  readLocalDebugState,
  writeLocalDebugState,
} from "./local-debug-common.js";

type Component = "service" | "daily-assistant";

function command(component: Component): string {
  return component === "service" ? "service:start" : "agent-runtime:start";
}

function prefix(stream: Readable | null, component: string): void {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/u)) {
      if (line.length > 0) process.stdout.write(`[${component}] ${line}\n`);
    }
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // Readiness is established only by the bounded health probe.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Readiness timed out: ${url}`);
}

async function runProvision(
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const child = spawn("npm", ["run", "agent-runtime:provision"], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Daily Assistant provisioning failed");
}

async function stopExternal(): Promise<void> {
  const state = await readLocalDebugState();
  if (state === null) throw new Error("not_running");
  for (const child of [...state.children].reverse()) {
    if (alive(child.pid)) process.kill(child.pid, "SIGTERM");
  }
  if (state.supervisor_pid !== process.pid && alive(state.supervisor_pid)) {
    process.kill(state.supervisor_pid, "SIGTERM");
  }
  await rm(LOCAL_DEBUG_STATE_FILE, { force: true });
}

async function start(): Promise<void> {
  const environment = await prepareLocalDebugEnvironment(process.env);
  const children: Array<{
    readonly name: Component;
    readonly child: ReturnType<typeof spawn>;
  }> = [];
  const launch = (name: Component) => {
    const child = spawn("npm", ["run", command(name)], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefix(child.stdout, name);
    prefix(child.stderr, name);
    children.push({ name, child });
    return child;
  };
  const close = async () => {
    for (const item of [...children].reverse()) {
      if (item.child.pid !== undefined && alive(item.child.pid)) {
        item.child.kill("SIGTERM");
      }
    }
    await rm(LOCAL_DEBUG_STATE_FILE, { force: true });
  };
  try {
    launch("service");
    const timeout = Number(environment.WORK_FABRIC_LOCAL_START_TIMEOUT_MS ?? "30000");
    await Promise.all([
      waitFor("http://127.0.0.1:8787/health/ready", timeout),
      waitFor(
        environment.WORK_FABRIC_DEBUG_HEALTH_URL
          ?? "http://127.0.0.1:8791/health",
        timeout,
      ),
    ]);
    await runProvision(environment);
    launch("daily-assistant");
    await writeLocalDebugState({
      supervisor_pid: process.pid,
      started_at: new Date().toISOString(),
      children: children.map((item) => ({
        name: item.name,
        pid: item.child.pid ?? -1,
      })),
    });
    process.stdout.write(
      "Local Debug Channel stack started: service, daily assistant\n",
    );
    await new Promise<void>((resolve, reject) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      for (const item of children) {
        item.child.once("exit", (code, signal) => {
          reject(new Error(
            `${item.name} exited unexpectedly (${code ?? signal ?? "unknown"})`,
          ));
        });
      }
    });
  } finally {
    await close();
  }
}

async function executable(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    process.stdout.write("service\ndaily-assistant\n");
    return;
  }
  if (process.argv.includes("--stop")) {
    await stopExternal();
    return;
  }
  await start();
}

if (
  process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void executable().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Local Debug stack failed"}\n`,
    );
    process.exitCode = 1;
  });
}
