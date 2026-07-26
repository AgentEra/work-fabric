import { createHash } from "node:crypto";

export type RuntimeCommand = "accept" | "decline" | "status" | "result";

export function runtimeCommandKey(
  runtimeId: string,
  handoffId: string,
  command: RuntimeCommand,
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runtimeId, handoffId, command, sequence]))
    .digest("hex");
  return `agent-runtime:${command}:${digest}`;
}
