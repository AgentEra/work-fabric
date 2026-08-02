import { spawn as spawnProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";

import {
  LOCAL_FEISHU_PID_FILE,
  prepareLocalFeishuEnvironment,
  writeLocalFeishuPidState,
  type LocalFeishuPidState,
} from "./local-feishu-common.js";
import { provisionLocalFeishu } from "./local-feishu-provision.js";

export interface LocalChildProcess {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null;
  readonly stdout?: Readable | null;
  readonly stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  emit(event: string, ...args: unknown[]): boolean;
}

interface SupervisorDependencies {
  readonly spawn: (
    name: "service" | "feishu-provider" | "daily-assistant",
    environment: Readonly<Record<string, string>>,
  ) => LocalChildProcess;
  readonly wait_for_service: (
    environment: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly provision: (
    environment: Readonly<Record<string, string>>,
  ) => Promise<{
    readonly feishu_endpoint_registration_version: number;
  }>;
  readonly write_pid_state: (state: LocalFeishuPidState) => Promise<void>;
  readonly remove_pid_state: () => Promise<void>;
  readonly log: (message: string) => void;
}

function commandFor(
  name: "service" | "feishu-provider" | "daily-assistant",
): string {
  switch (name) {
    case "service": return "service:start";
    case "feishu-provider": return "feishu-provider:start";
    case "daily-assistant": return "agent-runtime:start";
  }
}

function prefix(
  stream: Readable | null | undefined,
  name: string,
  log: (message: string) => void,
): void {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) log(`[${name}] ${line}`);
    }
  });
}

function productionSpawn(
  name: "service" | "feishu-provider" | "daily-assistant",
  environment: Readonly<Record<string, string>>,
): LocalChildProcess {
  const child = spawnProcess(
    "npm",
    ["run", commandFor(name)],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      // Each composed module owns descendants (npm -> tsx -> node). A
      // supervisor must terminate the whole tree if one module dies, or the
      // surviving descendants keep PID 1 and its stdio handles alive.
      detached: process.platform !== "win32",
    },
  );
  prefix(child.stdout, name, console.log);
  prefix(child.stderr, name, console.error);
  if (process.platform !== "win32" && child.pid !== undefined) {
    const leaderPid = child.pid;
    const killLeader = child.kill.bind(child);
    child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        process.kill(-leaderPid, signal);
        return true;
      } catch {
        return killLeader(signal);
      }
    };
  }
  return child;
}

async function waitForService(
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const baseUrl = "http://127.0.0.1:8787";
  const deadline = Date.now() + Number(
    environment.WORK_FABRIC_LOCAL_START_TIMEOUT_MS ?? "30000",
  );
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The bounded poll is authoritative; a process existing is not ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Work Fabric readiness timed out");
}

function waitForExit(child: LocalChildProcess, timeoutMs = 10_000): Promise<void> {
  if ("exitCode" in child && child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      finished = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

export class LocalFeishuStackSupervisor {
  private readonly children: {
    readonly name: "service" | "feishu-provider" | "daily-assistant";
    readonly process: LocalChildProcess;
  }[] = [];
  private closing: Promise<void> | null = null;
  private unexpectedFailure: Error | null = null;
  private failureWaiters: ((error: Error) => void)[] = [];

  constructor(
    private readonly dependencies: SupervisorDependencies = {
      spawn: productionSpawn,
      wait_for_service: waitForService,
      provision: provisionLocalFeishu,
      write_pid_state: writeLocalFeishuPidState,
      remove_pid_state: () => rm(LOCAL_FEISHU_PID_FILE, { force: true }),
      log: console.log,
    },
  ) {}

  async start(
    environment: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      this.launch("service", environment);
      await this.dependencies.wait_for_service(environment);
      const provisioned = await this.dependencies.provision(environment);
      this.launch("feishu-provider", {
        ...environment,
        WORK_FABRIC_FEISHU_ENDPOINT_REGISTRATION_VERSION:
          String(provisioned.feishu_endpoint_registration_version),
      });
      this.launch("daily-assistant", environment);
      await this.dependencies.write_pid_state({
        supervisor_pid: process.pid,
        started_at: new Date().toISOString(),
        children: this.children.map(({ name, process: child }) => ({
          name,
          pid: child.pid ?? -1,
        })),
      });
      this.dependencies.log(
        "Local Feishu stack started: service, Provider, daily assistant",
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  waitForFailure(): Promise<never> {
    if (this.unexpectedFailure !== null) {
      return Promise.reject(this.unexpectedFailure);
    }
    return new Promise((_, reject) => {
      this.failureWaiters.push(reject);
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const item of [...this.children].reverse()) {
        item.process.kill("SIGTERM");
        await waitForExit(item.process);
      }
      this.children.length = 0;
      await this.dependencies.remove_pid_state();
    })();
    return this.closing;
  }

  private launch(
    name: "service" | "feishu-provider" | "daily-assistant",
    environment: Readonly<Record<string, string>>,
  ): void {
    const child = this.dependencies.spawn(name, environment);
    if (child.pid === undefined) throw new Error(`${name} did not start`);
    this.children.push({ name, process: child });
    child.on("exit", (code, signal) => {
      if (this.closing !== null) return;
      const failure = new Error(
        `${name} exited unexpectedly (${code ?? signal ?? "unknown"})`,
      );
      this.unexpectedFailure = failure;
      for (const reject of this.failureWaiters.splice(0)) reject(failure);
    });
  }
}

async function executable(): Promise<void> {
  const environment = await prepareLocalFeishuEnvironment(process.env);
  const supervisor = new LocalFeishuStackSupervisor();
  await supervisor.start(environment);
  const signal = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  try {
    await Promise.race([signal, supervisor.waitForFailure()]);
  } finally {
    await supervisor.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void executable().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Local Feishu stack failed",
    );
    process.exitCode = 1;
  });
}
