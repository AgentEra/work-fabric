import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { validateDriverManifest, type AgentRuntimeDriver, type AgentRuntimeDriverFactory, type RuntimeDriverResult, type RuntimeProgress, type RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";

import { type AgentlyRuntimeDriverConfig, validateAgentlyRuntimeDriverConfig } from "./config.js";
import { NdjsonReader } from "./ndjson-reader.js";
import { AGENTLY_WORKER_PROTOCOL, parseAgentlyWorkerRecord, type AgentlyWorkerRequestV1 } from "./protocol.js";

export const MAX_STDIN_BYTES = 1_048_576;
export const MAX_STDOUT_LINE_BYTES = 262_144;
export const MAX_STDOUT_RECORDS = 1_024;
export const MAX_STDERR_BYTES = 65_536;
/** Test/debug observation is intentionally smaller than protocol input/output bounds. */
export const MAX_OBSERVED_STDOUT_BYTES = 65_536;
export const MAX_RUNTIME_LOG_BYTES = 16_384;

export class AgentlyWorkerError extends Error {
  readonly name = "AgentlyWorkerError";
  constructor(readonly code: `agently_worker_${string}`, message: string, readonly diagnostic?: string) { super(message); }
}

/**
 * A bounded, opt-in observation of one real child-process execution. It is
 * deliberately outside Runtime YAML and the Driver SPI: production callers
 * receive no task or process bytes unless they explicitly provide this
 * constructor-only diagnostic hook.
 */
export interface AgentlyProcessDriverObservation {
  readonly task_json: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly runtime_log: string;
}

export interface AgentlyProcessDriverOptions {
  readonly observer?: (observation: AgentlyProcessDriverObservation) => void;
}

function error(code: `agently_worker_${string}`, message: string, diagnostic?: string): AgentlyWorkerError {
  return diagnostic === undefined ? new AgentlyWorkerError(code, message) : new AgentlyWorkerError(code, message, diagnostic);
}

function secretIn(value: unknown, secret: string, depth = 0): boolean {
  if (depth > 32 || typeof value === "string") return typeof value === "string" && value.includes(secret);
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value) ? value.some((item) => secretIn(item, secret, depth + 1)) : Object.values(value).some((item) => secretIn(item, secret, depth + 1));
}

function redact(stderr: Buffer, secret: string): string {
  return stderr.toString("utf8").replaceAll(secret, "[REDACTED]");
}

function requestFor(task: RuntimeTaskPackage, config: AgentlyRuntimeDriverConfig): AgentlyWorkerRequestV1 {
  return { protocol: AGENTLY_WORKER_PROTOCOL, command_id: randomUUID(), task, provider: { type: "OpenAICompatible", base_url: config.provider.base_url, model: config.provider.model } };
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

export class AgentlyProcessDriver implements AgentRuntimeDriver {
  readonly manifest = validateDriverManifest({
    driver_type: "agently", protocol_version: "1",
    capability_ids: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"],
  });

  constructor(
    private readonly config: AgentlyRuntimeDriverConfig,
    private readonly options: AgentlyProcessDriverOptions = {},
  ) {}

  async execute(task: RuntimeTaskPackage, progress: (update: RuntimeProgress) => Promise<void>, signal: AbortSignal): Promise<RuntimeDriverResult> {
    if (signal.aborted) throw error("agently_worker_cancelled", "Agently worker execution was cancelled");
    if (process.platform === "win32") throw error("agently_worker_spawn", "Agently worker process-group isolation is unavailable on this platform");
    if (secretIn(task, this.config.provider.api_key)) throw error("agently_worker_input", "Agently worker request contains a configured secret");
    const request = requestFor(task, this.config);
    let input: string;
    try { input = `${JSON.stringify(request)}\n`; } catch { throw error("agently_worker_input", "Agently worker request is not serializable"); }
    if (Buffer.byteLength(input, "utf8") > MAX_STDIN_BYTES) throw error("agently_worker_input", "Agently worker request exceeds its bound");

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.config.python.executable, ["-m", this.config.python.module], {
        cwd: dirname(this.config.workspace_root), stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true,
        env: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8", PYTHONIOENCODING: "utf-8", AGENTLY_MODEL_API_KEY: this.config.provider.api_key },
      });
    } catch { throw error("agently_worker_spawn", "Unable to start Agently worker"); }
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderrOutput = child.stderr;
    if (stdin === null || stdout === null || stderrOutput === null) {
      try { child.kill("SIGKILL"); } catch { /* process has already gone away */ }
      throw error("agently_worker_spawn", "Agently worker standard streams are unavailable");
    }

    return new Promise<RuntimeDriverResult>((resolve, reject) => {
      let settled = false;
      let accepting = true;
      let terminal: RuntimeDriverResult | undefined;
      let lastSequence = 0;
      let stderr = Buffer.alloc(0);
      let observedStdout = Buffer.alloc(0);
      let runtimeLog = "worker_started";
      const reader = new NdjsonReader(MAX_STDOUT_LINE_BYTES, MAX_STDOUT_RECORDS);
      let timeout: NodeJS.Timeout | undefined;
      let grace: NodeJS.Timeout | undefined;
      let closeObserved = false;
      let childExited = false;

      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      };
      const appendRuntimeLog = (line: string) => {
        if (runtimeLog.length >= MAX_RUNTIME_LOG_BYTES) return;
        runtimeLog += `\n${line.slice(0, MAX_RUNTIME_LOG_BYTES - runtimeLog.length - 1)}`;
      };
      const observe = () => {
        if (this.options.observer === undefined) return;
        try {
          this.options.observer({
            task_json: JSON.stringify(request.task),
            stdout: observedStdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            runtime_log: runtimeLog,
          });
        } catch { /* an optional diagnostic observer must not affect execution */ }
      };
      const settle = (outcome: { readonly result: RuntimeDriverResult } | { readonly failure: AgentlyWorkerError }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if ("result" in outcome) appendRuntimeLog("worker_completed");
        else appendRuntimeLog(`worker_failed:${outcome.failure.code}`);
        observe();
        if ("result" in outcome) resolve(outcome.result); else reject(outcome.failure);
      };
      const terminate = (failure: AgentlyWorkerError) => {
        if (!accepting) return;
        accepting = false;
        if (!signalProcessGroup(child.pid, "SIGTERM")) {
          try { child.kill("SIGKILL"); } catch { /* process has already gone away */ }
          if (childExited || closeObserved) settle({ failure }); else child.once("close", () => settle({ failure }));
          return;
        }
        grace = setTimeout(() => { grace = undefined; signalProcessGroup(child.pid, "SIGKILL"); }, this.config.cancellation_grace_seconds * 1_000);
        if (childExited || closeObserved) settle({ failure }); else child.once("close", () => settle({ failure }));
      };
      const abort = () => terminate(error("agently_worker_cancelled", "Agently worker execution was cancelled"));

      signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => terminate(error("agently_worker_timeout", "Agently worker execution timed out")), this.config.execution_timeout_seconds * 1_000);

      child.on("error", () => terminate(error("agently_worker_spawn", "Unable to start Agently worker")));
      child.on("exit", () => { childExited = true; });
      stderrOutput.on("data", (chunk: Buffer) => {
        if (stderr.length >= MAX_STDERR_BYTES) return;
        stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_STDERR_BYTES - stderr.length)]);
      });
      const stdoutDone = (async () => {
        for await (const chunk of stdout) {
          if (!accepting) return;
          if (observedStdout.length < MAX_OBSERVED_STDOUT_BYTES) {
            observedStdout = Buffer.concat([
              observedStdout,
              chunk.subarray(0, MAX_OBSERVED_STDOUT_BYTES - observedStdout.length),
            ]);
          }
          appendRuntimeLog("worker_stdout");
          for (const raw of reader.push(chunk)) {
            if (!accepting) return;
            const record = parseAgentlyWorkerRecord(raw, request.command_id);
            if (secretIn(record, this.config.provider.api_key)) throw error("agently_worker_protocol", "Agently worker attempted to return a secret");
            if (terminal !== undefined) throw error("agently_worker_protocol", "Agently worker emitted records after a terminal record");
            if (record.type === "progress") {
              if (record.sequence <= lastSequence) throw error("agently_worker_protocol", "Agently worker progress sequence is not increasing");
              lastSequence = record.sequence;
              await progress({ sequence: record.sequence, progress: record.progress, message: record.message, observed_at: record.observed_at });
            } else if (record.type === "completed") terminal = record.result;
            else throw error("agently_worker_failed", "Agently worker reported failure");
          }
        }
        reader.finish();
      })();
      void stdoutDone.catch((cause: unknown) => terminate(cause instanceof AgentlyWorkerError ? cause : error("agently_worker_protocol", "Agently worker emitted an invalid protocol record")));
      child.on("close", (exitCode, terminationSignal) => {
        closeObserved = true;
        void stdoutDone.then(() => {
          if (settled) return;
          if (!accepting) return;
          accepting = false;
          if (exitCode !== 0 || terminationSignal !== null) { settle({ failure: error("agently_worker_exit", "Agently worker exited unsuccessfully", redact(stderr, this.config.provider.api_key)) }); return; }
          if (terminal === undefined) { settle({ failure: error("agently_worker_protocol", "Agently worker did not emit exactly one completed record") }); return; }
          settle({ result: terminal });
        }, () => undefined);
      });
      stdin.on("error", () => terminate(error("agently_worker_input", "Unable to write Agently worker request")));
      stdin.end(input);
    });
  }
}

export class AgentlyRuntimeDriverFactory implements AgentRuntimeDriverFactory<AgentlyRuntimeDriverConfig> {
  readonly type = "agent-runtime.agently";
  validate(value: unknown, path: string): AgentlyRuntimeDriverConfig {
    return validateAgentlyRuntimeDriverConfig(value, path);
  }
  async create(config: AgentlyRuntimeDriverConfig): Promise<AgentRuntimeDriver> { return new AgentlyProcessDriver(config); }
}
