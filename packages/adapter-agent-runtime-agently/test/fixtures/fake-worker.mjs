#!/usr/bin/env node
import { spawn } from "node:child_process";
// macOS's script launcher may synthesize this locale hint after spawn; it was
// not inherited from the Driver's explicit environment allowlist.
delete process.env.__CF_USER_TEXT_ENCODING;
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const { command_id: commandId } = request;
  const record = (type, extra) => ({ protocol: request.protocol, type, command_id: commandId, ...extra });
  const complete = () => emit(record("completed", { result: { summary: [{ kind: "text", text: "done" }], artifacts: [], evidence: [], extensions: {} } }));
  switch (request.task.handoff_id) {
    case "turn-capability":
      if (request.protocol !== "workfabric.agent-runtime/3") throw new Error("expected v3");
      if (request.available_capabilities?.[0]?.capability_id !== "feishu.document.create") {
        throw new Error("expected advertised capability");
      }
      if (request.capability_transcript === null) {
        emit(record("capability_request", {
          request: {
            invocation_id: "invocation-fixture-1",
            capability_id: "feishu.document.create",
            version_constraint: "1.0.0",
            input: { title: "项目需求" },
            reason: "创建团队文档",
          },
        }));
      } else {
        emit(record("final", {
          response: {
            summary: [{ kind: "text", text: "Agent handled provider facts" }],
            artifacts: [],
            evidence: [],
            extensions: {},
          },
        }));
      }
      break;
    case "success": emit(record("progress", { sequence: 1, progress: 0.2, message: "started", observed_at: "2026-01-01T00:00:00.000Z" })); emit(record("progress", { sequence: 2, progress: 1, message: "finished", observed_at: "2026-01-01T00:00:01.000Z" })); complete(); break;
    case "malformed-json": process.stdout.write("{not-json}\n"); break;
    case "wrong-protocol": emit({ protocol: "wrong", type: "failed", command_id: commandId, code: "wrong", message: "wrong", retryable: false }); break;
    case "duplicate-terminal": complete(); complete(); break;
    case "progress-after-terminal": complete(); emit(record("progress", { sequence: 1, progress: 1, message: "late", observed_at: "2026-01-01T00:00:00.000Z" })); break;
    case "non-monotonic-sequence": emit(record("progress", { sequence: 2, progress: 0.2, message: "first", observed_at: "2026-01-01T00:00:00.000Z" })); emit(record("progress", { sequence: 1, progress: 0.3, message: "second", observed_at: "2026-01-01T00:00:01.000Z" })); break;
    case "oversized-line": process.stdout.write(`${JSON.stringify(record("failed", { code: "x", message: "x".repeat(300_000), retryable: false }))}\n`); break;
    case "too-many-events": for (let sequence = 1; sequence <= 1_025; sequence += 1) emit(record("progress", { sequence, progress: null, message: "event", observed_at: "2026-01-01T00:00:00.000Z" })); break;
    case "deep-json": { let value = {}; for (let depth = 0; depth < 33; depth += 1) value = { value }; emit(record("completed", { result: { summary: [value], artifacts: [], evidence: [], extensions: {} } })); break; }
    case "silent-timeout": setInterval(() => {}, 1_000); break;
    case "non-zero-exit": complete(); process.exitCode = 9; break;
    case "print-env-keys": emit(record("completed", { result: { summary: [{ kind: "text", text: "env" }], artifacts: [], evidence: [], extensions: { "workfabric.dev/child_env_keys": Object.keys(process.env).sort() } } })); break;
    case "ignore-term":
      process.on("SIGTERM", () => {});
      emit(record("progress", { sequence: 1, progress: null, message: "ready", observed_at: "2026-01-01T00:00:00.000Z" }));
      setInterval(() => {}, 1_000);
      break;
    case "delayed-invalid":
      emit(record("progress", { sequence: 1, progress: 0.1, message: "waiting", observed_at: "2026-01-01T00:00:00.000Z" }));
      setTimeout(() => { process.stdout.write("{invalid-json}\n"); }, 1_000);
      break;
    case "spawn-descendant": {
      process.on("SIGTERM", () => {});
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      emit(record("progress", { sequence: 1, progress: null, message: `descendant:${descendant.pid}`, observed_at: "2026-01-01T00:00:00.000Z" }));
      setInterval(() => {}, 1_000);
      break;
    }
    case "parent-exits-descendant": {
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      descendant.stdout.once("data", () => {
        emit(record("progress", { sequence: 1, progress: null, message: `descendant:${descendant.pid}`, observed_at: "2026-01-01T00:00:00.000Z" }));
        setInterval(() => {}, 1_000);
      });
      break;
    }
    default: throw new Error("unknown scenario");
  }
});
