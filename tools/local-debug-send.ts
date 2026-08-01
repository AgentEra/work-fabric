import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { prepareLocalDebugEnvironment } from "./local-debug-common.js";

export interface SendDebugMessageOptions {
  readonly base_url: string;
  readonly token: string;
  readonly conversation_id: string;
  readonly message: unknown;
  readonly wait_ms?: number;
}

async function jsonRequest(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const code = typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : `HTTP ${response.status}`;
    throw new Error(`Debug Channel request failed: ${code}`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Debug Channel returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function completed(status: Record<string, unknown>): boolean {
  const handoff = status.handoff;
  if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) {
    return false;
  }
  return ["result_returned", "closed", "verified"].includes(
    String((handoff as Record<string, unknown>).lifecycle_state),
  );
}

export async function sendDebugMessage(
  options: SendDebugMessageOptions,
): Promise<Record<string, unknown>> {
  const conversation = encodeURIComponent(options.conversation_id);
  const submitted = object(await jsonRequest(
    `${options.base_url}/v1/conversations/${conversation}/messages`,
    options.token,
    { method: "POST", body: JSON.stringify(options.message) },
  ));
  const submissionId = submitted.submission_id;
  if (typeof submissionId !== "string") {
    throw new Error("Debug Channel omitted submission_id");
  }
  const waitMs = options.wait_ms ?? 0;
  if (waitMs <= 0) return submitted;
  const deadline = Date.now() + waitMs;
  let latest = submitted;
  for (;;) {
    latest = object(await jsonRequest(
      `${options.base_url}/v1/submissions/${encodeURIComponent(submissionId)}`,
      options.token,
    ));
    if (completed(latest) || Date.now() >= deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function executable(): Promise<void> {
  const file = argument("--file");
  const conversation = argument("--conversation");
  if (file === undefined || conversation === undefined) {
    throw new Error("--file and --conversation are required");
  }
  const environment = await prepareLocalDebugEnvironment(process.env);
  const message = JSON.parse(await readFile(resolve(file), "utf8")) as unknown;
  const result = await sendDebugMessage({
    base_url: environment.WORK_FABRIC_DEBUG_BASE_URL
      ?? "http://127.0.0.1:8791",
    token: environment.WORK_FABRIC_DEBUG_TOKEN!,
    conversation_id: conversation,
    message,
    wait_ms: Number(argument("--wait-ms") ?? "0"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void executable().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Debug send failed"}\n`,
    );
    process.exitCode = 1;
  });
}
